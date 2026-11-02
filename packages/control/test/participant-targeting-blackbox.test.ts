import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as forward } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationClient, ConversationService, createConversationHttpServer } from "@minu/channels-core";
import type { ConversationMessage, CreateMessageInput } from "@minu/channels-core/types";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { createLocalControlDaemon, type LocalControlDaemon, type LocalControlDaemonOptions } from "../src/daemon.ts";

// Contract: human messages 159/166/171. No selection helpers or host internals
// are imported. Real HTTP, authorization, SQLite and Relay; controlled external
// Runtime and transparent public-HTTP latency injection only.
type Agent = "alpha" | "beta" | "gamma";
type Scope = "main" | "thread";
type RuntimePort = NonNullable<LocalControlDaemonOptions["runtimes"]>[string];
type StartConfig = Parameters<NonNullable<RuntimePort["startManaged"]>>[0];
const agents: Agent[] = ["alpha", "beta", "gamma"];
const marker = (agent: Agent) => `BLACKBOX_AGENT_${agent.toUpperCase()}`;

class RecordingRuntime implements RuntimePort {
  readonly starts: Array<{ id: string; agent: Agent; config: StartConfig }> = [];
  readonly attempts: Agent[] = [];
  readonly resumes: string[] = [];
  readonly calls: Array<{ sessionId: string; agent: Agent; input: string; reply: string }> = [];
  readonly failures: Partial<Record<Agent, number>> = {};
  readonly output: Partial<Record<Agent, string>> = {};
  private readonly sessions = new Map<string, { ownerId: string; agent: Agent; messages: Array<{ role: "user" | "assistant"; content: string }> }>();
  async start(): Promise<never> { throw new Error("Managed sessions required"); }
  async startManaged(config: StartConfig, ownerId: string) {
    const agent = agents.find((name) => config.appendSystemPrompt?.includes(marker(name)));
    assert.ok(agent, "The real launch configuration must identify its configured agent persona");
    this.attempts.push(agent);
    if (this.failures[agent]) { this.failures[agent]! -= 1; throw new Error("Controlled model startup failure"); }
    const id = `TARGETING_SESSION_${this.starts.length + 1}`;
    this.starts.push({ id, agent, config: structuredClone(config) });
    this.sessions.set(id, { ownerId, agent, messages: [] });
    return { id, ownerId };
  }
  async listManagedSessions(ownerId: string) {
    return [...this.sessions].filter(([, value]) => value.ownerId === ownerId).map(([id]) => ({ id, ownerId, state: "active" as const }));
  }
  async status(id: string): Promise<"idle" | "offline"> { return this.sessions.has(id) ? "idle" : "offline"; }
  async resume(id: string, ownerId: string) { assert.equal(this.sessions.get(id)?.ownerId, ownerId); this.resumes.push(id); return { id, ownerId }; }
  async send(sessionId: string, input: string) {
    const session = this.sessions.get(sessionId); assert.ok(session);
    assert.ok(this.calls.length < 20, "Unexpected agent-to-agent response loop");
    const reply = `${this.output[session.agent] ?? "Controlled answer"}\nTARGETING_REPLY_${this.calls.length + 1}`;
    this.calls.push({ sessionId, agent: session.agent, input, reply });
    session.messages.push({ role: "user", content: input }, { role: "assistant", content: reply });
  }
  async messages(id: string) { return structuredClone(this.sessions.get(id)?.messages ?? []); }
  async interrupt() {}
}

