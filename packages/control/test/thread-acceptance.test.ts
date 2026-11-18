import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConversationClient,
  ConversationClientError,
  ConversationService,
  createConversationHttpServer,
} from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import type { LocalConversationAgent } from "../src/contracts.ts";
import type { LocalManagedRuntimePort, ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { createLocalControlDaemon, type LocalControlDaemon } from "../src/daemon.ts";

// Independent acceptance cases derived from Conversation messages 3–13 and
// conversation-threads-01/run.md AC1–6, not the builder's thread tests.
// Use real HTTP + SQLite + control/Relay. Only the external model is substituted.
// Creation-time context and manual handoff are clarified in Conversation messages
// 52–62 and docs/conversation-threads.md. Existing earlier-run evidence is historical.

type RuntimeMessage = { role: "user" | "assistant"; content: string };
type ObservedCall = { sessionId: string; input: string; reply: string };

class ObservedRuntime implements LocalManagedRuntimePort {
  readonly starts: Array<{ id: string; config: ManagedRuntimeStartConfig }> = [];
  readonly calls: ObservedCall[] = [];
  private readonly sessions = new Map<string, {
    ownerId: string; working: boolean; messages: RuntimeMessage[];
  }>();
  private held?: { enter(): void; wait: Promise<void>; release(): void };

  async start(): Promise<never> { throw new Error("Acceptance fixture requires owner-scoped sessions"); }

  async startManaged(config: ManagedRuntimeStartConfig, ownerId: string) {
    const id = `PRIVATE_THREAD_SESSION_${this.starts.length + 1}`;
    this.starts.push({ id, config: structuredClone(config) });
    this.sessions.set(id, { ownerId, working: false, messages: [] });
    return { id, ownerId };
  }

  async listManagedSessions(ownerId: string) {
    return [...this.sessions].filter(([, session]) => session.ownerId === ownerId)
      .map(([id]) => ({ id, ownerId, state: "active" as const }));
  }

  async resume(id: string, ownerId: string) {
    assert.equal(this.sessions.get(id)?.ownerId, ownerId);
    return { id, ownerId };
  }

  async status(id: string): Promise<"idle" | "working" | "offline"> {
    const session = this.sessions.get(id);
    return session ? session.working ? "working" : "idle" : "offline";
  }

  async send(sessionId: string, input: string) {
    const session = this.sessions.get(sessionId);
    assert.ok(session, "The product must launch a session before sending to it");
    const call = { sessionId, input, reply: `ACCEPTANCE_REPLY_${this.calls.length + 1}` };
    this.calls.push(call);
    session.messages.push({ role: "user", content: input });
    session.working = true;
    const held = this.held;
    if (held) { held.enter(); await held.wait; this.held = undefined; }
    session.messages.push({ role: "assistant", content: call.reply });
    session.working = false;
  }

  async messages(id: string) { return structuredClone(this.sessions.get(id)?.messages ?? []); }
  async interrupt(id: string) { const session = this.sessions.get(id); if (session) session.working = false; }

  holdNextResponse() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.held = { enter, wait, release };
    return { entered, release };
  }

  release() { this.held?.release(); }

  inputs(id: string) {
    const config = this.starts.find((start) => start.id === id)?.config;
    return [config?.systemPrompt ?? "", config?.appendSystemPrompt ?? "",
      ...this.calls.filter((call) => call.sessionId === id).map((call) => call.input)].join("\n");
  }
}

