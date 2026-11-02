import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationClient, ConversationService, createConversationHttpServer } from "@minu/channels-core";
import type { ConversationMessage, CreateMessageInput } from "@minu/channels-core/types";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { createLocalControlDaemon, type LocalControlDaemon, type LocalControlDaemonOptions } from "../src/daemon.ts";
import type { LocalConversationAgent } from "../src/contracts.ts";

// Independent first-Send contract cases, moved from the browser acceptance file.
// Real authenticated HTTP, public/private SQLite and Relay; only the model is controlled.
// UI selection, ordinary-member posting and no-start safeguards remain in that file.
type Agent = "alpha" | "beta";
type RuntimePort = NonNullable<LocalControlDaemonOptions["runtimes"]>[string];
type StartConfig = Parameters<NonNullable<RuntimePort["startManaged"]>>[0];

class ObservedRuntime implements RuntimePort {
  readonly starts: Array<{ id: string; config: StartConfig }> = [];
  readonly resumes: string[] = [];
  readonly calls: Array<{ sessionId: string; input: string; reply: string }> = [];
  startAttempts = 0;
  startFailures = 0;
  private nextStart?: { wait: Promise<void>; release(): void };
  private readonly sessions = new Map<string, {
    ownerId: string; messages: Array<{ role: "user" | "assistant"; content: string }>;
  }>();

  async start(): Promise<never> { throw new Error("The fixture requires owner-scoped managed sessions"); }
  async startManaged(config: StartConfig, ownerId: string) {
    this.startAttempts += 1;
    if (this.startFailures > 0) { this.startFailures -= 1; throw new Error("Controlled startup failure"); }
    const held = this.nextStart;
    if (held) { await held.wait; if (this.nextStart === held) this.nextStart = undefined; }
    const id = `PRIVATE_ACCEPTANCE_SESSION_${this.starts.length + 1}`;
    this.starts.push({ id, config: structuredClone(config) });
    this.sessions.set(id, { ownerId, messages: [] });
    return { id, ownerId };
  }
  async listManagedSessions(ownerId: string) {
    return [...this.sessions].filter(([, session]) => session.ownerId === ownerId)
      .map(([id]) => ({ id, ownerId, state: "active" as const }));
  }
  async resume(id: string, ownerId: string) {
    assert.equal(this.sessions.get(id)?.ownerId, ownerId);
    this.resumes.push(id);
    return { id, ownerId };
  }
  async status(id: string): Promise<"idle" | "offline"> { return this.sessions.has(id) ? "idle" : "offline"; }
  async send(sessionId: string, input: string) {
    const session = this.sessions.get(sessionId);
    assert.ok(session, "Send requires a launched session");
    const call = { sessionId, input, reply: `ACCEPTANCE_REPLY_${this.calls.length + 1}` };
    this.calls.push(call);
    session.messages.push({ role: "user", content: input }, { role: "assistant", content: call.reply });
  }
  async messages(id: string) { return structuredClone(this.sessions.get(id)?.messages ?? []); }
  async interrupt() {}
  holdNextStart() {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.nextStart = { wait, release };
    return { release };
  }
  release() { this.nextStart?.release(); }
}

async function eventually(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(description);
}