// Forward every byte to the real public service. A gate changes timing, never
// message data, selection, authentication, startup receipts or response bodies.
async function publicProxy(endpoint: string) {
  let gate: { scopeId: string; entered: boolean; wait: Promise<void>; release(): void } | undefined;
  const server = createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", endpoint);
      const held = gate;
      if (held && !held.entered && incoming.method === "GET" && url.pathname === `/conversations/${held.scopeId}/messages`
        && !url.searchParams.has("limit") && !url.searchParams.has("after")) {
        held.entered = true;
        await held.wait;
      }
      if (response.destroyed) return;
      const upstream = forward(url, { method: incoming.method, headers: { ...incoming.headers, host: url.host } }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
      });
      upstream.on("error", () => { if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end(); } });
      response.on("close", () => upstream.destroy());
      if (incoming.readableEnded) upstream.end(); else incoming.pipe(upstream);
    })().catch(() => { if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    delayHistory(scopeId: string) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      gate = { scopeId, entered: false, wait, release };
      return gate;
    },
    release() { gate?.release(); },
    async close() { gate?.release(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function eventually(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(message);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "participant-targeting-blackbox-"));
  const runtime = new RecordingRuntime();
  let storage: DrizzleLibSqlConversationStorage | undefined;
  let core: Awaited<ReturnType<typeof createConversationHttpServer>> | undefined;
  let proxy: Awaited<ReturnType<typeof publicProxy>> | undefined;
  let daemon: LocalControlDaemon | undefined;
  t.after(async () => {
    proxy?.release();
    try { await daemon?.close(); }
    finally { try { await proxy?.close(); } finally { try { await core?.close(); }
      finally { try { await storage?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } } }
  });
  const root = join(directory, "workspace"); await mkdir(root);
  storage = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "public.db")}` });
  core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
  proxy = await publicProxy(core.endpoint);
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Blackbox Owner" });
  const peer = await client.createIdentity({ type: "human", displayName: "Blackbox Peer" });
  const alpha = await client.createIdentity({ type: "agent", displayName: "Alpha Agent" });
  const beta = await client.createIdentity({ type: "agent", displayName: "Beta Agent" });
  const gamma = await client.createIdentity({ type: "agent", displayName: "Gamma Agent" });
  const identities = { owner, peer, alpha, beta, gamma };
  const workspace = await client.createWorkspace({ slug: "targeting-blackbox", name: "Targeting blackbox" });
  for (const name of ["owner", "peer", ...agents] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identities[name].id, mentionHandle: name,
      ...(["owner", "peer"].includes(name) ? { accessRole: "owner" as const } : {}) });
  }
  const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: Object.values(identities).map(({ id }) => id) });
  await client.postMessage(parent.id, { participantId: peer.id, body: "PUBLIC_BACKGROUND" });
  const rootMessage = await client.postMessage(parent.id, { participantId: alpha.id, body: "AGENT_AUTHORED_ROOT" });
  const thread = await client.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: rootMessage.id });
  const scopes = { main: parent, thread };
  const origin = "http://127.0.0.1:5174";
  daemon = await createLocalControlDaemon({ currentHumanIdentityId: owner.id, conversationsEndpoint: proxy.endpoint,
    conversationsServiceToken: core.serviceToken, relayDatabasePath: join(directory, "relay.db"), port: 0, webUrl: `${origin}/`,
    runtimes: { "blackbox-controlled": runtime }, stopStartedSessionsOnClose: false, recordAgentDiagnostics: false,
    withConversationMessageAdmission: core.service.withConversationMessageAdmission.bind(core.service) });
  const exchange = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" }); assert.equal(exchange.status, 303);
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!; await exchange.arrayBuffer();
  function request(path: string, method = "GET", body?: unknown, key?: string) {
    return fetch(`${daemon!.endpoint}/local${path}`, { method,
      headers: { cookie, origin, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  }
  async function control<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await request(path, method, body); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
    return await response.json() as T;
  }
  await control(`/workspaces/${workspace.id}/config`, "PATCH", { rootUri: await realpath(root) });
  for (const name of agents) await control(`/workspaces/${workspace.id}/agents/${identities[name].id}/config`, "PATCH",
    { runtimeAdapter: "blackbox-controlled", personaPrompt: marker(name) });
  return {
    client, identities, workspace, parent, thread, scopes, runtime, proxy,
    raw(scope: Scope, input: CreateMessageInput, key: string) { return request(`/conversations/${scopes[scope].id}/messages`, "POST", input, key); },
    async send(scope: Scope, body: string, to: string[], key = createHash("sha256").update(body).digest("hex")) {
      return accepted(await request(`/conversations/${scopes[scope].id}/messages`, "POST", { participantId: owner.id, body, to }, key));
    },
    action(scope: Scope, name: Agent, action: "start" | "stop") { return control(`/conversations/${scopes[scope].id}/agents/${identities[name].id}/${action}`, "POST"); },
    configure(name: Agent, input: unknown) { return control(`/workspaces/${workspace.id}/agents/${identities[name].id}/config`, "PATCH", input); },
    async answer(scope: Scope, question: ConversationMessage, name: Agent) {
      await eventually(async () => (await client.listMessages(scopes[scope].id)).some((message) => message.replyTo === question.id && message.participantId === identities[name].id),
        `${name} must receive and answer ${question.body}`);
      const reply = (await client.listMessages(scopes[scope].id)).find((message) => message.replyTo === question.id && message.participantId === identities[name].id)!;
      const call = runtime.calls.find((value) => value.reply === reply.body); assert.ok(call);
      assert.ok(call.input.includes(question.body), "The original question must reach the actual Runtime boundary");
      return reply;
    },
  };
}
async function accepted(response: Response): Promise<ConversationMessage> {
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as { message: ConversationMessage }).message;
}

for (const scope of ["main", "thread"] as const) {
  test(`targeting blackbox: ${scope} starts a newly selected agent on a later Send and reuses existing sessions`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t); assert.equal(f.runtime.starts.length, 0);
    await f.client.getConversation(f.scopes[scope].id); await f.client.listMessages(f.scopes[scope].id);
    assert.equal(f.runtime.starts.length, 0, "Creation and reads must not launch anyone");
    const first = await f.send(scope, "FIRST_ALPHA_QUESTION", [f.identities.alpha.id]); await f.answer(scope, first, "alpha");
    const later = await f.send(scope, "LATER_BETA_QUESTION", [f.identities.beta.id]); await f.answer(scope, later, "beta");
    assert.deepEqual(later.to, [f.identities.beta.id]);
    assert.equal((await f.send(scope, later.body, later.to)).id, later.id);
    assert.equal(f.runtime.starts.filter(({ agent }) => agent === "alpha").length, 1);
    assert.equal(f.runtime.starts.filter(({ agent }) => agent === "beta").length, 1);
    assert.equal(f.runtime.starts.filter(({ agent }) => agent === "gamma").length, 0);
    assert.equal(f.runtime.calls.length, 2);
    if (scope === "thread") assert.equal((await f.client.listMessages(f.parent.id)).some(({ body }) => body.includes("TARGETING_REPLY_")), false);
  });
  test(`targeting blackbox: ${scope} explicit no-recipient does not guess or launch the roster`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t); const message = await f.send(scope, "NO_CLEAR_RECIPIENT", []);
    assert.deepEqual(message.to, []); assert.equal(f.runtime.starts.length, 0); assert.equal(f.runtime.calls.length, 0);
  });
  test(`targeting blackbox: ${scope} manual Start and addressed Send cannot skip the trigger`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t); const held = f.proxy.delayHistory(f.scopes[scope].id);
    let manualFinished = false;
    const manual = f.action(scope, "alpha", "start").finally(() => { manualFinished = true; }); void manual.catch(() => undefined);
    let send: Promise<ConversationMessage> | undefined;
    try {
      await eventually(() => held.entered || manualFinished, "Manual Start must begin");
      send = f.send(scope, "QUESTION_DURING_MANUAL_START", [f.identities.alpha.id]); void send.catch(() => undefined);
      // Permit either safe serialization or a commit during the network delay.
      const deadline = Date.now() + 250;
      while (Date.now() < deadline) {
        if ((await f.client.listMessages(f.scopes[scope].id)).some(({ body }) => body === "QUESTION_DURING_MANUAL_START")) break;
        await delay(10);
      }
      held.release(); await manual;
      const question = await send;
      assert.equal((await f.send(scope, question.body, question.to)).id, question.id);
      const fresh = await f.send(scope, "FRESH_AFTER_OVERLAP", [f.identities.alpha.id]); await f.answer(scope, fresh, "alpha");
      const replies = (await f.client.listMessages(f.scopes[scope].id)).filter(({ replyTo }) => replyTo === question.id);
      assert.equal(replies.length, 1, "The first question needs its own answer, not only a later question's response");
      assert.equal(f.runtime.starts.length, 1); assert.equal(f.runtime.calls.length, 2);
    } finally { held.release(); await Promise.allSettled([manual, ...(send ? [send] : [])]); }
  });
  test(`targeting blackbox: ${scope} parent archive blocks writes and activation, then explicit reopen permits Send`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t); const id = f.scopes[scope].id; const before = await f.client.listMessages(id);
    await f.client.updateConversationLifecycle(f.parent.id, { actorIdentityId: f.identities.owner.id, state: "settled" });
    const input = { participantId: f.identities.owner.id, body: "ARCHIVE_BLOCKED_QUESTION", to: [f.identities.beta.id] };
    const denied = await f.raw(scope, input, "archive-key"); assert.ok(denied.status >= 400 && denied.status < 500); await denied.arrayBuffer();
    assert.deepEqual(await f.client.listMessages(id), before); assert.equal(f.runtime.starts.length, 0);
    await f.client.updateConversationLifecycle(f.parent.id, { actorIdentityId: f.identities.owner.id, state: "active" });
    await f.answer(scope, await accepted(await f.raw(scope, input, "archive-key")), "beta");
  });
}

test("targeting blackbox: partial multi-recipient startup failure retries only missing work without duplicate sessions/questions/answers", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); f.runtime.failures.beta = 1;
  const input = { participantId: f.identities.owner.id, body: "MULTI_RECIPIENT_RETRY_QUESTION", to: [f.identities.alpha.id, f.identities.beta.id] };
  const first = await f.raw("thread", input, "multi-key"); await first.arrayBuffer();
  const saved = (await f.client.listMessages(f.thread.id)).filter(({ participantId }) => participantId === f.identities.owner.id);
  assert.equal(saved.length, 1); assert.deepEqual([...saved[0]!.to].sort(), [...input.to].sort());
  const retry = await accepted(await f.raw("thread", input, "multi-key")); assert.equal(retry.id, saved[0]!.id);
  await f.answer("thread", retry, "alpha"); await f.answer("thread", retry, "beta");
  assert.equal((await accepted(await f.raw("thread", input, "multi-key"))).id, retry.id);
  assert.deepEqual(f.runtime.starts.map(({ agent }) => agent).sort(), ["alpha", "beta"]);
  assert.equal(f.runtime.calls.filter(({ agent }) => agent === "alpha").length, 1);
  assert.equal(f.runtime.calls.filter(({ agent }) => agent === "beta").length, 1);
  assert.equal((await f.client.listMessages(f.thread.id)).filter(({ participantId }) => participantId === f.identities.owner.id).length, 1);
  assert.equal((await f.client.listMessages(f.thread.id)).filter(({ replyTo }) => replyTo === retry.id).length, 2);
});

test("targeting blackbox: broadcasts reach running agents but do not launch idle or resume stopped agents", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); await f.answer("main", await f.send("main", "START_ALPHA", [f.identities.alpha.id]), "alpha");
  await f.answer("main", await f.send("main", "BROADCAST_TO_RUNNING_ONLY", ["@conversation"]), "alpha");
  assert.deepEqual(f.runtime.starts.map(({ agent }) => agent), ["alpha"]);
  await f.action("main", "alpha", "stop");
  await f.send("main", "BROADCAST_AFTER_STOP", ["@conversation"]);
  assert.equal(f.runtime.calls.length, 2); assert.equal(f.runtime.resumes.length, 0); assert.equal(f.runtime.starts.length, 1);
});

test("targeting blackbox: code/quoted mention-looking text cannot widen an explicitly selected recipient", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const body = "Examples only:\n```ts\n@beta @unknown_agent\n```\n`@gamma`\n> @beta quoted\n\nQUESTION_FOR_ALPHA";
  const question = await f.send("main", body, [f.identities.alpha.id]);
  assert.deepEqual(question.to, [f.identities.alpha.id]); await f.answer("main", question, "alpha");
  assert.deepEqual(f.runtime.starts.map(({ agent }) => agent), ["alpha"]);
});

test("targeting blackbox: agent-generated mentions neither redirect replies nor trigger other agents", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); await f.answer("main", await f.send("main", "CALIBRATE_BETA", [f.identities.beta.id]), "beta");
  f.runtime.output.alpha = "Generated prose mentioning @beta and @gamma is not a human recipient choice";
  const generated = await f.answer("main", await f.send("main", "ASK_ALPHA", [f.identities.alpha.id]), "alpha");
  assert.equal(generated.to.includes(f.identities.beta.id) || generated.to.includes(f.identities.gamma.id), false);
  await f.answer("main", await f.send("main", "DRAIN_BETA_AFTER_GENERATED_PROSE", [f.identities.beta.id]), "beta");
  assert.equal(f.runtime.calls.filter(({ agent }) => agent === "beta").length, 2, "Only the two human-addressed Beta questions may execute");
  assert.equal(f.runtime.starts.filter(({ agent }) => agent === "gamma").length, 0);
});

test("targeting blackbox: a member can post without gaining startup permission, and explicit Stop remains authoritative", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await f.client.updateWorkspaceMember(f.workspace.id, f.identities.owner.id, { actorIdentityId: f.identities.owner.id, accessRole: "member" });
  const member = await f.send("main", "ORDINARY_MEMBER_QUESTION", [f.identities.alpha.id]);
  assert.deepEqual(member.to, [f.identities.alpha.id]); assert.equal(f.runtime.starts.length, 0);
  await f.client.updateWorkspaceMember(f.workspace.id, f.identities.owner.id, { actorIdentityId: f.identities.peer.id, accessRole: "owner" });
  await f.answer("main", await f.send("main", "AUTHORIZED_ALPHA_START", [f.identities.alpha.id]), "alpha");
  await f.action("main", "alpha", "stop");
  // Authorized startup may also drain the earlier durable member question.
  // Stop must prevent additional processing, regardless of that valid backlog.
  const callsAtStop = f.runtime.calls.length;
  await f.send("main", "QUESTION_AFTER_EXPLICIT_STOP", [f.identities.alpha.id]);
  assert.equal(f.runtime.starts.length, 1); assert.equal(f.runtime.calls.length, callsAtStop); assert.equal(f.runtime.resumes.length, 0);
});

test("targeting blackbox: retirement prevents exact replay of a saved activation trigger", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); const input = { participantId: f.identities.owner.id, body: "RETIRED_MAIN_TRIGGER", to: [f.identities.alpha.id] };
  const old = await f.client.postMessage(f.parent.id, input, { idempotencyKey: "retired-key" });
  await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.identities.owner.id,
    expectedRosterRevision: f.parent.rosterRevision, participantIds: Object.values(f.identities).filter(({ id }) => id !== f.identities.alpha.id).map(({ id }) => id) });
  await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.identities.owner.id,
    expectedRosterRevision: (await f.client.getConversation(f.parent.id)).rosterRevision, participantIds: Object.values(f.identities).map(({ id }) => id) });
  assert.ok(await f.client.getCursor(f.parent.id, f.identities.alpha.id) >= old.sequence);
  assert.equal((await accepted(await f.raw("main", input, "retired-key"))).id, old.id);
  await f.answer("main", await f.send("main", "ELIGIBLE_BETA_AFTER_RETIREMENT", [f.identities.beta.id]), "beta");
  assert.equal(f.runtime.starts.filter(({ agent }) => agent === "alpha").length, 0);
  assert.equal((await f.client.listMessages(f.parent.id)).filter(({ replyTo }) => replyTo === old.id).length, 0);
});

test("targeting blackbox: an unavailable configured agent is not activated or replaced by another recipient", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); await f.configure("beta", { status: "disabled" });
  const response = await f.raw("main", { participantId: f.identities.owner.id, body: "UNAVAILABLE_BETA_ONLY", to: [f.identities.beta.id] }, "unavailable-beta");
  await response.arrayBuffer();
  await f.answer("main", await f.send("main", "ELIGIBLE_GAMMA_CALIBRATION", [f.identities.gamma.id]), "gamma");
  assert.deepEqual(f.runtime.starts.map(({ agent }) => agent), ["gamma"]);
  assert.equal(f.runtime.calls.some(({ input }) => input.includes("UNAVAILABLE_BETA_ONLY") && !input.includes("ELIGIBLE_GAMMA_CALIBRATION")), false);
});