async function eventually(check: () => Promise<boolean>, description: string) {
  // Harness deadline, not a new product latency requirement.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(description);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thread-acceptance-"));
  const root = join(directory, "workspace");
  await mkdir(join(root, "project"), { recursive: true });
  const canonicalRoot = await realpath(root);
  const runtime = new ObservedRuntime();
  let storage: DrizzleLibSqlConversationStorage | undefined;
  let core: Awaited<ReturnType<typeof createConversationHttpServer>> | undefined;
  let daemon: LocalControlDaemon | undefined;
  let client: ConversationClient;
  let cookie: string;
  const origin = "http://127.0.0.1:5174";

  async function openCore() {
    storage = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "conversations.db")}` });
    core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
    client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  }

  async function openControl(ownerId: string) {
    daemon = await createLocalControlDaemon({
      currentHumanIdentityId: ownerId, conversationsEndpoint: core!.endpoint,
      conversationsServiceToken: core!.serviceToken,
      withConversationMessageAdmission: core!.service.withConversationMessageAdmission.bind(core!.service),
      relayDatabasePath: join(directory, "relay.db"), port: 0, webUrl: `${origin}/`,
      runtimes: { acceptance: runtime }, stopStartedSessionsOnClose: false,
      recordAgentDiagnostics: false,
    });
    const exchange = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
    assert.equal(exchange.status, 303);
    cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    await exchange.arrayBuffer();
  }

  async function controlResponse(path: string, method = "GET", body?: unknown) {
    return fetch(`${daemon!.endpoint}/local${path}`, {
      method, headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
  }

  async function control<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await controlResponse(path, method, body);
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as T;
  }

  async function close() {
    runtime.release();
    try { await daemon?.close(); }
    finally {
      try { await core?.close(); }
      finally { try { await storage?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    }
  }

  try {
    await openCore();
    const owner = await client!.createIdentity({ type: "human", displayName: "Acceptance owner" });
    const agent = await client!.createIdentity({ type: "agent", displayName: "Acceptance agent" });
    const workspace = await client!.createWorkspace({ slug: "thread-acceptance", name: "Thread acceptance" });
    await client!.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
    await client!.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    const parent = await client!.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
    await openControl(owner.id);
    await control(`/workspaces/${workspace.id}/config`, "PATCH", { rootUri: canonicalRoot });
    await control(`/workspaces/${workspace.id}/agents/${agent.id}/config`, "PATCH", { runtimeAdapter: "acceptance" });
    const agentPath = (id: string) => `/conversations/${id}/agents/${agent.id}`;
    return {
      owner, agent, workspace, parent, runtime, canonicalRoot, agentPath, control, controlResponse, close,
      get client() { return client!; },
      get daemon() { return daemon!; },
      async start(id: string) { return control<{ agent: LocalConversationAgent }>(`${agentPath(id)}/start`, "POST"); },
      async threads() {
        await client!.postMessage(parent.id, { participantId: owner.id, body: "SHARED_BACKGROUND before branching" });
        const rootA = await client!.postMessage(parent.id, { participantId: owner.id, body: "ROOT_ALPHA_TOPIC" });
        const a = await client!.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: rootA.id });
        const rootB = await client!.postMessage(parent.id, { participantId: agent.id, body: "ROOT_BETA_TOPIC" });
        const b = await client!.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: rootB.id });
        return { a, b, rootA, rootB };
      },
      async reply(id: string, body: string) {
        const trigger = await client!.postMessage(id, { participantId: owner.id, body: `@agent ${body}` });
        await eventually(async () => (await client!.listMessages(id)).some((message) =>
          message.participantId === agent.id && message.replyTo === trigger.id), `No agent reply in requested scope: ${body}`);
        const response = (await client!.listMessages(id)).find((message) => message.replyTo === trigger.id)!;
        const call = runtime.calls.find((candidate) => candidate.reply === response.body);
        assert.ok(call, "The response must come from the actual Runtime boundary");
        return { trigger, response, call };
      },
      async restart() {
        await daemon!.close(); daemon = undefined;
        await core!.close(); core = undefined;
        await storage!.close(); storage = undefined;
        await openCore();
        await openControl(owner.id);
      },
    };
  } catch (error) { await close(); throw error; }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const denied = (error: unknown) => error instanceof ConversationClientError && error.status >= 400 && error.status < 500;
async function controlDenied(f: Fixture, path: string, method: string, body?: unknown) {
  const response = await f.controlResponse(path, method, body);
  const detail = await response.text();
  assert.ok(response.status >= 400 && response.status < 500, `Expected rejection: ${response.status} ${detail}`);
}

// AC1/2/4: retries and persistence are judged by public reads, not storage helpers.
test("acceptance: one durable thread per root; retry keys and ordered replies stay scope-local", async (t) => {
  const f = await fixture(); t.after(f.close);
  const rootA = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "Human root" });
  const rootB = await f.client.postMessage(f.parent.id, { participantId: f.agent.id, body: "Agent root" });
  const repeated = await Promise.all(Array.from({ length: 3 }, () => f.client.createThread(f.parent.id,
    { actorIdentityId: f.owner.id, rootMessageId: rootA.id })));
  const a = repeated[0]!;
  const b = await f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: rootB.id });
  assert.ok(repeated.every(({ id }) => id === a.id));
  await assert.rejects(f.client.createThread(a.id, { actorIdentityId: f.owner.id, rootMessageId: rootA.id }), denied);
  await assert.rejects(f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: "missing" }), denied);
  const other = await f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id] });
  await assert.rejects(f.client.createThread(other.id, { actorIdentityId: f.owner.id, rootMessageId: rootA.id }), denied);
  const expected = new Map<string, string[]>();
  for (const [id, label] of [[f.parent.id, "MAIN"], [a.id, "ALPHA"], [b.id, "BETA"]]) {
    const before = (await f.client.listMessages(id!)).map(({ id: messageId }) => messageId);
    const input = { participantId: f.owner.id, body: `${label}_FIRST` };
    const first = await f.client.postMessage(id!, input, { idempotencyKey: "same-key-in-each-scope" });
    const again = await f.client.postMessage(id!, input, { idempotencyKey: "same-key-in-each-scope" });
    assert.equal(again.id, first.id);
    const second = await f.client.postMessage(id!, { participantId: f.owner.id, body: `${label}_SECOND` });
    expected.set(id!, [...before, first.id, second.id]);
  }
  await f.restart();
  assert.equal((await f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: rootA.id })).id, a.id);
  for (const [id, messageIds] of expected) {
    const messages = await f.client.listMessages(id);
    const first = messages.at(-2)!;
    const retried = await f.client.postMessage(id, { participantId: f.owner.id, body: first.body },
      { idempotencyKey: "same-key-in-each-scope" });
    assert.equal(retried.id, first.id, "Restart must preserve the original scope's retry key");
    assert.deepEqual((await f.client.listMessages(id)).map(({ id }) => id), messageIds);
  }
  assert.deepEqual((await f.client.listThreads(f.parent.id)).map(({ replyCount }) => replyCount), [2, 2]);
  assert.deepEqual(new Set((await f.client.listWorkspaceConversations(f.workspace.id)).map(({ id }) => id)), new Set([f.parent.id, other.id]));
});

// AC3: inherited administration changes existing threads, not just newly created ones.
test("acceptance: parent roster additions/removals apply to existing threads and cannot be widened locally", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a, b, rootA } = await f.threads();
  const writer = await f.client.createIdentity({ type: "human" });
  await f.client.addWorkspaceMember(f.workspace.id, { identityId: writer.id, mentionHandle: "writer" });
  await assert.rejects(f.client.createThread(f.parent.id, { actorIdentityId: writer.id, rootMessageId: rootA.id }), denied);
  await assert.rejects(f.client.updateConversationParticipants(a.id, { actorIdentityId: f.owner.id,
    expectedRosterRevision: a.rosterRevision, participantIds: [f.owner.id, f.agent.id, writer.id] }), denied);
  await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.owner.id,
    expectedRosterRevision: f.parent.rosterRevision, participantIds: [f.owner.id, f.agent.id, writer.id] });
  for (const scope of [a, b]) {
    assert.deepEqual((await f.client.getConversation(scope.id)).participants.map(({ id }) => id), [f.owner.id, f.agent.id, writer.id]);
    await f.client.postMessage(scope.id, { participantId: writer.id, body: "Allowed by inherited membership" });
  }
  await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.owner.id,
    expectedRosterRevision: (await f.client.getConversation(f.parent.id)).rosterRevision, participantIds: [f.owner.id] });
  for (const scope of [a, b]) {
    assert.deepEqual((await f.client.getConversation(scope.id)).participants.map(({ id }) => id), [f.owner.id]);
    for (const participantId of [writer.id, f.agent.id])
      await assert.rejects(f.client.postMessage(scope.id, { participantId, body: "Must not commit" }), denied);
    await controlDenied(f, `${f.agentPath(scope.id)}/start`, "POST");
    assert.equal((await f.client.listMessages(scope.id)).length, 1);
  }
  assert.equal(f.runtime.starts.length, 0);
});

test("acceptance: archived parent freezes thread writes and starts; a thread cannot reactivate itself", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a, b, rootA } = await f.threads();
  await f.control(`/conversations/${f.parent.id}/lifecycle`, "PATCH", { state: "settled" });
  for (const scope of [a, b]) {
    assert.equal((await f.client.getConversationLifecycle(scope.id)).state, "settled");
    await assert.rejects(f.client.postMessage(scope.id, { participantId: f.owner.id, body: "Must stay frozen" }), denied);
    await assert.rejects(f.client.updateConversationLifecycle(scope.id, { actorIdentityId: f.owner.id, state: "active" }), denied);
    await controlDenied(f, `${f.agentPath(scope.id)}/start`, "POST");
    assert.equal((await f.client.listMessages(scope.id)).length, 0);
  }
  await assert.rejects(f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: rootA.id }), denied);
  assert.equal(f.runtime.starts.length, 0);
});

test("acceptance: a running thread blocks parent archive, then an idle parent archives all thread scopes", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a, b } = await f.threads();
  for (const id of [f.parent.id, a.id, b.id]) await f.start(id);
  const held = f.runtime.holdNextResponse();
  try {
    const trigger = await f.client.postMessage(a.id, { participantId: f.owner.id, body: "@agent WORK_BEFORE_ARCHIVE" });
    await eventually(async () => f.runtime.calls.some(({ input }) => input.includes("WORK_BEFORE_ARCHIVE")),
      "Thread work must reach the Runtime before exercising lifecycle admission");
    const blocked = await f.controlResponse(`/conversations/${f.parent.id}/lifecycle`, "PATCH", { state: "settled" });
    const detail = await blocked.text();
    assert.equal(blocked.status, 409, `Active thread work must block parent Archive: ${detail}`);
    assert.equal((await f.client.getConversationLifecycle(f.parent.id)).state, "active");
    held.release();
    await eventually(async () => (await f.client.listMessages(a.id)).some(({ replyTo }) => replyTo === trigger.id),
      "The permitted in-flight turn must finish in its thread");
    await eventually(async () => {
      const snapshot = f.daemon.workSnapshot();
      return snapshot.activeTurns === 0 && snapshot.queuedTurns === 0;
    }, "Wait for thread work to settle before archiving");
    await f.control(`/conversations/${f.parent.id}/lifecycle`, "PATCH", { state: "settled" });
    const calls = f.runtime.calls.length;
    for (const id of [f.parent.id, a.id, b.id]) {
      assert.equal((await f.client.getConversationLifecycle(id)).state, "settled");
      await assert.rejects(f.client.postMessage(id, { participantId: f.owner.id, body: "@agent FROZEN_REQUEST" }), denied);
      await controlDenied(f, `${f.agentPath(id)}/start`, "POST");
    }
    assert.equal(f.runtime.calls.length, calls, "No scope may execute new work after parent Archive");
  } finally { held.release(); }
});

// AC4/5: the product chooses the sessions; no test-injected Relay bindings.
test("acceptance: main and two threads launch distinct sessions and route replies without cross-scope history", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a, b } = await f.threads();
  assert.equal(f.runtime.starts.length, 0, "Opening threads must not implicitly start agents");
  for (const id of [f.parent.id, a.id, b.id]) await f.start(id);
  const main = await f.reply(f.parent.id, "MAIN_ONLY choose red");
  const alpha = await f.reply(a.id, "ALPHA_ONLY choose blue");
  const beta = await f.reply(b.id, "BETA_ONLY choose green");
  assert.equal(new Set([main.call.sessionId, alpha.call.sessionId, beta.call.sessionId]).size, 3);
  assert.equal(f.runtime.starts.length, 3);
  await f.reply(a.id, "ALPHA_FOLLOWUP retain blue");
  await f.reply(b.id, "BETA_FOLLOWUP retain green");
  await f.reply(f.parent.id, "MAIN_FOLLOWUP retain red");
  assert.doesNotMatch(f.runtime.inputs(main.call.sessionId), /ALPHA_ONLY|ALPHA_FOLLOWUP|BETA_ONLY|BETA_FOLLOWUP/);
  assert.doesNotMatch(f.runtime.inputs(alpha.call.sessionId), /MAIN_ONLY|MAIN_FOLLOWUP|BETA_ONLY|BETA_FOLLOWUP/);
  assert.doesNotMatch(f.runtime.inputs(beta.call.sessionId), /MAIN_ONLY|MAIN_FOLLOWUP|ALPHA_ONLY|ALPHA_FOLLOWUP/);
  for (const [id, allowed] of [[f.parent.id, "MAIN"], [a.id, "ALPHA"], [b.id, "BETA"]]) {
    const messages = await f.client.listMessages(id!);
    for (const message of messages.filter(({ participantId, replyTo }) => participantId === f.agent.id && replyTo)) {
      const trigger = messages.find(({ id }) => id === message.replyTo);
      assert.ok(trigger?.body.includes(`${allowed}_`), "Agent output must reply to a trigger in its own scope");
    }
  }
  const publicState = JSON.stringify([await f.client.getConversation(f.parent.id), await f.client.listThreads(f.parent.id)]);
  assert.doesNotMatch(publicState, /PRIVATE_THREAD_SESSION_|runtimeSessionId|runtimeOwnerId/);
});

test("acceptance: thread gets its root and shared background once, not later parent or sibling messages", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a, b } = await f.threads();
  await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "PARENT_AFTER_CREATION_ONLY" });
  await f.client.postMessage(b.id, { participantId: f.owner.id, body: "SIBLING_REPLY_ONLY" });
  await f.start(a.id);
  const first = await f.reply(a.id, "ALPHA_FIRST_REQUEST");
  const initial = f.runtime.inputs(first.call.sessionId);
  assert.match(initial, /ROOT_ALPHA_TOPIC/, "Initial Runtime context must include the selected root");
  assert.match(initial, /SHARED_BACKGROUND/, "Initial Runtime context must include relevant parent background");
  await f.reply(a.id, "ALPHA_SECOND_REQUEST");
  const allInputs = f.runtime.inputs(first.call.sessionId);
  assert.equal(allInputs.split("ROOT_ALPHA_TOPIC").length - 1, 1, "The inherited snapshot must not be seeded again on each turn");
  assert.doesNotMatch(allInputs, /PARENT_AFTER_CREATION_ONLY|SIBLING_REPLY_ONLY/);
});

test("acceptance: service restart preserves scoped sessions/cursors and does not wake a stopped sibling", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a, b } = await f.threads();
  for (const id of [f.parent.id, a.id, b.id]) await f.start(id);
  const main = await f.reply(f.parent.id, "MAIN_BEFORE_RESTART");
  const alpha = await f.reply(a.id, "ALPHA_BEFORE_RESTART");
  const beta = await f.reply(b.id, "BETA_BEFORE_RESTART");
  await f.control(`${f.agentPath(b.id)}/stop`, "POST");
  const count = f.runtime.calls.length;
  await f.restart();
  const stopped = await f.control<{ agent: LocalConversationAgent }>(f.agentPath(b.id));
  assert.equal(stopped.agent.state, "stopped");
  const queued = await f.client.postMessage(b.id, { participantId: f.owner.id, body: "@agent BETA_QUEUED_WHILE_STOPPED" });
  const resumedAlpha = await f.reply(a.id, "ALPHA_AFTER_RESTART");
  const resumedMain = await f.reply(f.parent.id, "MAIN_AFTER_RESTART");
  assert.equal(resumedAlpha.call.sessionId, alpha.call.sessionId);
  assert.equal(resumedMain.call.sessionId, main.call.sessionId);
  assert.equal(f.runtime.calls.length, count + 2, "Restart must neither replay old triggers nor wake the stopped sibling");
  assert.ok(!(await f.client.listMessages(b.id)).some(({ replyTo }) => replyTo === queued.id));
  await f.start(b.id);
  await eventually(async () => (await f.client.listMessages(b.id)).some(({ replyTo }) => replyTo === queued.id), "Explicit Start must recover the stopped thread's queued trigger");
  const answer = (await f.client.listMessages(b.id)).find(({ replyTo }) => replyTo === queued.id)!;
  assert.equal(f.runtime.calls.find(({ reply }) => reply === answer.body)?.sessionId, beta.call.sessionId);
  assert.equal(f.runtime.starts.length, 3, "Recovery must reuse existing sessions, not silently replace them");
  for (const id of [f.parent.id, a.id, b.id]) {
    const replies = (await f.client.listMessages(id)).filter(({ participantId, replyTo }) => participantId === f.agent.id && replyTo);
    assert.equal(replies.length, 2, "Each scope must retain exactly its two accepted replies");
    assert.equal(new Set(replies.map(({ replyTo }) => replyTo)).size, 2);
  }
  const restoredInputs = f.runtime.inputs(alpha.call.sessionId);
  assert.doesNotMatch(restoredInputs, /MAIN_AFTER_RESTART|BETA_QUEUED_WHILE_STOPPED/);
  assert.equal(restoredInputs.split("ROOT_ALPHA_TOPIC").length - 1, 1, "Restoring the same session must not seed parent context again");
});

test("acceptance: removing an agent from the parent fences an already-running thread result", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a } = await f.threads();
  await f.start(a.id);
  const held = f.runtime.holdNextResponse();
  try {
    const trigger = await f.client.postMessage(a.id, { participantId: f.owner.id, body: "@agent HELD_THREAD_REQUEST" });
    await eventually(async () => f.runtime.calls.some(({ input }) => input.includes("HELD_THREAD_REQUEST")),
      "Thread request never reached the Runtime");
    await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.owner.id,
      expectedRosterRevision: f.parent.rosterRevision, participantIds: [f.owner.id] });
    held.release();
    await eventually(async () => {
      const snapshot = f.daemon.workSnapshot();
      return snapshot.activeTurns === 0 && snapshot.queuedTurns === 0;
    }, "Revoked agent's turn must settle without committing its stale response");
    assert.ok(!(await f.client.listMessages(a.id)).some(({ replyTo }) => replyTo === trigger.id));
    await controlDenied(f, `${f.agentPath(a.id)}/start`, "POST");
  } finally { held.release(); }
});

test("acceptance: thread sessions inherit the parent's working folder rather than a different project scope", async (t) => {
  const f = await fixture(); t.after(f.close);
  const { a, b } = await f.threads();
  const project = join(f.canonicalRoot, "project");
  await f.control(`/conversations/${f.parent.id}/working-folders`, "PUT", { folders: [{ path: project, primary: true }] });
  for (const id of [f.parent.id, a.id, b.id]) await f.start(id);
  assert.equal(f.runtime.starts.length, 3);
  assert.deepEqual(f.runtime.starts.map(({ config }) => config.cwd), [project, project, project]);
});

// Creation-time v1: expected outcomes come from the clarified public contract,
// including its documented 20-message / nominal 16,000-body-character limits.
test("acceptance: creation-time context includes post-root decisions and stays frozen through delayed start and restart", async (t) => {
  const f = await fixture(); t.after(f.close);
  const before = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "INITIAL_PUBLIC_BACKGROUND" });
  const root = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "SELECTED_ORIGINAL_TOPIC" });
  const decision = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "DECISION_AFTER_ROOT_BEFORE_CREATION" });
  const input = { actorIdentityId: f.owner.id, rootMessageId: root.id };
  const thread = await f.client.createThread(f.parent.id, input);
  const frozen = structuredClone(thread.thread.context);
  assert.deepEqual(frozen.map(({ id }) => id), [before.id, root.id, decision.id]);
  assert.equal(thread.thread.rootMessageId, root.id, "The newer decision must not become the selected root");
  assert.equal(f.runtime.starts.length, 0);

  const later = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "PARENT_AFTER_FIRST_CREATION" });
  const sibling = await f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: later.id });
  assert.ok(sibling.thread.context.some(({ id }) => id === later.id), "A later thread captures its own newer creation boundary");
  await f.client.postMessage(sibling.id, { participantId: f.owner.id, body: "SIBLING_REPLY_AFTER_CREATION" });
  for (const reopened of await Promise.all([f.client.createThread(f.parent.id, input), f.client.createThread(f.parent.id, input)])) {
    assert.equal(reopened.id, thread.id);
    assert.deepEqual(reopened.thread.context, frozen);
  }
  await f.restart();
  assert.deepEqual((await f.client.getConversation(thread.id)).thread?.context, frozen);
  assert.deepEqual((await f.client.createThread(f.parent.id, input)).thread.context, frozen);
  assert.equal(f.runtime.starts.length, 0, "Service restart/reopen must not start a thread agent");

  await f.start(thread.id);
  const first = await f.reply(thread.id, "FIRST_REQUEST_AFTER_DELAYED_START");
  const initial = f.runtime.inputs(first.call.sessionId);
  for (const marker of [before.body, root.body, decision.body]) assert.ok(initial.includes(marker), `Missing creation-time background: ${marker}`);
  assert.doesNotMatch(initial, /PARENT_AFTER_FIRST_CREATION|SIBLING_REPLY_AFTER_CREATION/);
  await f.restart();
  await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "PARENT_AFTER_AGENT_RESTART" });
  const resumed = await f.reply(thread.id, "FOLLOWUP_AFTER_AGENT_RESTART");
  assert.equal(resumed.call.sessionId, first.call.sessionId);
  assert.equal(f.runtime.starts.length, 1);
  const allInputs = f.runtime.inputs(first.call.sessionId);
  assert.equal(allInputs.split(root.body).length - 1, 1, "Restoring the same session must not seed the root again");
  assert.equal(allInputs.split(decision.body).length - 1, 1, "Restoring the same session must not seed the inherited decision again");
  assert.doesNotMatch(allInputs, /PARENT_AFTER_FIRST_CREATION|SIBLING_REPLY_AFTER_CREATION|PARENT_AFTER_AGENT_RESTART/);
  assert.deepEqual((await f.client.getConversation(thread.id)).thread?.context, frozen);
});

for (const scenario of [
  { name: "recent-message window", fillers: 25, fillerCharacters: 80 },
  { name: "body-character budget", fillers: 8, fillerCharacters: 3_500 },
]) {
  test(`acceptance: creation-time ${scenario.name} retains an old root and the latest decision`, async (t) => {
    const f = await fixture(); t.after(f.close);
    const root = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "OLD_ROOT_MUST_SURVIVE" });
    const parentIds = new Set([root.id]);
    for (let index = 0; index < scenario.fillers; index += 1) {
      const message = await f.client.postMessage(f.parent.id, { participantId: f.owner.id,
        body: `INTERVENING_${index}: ${"x".repeat(scenario.fillerCharacters)}` });
      parentIds.add(message.id);
    }
    const decision = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "LATEST_PRE_CREATION_DECISION" });
    parentIds.add(decision.id);
    const thread = await f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
    const snapshot = thread.thread.context;
    assert.equal(thread.thread.rootMessageId, root.id);
    assert.equal(snapshot.filter(({ id }) => id === root.id).length, 1);
    assert.equal(snapshot.find(({ id }) => id === root.id)?.body, root.body);
    assert.equal(snapshot.at(-1)?.id, decision.id);
    assert.ok(snapshot.length <= 20, "Published message bound includes the retained root");
    assert.ok(snapshot.reduce((total, { body }) => total + body.length, 0) <= 16_000, "Ordinary roots must fit the published body budget");
    assert.ok(snapshot.length < parentIds.size, "The bounded snapshot must omit some older background in this scenario");
    assert.ok(snapshot.every(({ id }) => parentIds.has(id)));
    const sequences = snapshot.map(({ sequence }) => sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(new Set(snapshot.map(({ id }) => id)).size, snapshot.length);
    await f.start(thread.id);
    const answer = await f.reply(thread.id, "USE_THE_OLD_ROOT_AND_LATEST_DECISION");
    const delivered = f.runtime.inputs(answer.call.sessionId);
    assert.ok(delivered.includes(root.body));
    assert.ok(delivered.includes(decision.body));
  });
}

test("acceptance: creation-time context preserves an oversized root in full despite the nominal background budget", async (t) => {
  const f = await fixture(); t.after(f.close);
  const body = `OVERSIZED_ROOT_START:${"x".repeat(16_000)}:OVERSIZED_ROOT_END`;
  const root = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body });
  await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "Small newer background" });
  const thread = await f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
  const snapshot = thread.thread.context;
  assert.equal(snapshot.filter(({ id }) => id === root.id).length, 1);
  assert.equal(snapshot.find(({ id }) => id === root.id)?.body, body, "The root exception must not truncate either end of the message");
  assert.ok(snapshot.length <= 20);
  assert.ok(snapshot.reduce((total, message) => total + message.body.length, 0) <= Math.max(16_000, body.length));
  await f.restart();
  assert.deepEqual((await f.client.getConversation(thread.id)).thread?.context, snapshot);
});