async function fixture(t: TestContext, author: Agent | "owner" = "alpha", rootBody = "HTTP_ACCEPTANCE_ROOT") {
  const directory = await mkdtemp(join(tmpdir(), "thread-auto-start-acceptance-"));
  const runtime = new ObservedRuntime();
  let storage: DrizzleLibSqlConversationStorage | undefined;
  let core: Awaited<ReturnType<typeof createConversationHttpServer>> | undefined;
  let daemon: LocalControlDaemon | undefined;
  t.after(async () => {
    runtime.release();
    try { await daemon?.close(); }
    finally {
      try { await core?.close(); }
      finally { try { await storage?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    }
  });
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  storage = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "public.db")}` });
  core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Acceptance Owner" });
  const alpha = await client.createIdentity({ type: "agent", displayName: "Alpha Agent" });
  const beta = await client.createIdentity({ type: "agent", displayName: "Beta Agent" });
  const identities = { owner, alpha, beta };
  const workspace = await client.createWorkspace({ slug: "auto-start-acceptance", name: "Auto-start acceptance" });
  for (const name of ["owner", "alpha", "beta"] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identities[name].id,
      mentionHandle: name, ...(name === "owner" ? { accessRole: "owner" as const } : {}) });
  }
  const parent = await client.createConversation({ workspaceId: workspace.id,
    participantIds: [owner.id, alpha.id, beta.id] });
  const root = await client.postMessage(parent.id, { participantId: identities[author].id, body: rootBody });
  const thread = await client.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: root.id });
  const origin = "http://127.0.0.1:5174";
  daemon = await createLocalControlDaemon({
    currentHumanIdentityId: owner.id, conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken,
    relayDatabasePath: join(directory, "relay.db"), port: 0, webUrl: `${origin}/`,
    runtimes: { "acceptance-controlled": runtime }, recordAgentDiagnostics: false, stopStartedSessionsOnClose: false,
    withConversationMessageAdmission: core.service.withConversationMessageAdmission.bind(core.service),
  });
  const exchange = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
  await exchange.arrayBuffer();
  function request(path: string, method = "GET", body?: unknown, key?: string) {
    return fetch(`${daemon!.endpoint}/local${path}`, {
      method, headers: { cookie, origin, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
  }
  async function control<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await request(path, method, body);
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
    return await response.json() as T;
  }
  await control(`/workspaces/${workspace.id}/config`, "PATCH", { rootUri: await realpath(workspaceRoot) });
  for (const agent of [alpha, beta]) {
    await control(`/workspaces/${workspace.id}/agents/${agent.id}/config`, "PATCH", { runtimeAdapter: "acceptance-controlled" });
  }
  const agentPath = (name: Agent) => `/conversations/${thread.id}/agents/${identities[name].id}`;
  return {
    client, identities, parent, thread, runtime,
    send(input: CreateMessageInput, key: string) { return request(`/conversations/${thread.id}/messages`, "POST", input, key); },
    start(name: Agent) { return control(`${agentPath(name)}/start`, "POST"); },
    stop(name: Agent) { return control(`${agentPath(name)}/stop`, "POST"); },
    async state(name: Agent) { return (await control<{ agent: LocalConversationAgent }>(agentPath(name))).agent; },
    async answer(trigger: ConversationMessage, name: Agent) {
      await eventually(async () => (await client.listMessages(thread.id)).some(({ replyTo }) => replyTo === trigger.id),
        "The selected worker must answer the saved question in the thread");
      const reply = (await client.listMessages(thread.id)).find(({ replyTo }) => replyTo === trigger.id)!;
      assert.equal(reply.participantId, identities[name].id);
      const call = runtime.calls.find(({ reply: body }) => body === reply.body);
      assert.ok(call, "The answer must originate at the actual Runtime boundary");
      assert.ok(call.input.includes(trigger.body), "The worker must receive the saved question, not merely publish a reply with its id");
      return reply;
    },
  };
}

async function accepted(response: Response): Promise<ConversationMessage> {
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as { message: ConversationMessage }).message;
}

test("first-Send acceptance: startup failure preserves an addressed question and exact retry recovers once", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "owner", "@alpha STARTUP_FAILURE_ROOT");
  const input = { participantId: f.identities.owner.id, body: "QUESTION_SURVIVES_FAILED_STARTUP", to: [f.identities.alpha.id] };
  const key = "startup-failure-first-send";
  f.runtime.startFailures = 1;
  const failedOrRecovered = await f.send(input, key);
  await failedOrRecovered.arrayBuffer();
  assert.ok(f.runtime.startAttempts >= 1);
  const saved = (await f.client.listMessages(f.thread.id)).filter(({ participantId }) => participantId === f.identities.owner.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.body, input.body);
  assert.deepEqual(saved[0]!.to, [f.identities.alpha.id]);
  const retried = await accepted(await f.send(input, key));
  assert.equal(retried.id, saved[0]!.id);
  await f.answer(saved[0]!, "alpha");
  assert.equal((await accepted(await f.send(input, key))).id, saved[0]!.id);
  assert.equal(f.runtime.startAttempts, 2);
  assert.equal(f.runtime.starts.length, 1);
  assert.equal(f.runtime.calls.length, 1);
  assert.equal((await f.client.listMessages(f.thread.id)).filter(({ participantId }) => participantId === f.identities.owner.id).length, 1);
});

test("first-Send acceptance: overlapping explicitly addressed sends reuse one worker", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "beta", "BETA_ROOT_WITH_FIRST_OVERRIDE_TO_ALPHA");
  const held = f.runtime.holdNextStart();
  const firstPending = f.send({ participantId: f.identities.owner.id, body: "@alpha FIRST_EXPLICIT_OVERRIDE" }, "overlap-first");
  void firstPending.catch(() => undefined);
  try {
    await eventually(() => f.runtime.startAttempts === 1, "The first send must reach the controlled launch boundary");
    assert.equal(f.runtime.starts.length, 0);
    // Sticky choice is now per-person browser state (159/171), not inferred
    // globally from the first message. The authenticated client supplies it.
    const secondPending = f.send({ participantId: f.identities.owner.id, body: "UNADDRESSED_FOLLOWUP_REUSES_ALPHA", to: [f.identities.alpha.id] }, "overlap-second");
    void secondPending.catch(() => undefined);
    await f.client.getConversation(f.thread.id);
    held.release();
    for (const response of await Promise.all([firstPending, secondPending])) await accepted(response);
    const questions = (await f.client.listMessages(f.thread.id)).filter(({ participantId }) => participantId === f.identities.owner.id);
    assert.deepEqual(questions.map(({ body }) => body), ["@alpha FIRST_EXPLICIT_OVERRIDE", "UNADDRESSED_FOLLOWUP_REUSES_ALPHA"]);
    for (const question of questions) {
      assert.deepEqual(question.to, [f.identities.alpha.id]);
      await f.answer(question, "alpha");
    }
    assert.equal(f.runtime.startAttempts, 1);
    assert.equal(f.runtime.starts.length, 1);
    assert.equal(f.runtime.calls.length, 2);
    assert.equal((await f.state("beta")).state, "unbound");
  } finally { held.release(); }
});

test("first-Send acceptance: an exact startup retry never executes a retired first message", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const key = "retired-first-message";
  const input = { participantId: f.identities.owner.id, body: "@alpha RETIRED_FIRST_QUESTION" };
  const retired = await f.client.postMessage(f.thread.id, input, { idempotencyKey: key });
  assert.equal(f.runtime.starts.length, 0, "The ordinary public message API must not start workers");
  await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.identities.owner.id,
    expectedRosterRevision: f.parent.rosterRevision, participantIds: [f.identities.owner.id, f.identities.beta.id] });
  await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.identities.owner.id,
    expectedRosterRevision: (await f.client.getConversation(f.parent.id)).rosterRevision,
    participantIds: [f.identities.owner.id, f.identities.alpha.id, f.identities.beta.id] });
  assert.ok(await f.client.getCursor(f.thread.id, f.identities.alpha.id) >= retired.sequence);
  assert.equal((await accepted(await f.send(input, key))).id, retired.id);
  const state = await f.state("alpha");
  if (state.state === "unbound") await f.start("alpha");
  else assert.equal(state.state, "idle");
  const fresh = await accepted(await f.send({ participantId: f.identities.owner.id, body: "@alpha FRESH_WORK_AFTER_RETIREMENT" }, "fresh-after-retirement"));
  await f.answer(fresh, "alpha");
  assert.equal(f.runtime.calls.length, 1, "Only fresh work may execute; rejection of a public response alone is not enough");
  assert.equal((await f.client.listMessages(f.thread.id)).filter(({ replyTo }) => replyTo === retired.id).length, 0);
});

test("first-Send acceptance: exact retries preserve a paused binding until explicit Start", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await f.start("alpha");
  await f.stop("alpha");
  const input = { participantId: f.identities.owner.id, body: "@alpha QUEUED_WHILE_PAUSED" };
  let saved: ConversationMessage | undefined;
  for (let index = 0; index < 2; index += 1) {
    const message = await accepted(await f.send(input, "paused-retry"));
    if (saved) assert.equal(message.id, saved.id);
    else saved = message;
    assert.equal((await f.state("alpha")).state, "stopped");
  }
  assert.equal(f.runtime.starts.length, 1);
  assert.equal(f.runtime.resumes.length, 0);
  assert.equal(f.runtime.calls.length, 0);
  await f.start("alpha");
  await f.answer(saved!, "alpha");
  assert.equal(f.runtime.starts.length, 1);
  assert.equal(f.runtime.calls.length, 1);
});

test("first-Send acceptance: participantId cannot spoof the authenticated actor", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const key = "actor-check-first-send";
  const body = "@alpha ACTOR_CHECK_QUESTION";
  const denied = await f.send({ participantId: f.identities.beta.id, body }, key);
  assert.ok(denied.status >= 400 && denied.status < 500); await denied.arrayBuffer();
  assert.deepEqual(await f.client.listMessages(f.thread.id), []);
  assert.equal(f.runtime.startAttempts, 0);
  const trigger = await accepted(await f.send({ participantId: f.identities.owner.id, body }, key));
  assert.equal(trigger.participantId, f.identities.owner.id);
  await f.answer(trigger, "alpha");
});

test("first-Send acceptance: direct HTTP respects parent archive and explicit reopen", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const input = { participantId: f.identities.owner.id, body: "@alpha QUESTION_BLOCKED_BY_ARCHIVE" };
  const key = "archive-first-send";
  await f.client.updateConversationLifecycle(f.parent.id, { actorIdentityId: f.identities.owner.id, state: "settled" });
  const denied = await f.send(input, key);
  assert.ok(denied.status >= 400 && denied.status < 500); await denied.arrayBuffer();
  assert.deepEqual(await f.client.listMessages(f.thread.id), []);
  assert.equal(f.runtime.startAttempts, 0);
  await f.client.updateConversationLifecycle(f.parent.id, { actorIdentityId: f.identities.owner.id, state: "active" });
  await f.answer(await accepted(await f.send(input, key)), "alpha");
});
