import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConversationClient, ConversationClientError, createConversationHttpServer, type CreateResponseInput, type ResponseResult } from "@minu/channels-core";
import { InMemoryRelayBindingStore } from "../src/binding-store.ts";
import { ConversationRuntimeRelay, type AgentRuntimePort, type RuntimePortMessage, type RuntimePortTurn } from "../src/relay.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

class RetryTimers {
  readonly entries: Array<{ callback: () => void; milliseconds: number; canceled: boolean }> = [];
  readonly schedule = (callback: () => void, milliseconds: number) => {
    const entry = { callback, milliseconds, canceled: false };
    this.entries.push(entry);
    return { cancel: () => { entry.canceled = true; } };
  };
  invoke(index: number) {
    const entry = this.entries[index]!;
    assert.equal(entry.canceled, false);
    entry.callback();
  }
}

async function fixture(t: TestContext, adapter: "recoverable" | "legacy", completionAt = 900) {
  const server = await createConversationHttpServer();
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const store = new InMemoryRelayBindingStore();
  const completed = deferred(), release = deferred(), failedCursor = deferred();
  let relay: ConversationRuntimeRelay | undefined;
  t.after(async () => { release.resolve(); await relay?.stop(); await server.close(); });
  const human = await client.createIdentity({ type: "human" });
  const agent = await client.createIdentity({ type: "agent" });
  const writer = await client.createIdentity({ type: "human" });
  const workspace = await client.createWorkspace({ slug: "delivery-deadline", name: "Delivery deadline" });
  for (const [identity, handle] of [[human, "human"], [agent, "agent"], [writer, "writer"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: handle,
      ...(identity === human ? { accessRole: "owner" as const } : {}) });
  }
  const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
  const root = await client.postMessage(parent.id, { participantId: human.id, body: "Root" });
  const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
  let now = 0, executions = 0, interrupts = 0;
  const history: RuntimePortMessage[] = [], turns = new Map<string, RuntimePortTurn>();
  const execute = async () => {
    executions += 1;
    if (executions === 1) { now = completionAt; completed.resolve(); await release.promise; }
    return { role: "assistant" as const, content: `Successful result ${executions}` };
  };
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; },
    async send() { assert.equal(adapter, "legacy"); history.push(await execute()); },
    async messages() { return [...history]; },
    async interrupt() { interrupts += 1; },
    ...(adapter === "recoverable" ? {
      async startTurn(_sessionId: string, id: string, input: string) {
        const response = await execute();
        const timestamp = new Date().toISOString();
        const turn: RuntimePortTurn = { id, input, response, status: "completed", createdAt: timestamp, updatedAt: timestamp };
        turns.set(id, turn);
        return turn;
      },
      async turn(_sessionId: string, id: string) { return turns.get(id); },
    } : {}),
  };
  const metadataTimers = new RetryTimers(), deliveryTimers = new RetryTimers();
  const originalResponse = client.postResponse.bind(client);
  const deliveries: Array<{ at: number; body: string }> = [];
  let responseHook: ((id: string, input: CreateResponseInput) => Promise<ResponseResult>) | undefined;
  client.postResponse = async (id, input) => {
    deliveries.push({ at: now, body: input.body });
    return responseHook ? responseHook(id, input) : originalResponse(id, input);
  };
  relay = new ConversationRuntimeRelay({ client, conversationId: thread.id, cursorStore: store,
    bindings: [{ participantId: agent.id, sessionId: "deadline-session", runtime }], monotonicNow: () => now,
    turnRetryBudgetMs: 1_000, runtimeRequestTimeoutMs: 2_000, terminalOutcomeTimeoutMs: 1_000,
    scheduleCatchUpRetryTimer: metadataTimers.schedule, scheduleTurnRetryTimer: deliveryTimers.schedule });
  await relay.start();
  const trigger = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Complete near deadline" });
  await completed.promise;
  const originalCursor = client.getCursor.bind(client);
  let failCursor = false;
  client.getCursor = async (id, participantId) => {
    if (failCursor) { failCursor = false; failedCursor.resolve(); throw new ConversationClientError("Temporary cursor read failure", 503); }
    return originalCursor(id, participantId);
  };
  const changeRoster = (participants: string[], revision: number) => client.updateConversationParticipants(parent.id,
    { actorIdentityId: human.id, participantIds: participants, expectedRosterRevision: revision });
  return { client, store, relay, human, agent, writer, thread, trigger, metadataTimers, deliveryTimers, deliveries,
    setNow(value: number) { now = value; }, executions: () => executions, interrupts: () => interrupts,
    failNextCursor() { failCursor = true; }, deliver: originalResponse,
    setDelivery(hook: typeof responseHook) { responseHook = hook; }, changeRoster,
    replies: async () => (await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id),
    async prepareRecovery() {
      failCursor = true;
      await changeRoster([human.id, agent.id, writer.id], 1);
      await failedCursor.promise;
      await eventually(() => metadataTimers.entries.length === 1, "Missing metadata recovery timer");
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    recover(at = 1_150, index = 0) { now = at; metadataTimers.invoke(index); },
    async settled() {
      await eventually(async () => (await store.getCursor(thread.id, agent.id)) >= trigger.sequence, "Completed outcome did not settle");
      await relay!.waitForIdle();
    },
  };
}

for (const adapter of ["recoverable", "legacy"] as const) {
  test(`near-deadline success survives metadata recovery beyond execution expiry (${adapter})`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, adapter);
    await f.prepareRecovery();
    assert.deepEqual(await f.replies(), []);
    f.recover();
    await f.settled();
    assert.deepEqual((await f.replies()).map((message) => message.body), ["Successful result 1"]);
    assert.equal(f.executions(), 1);
    assert.deepEqual(await f.store.listTurnFailures(f.thread.id, 10), []);
  });

  test(`late cancellation still settles the completed outcome after execution expiry (${adapter})`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, adapter);
    await f.prepareRecovery();
    f.setNow(1_100);
    await f.relay.cancelCurrent(f.agent.id, f.human.id);
    assert.equal(f.interrupts(), 1, "The expired execution clock must not prevent cancellation control");
    f.recover();
    await f.settled();
    assert.deepEqual((await f.replies()).map((message) => message.body), ["Current request was canceled by @human."]);
    assert.equal(f.executions(), 1);
  });

  test(`the execution deadline still rejects work completed too late (${adapter})`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, adapter, 1_100);
    await f.prepareRecovery();
    f.recover(1_350);
    await f.settled();
    assert.equal((await f.replies()).length, 1);
    assert.match((await f.replies())[0]!.body, /Runtime turn failed/);
    assert.equal(f.executions(), 1);
    assert.equal((await f.store.listTurnFailures(f.thread.id, 10))[0]!.causeCategory, "turn_timeout");
  });
}

test("a later readiness wait preserves output without resetting spent delivery time", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, "legacy");
  let attempts = 0;
  f.setDelivery(async (id, input) => {
    if (++attempts === 1) { f.setNow(1_250); throw new ConversationClientError("Delivery busy", 429, 100); }
    return f.deliver(id, input);
  });
  await f.prepareRecovery();
  f.recover();
  await eventually(() => f.deliveryTimers.entries.length === 1, "Missing bounded delivery retry");
  f.failNextCursor();
  await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 2);
  await eventually(() => f.metadataTimers.entries.length === 2, "Missing second metadata recovery");
  f.setNow(1_350);
  f.deliveryTimers.invoke(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.recover(3_350, 1);
  await f.settled();
  assert.equal(attempts, 2);
  assert.equal(f.executions(), 1);
  assert.deepEqual((await f.replies()).map((message) => message.body), ["Successful result 1"]);
});

test("active delivery retries remain bounded without replenishing the budget per attempt", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, "recoverable");
  let successAttempts = 0;
  f.setDelivery(async (id, input) => {
    if (input.body === "Successful result 1") {
      f.setNow(++successAttempts === 1 ? 1_250 : 2_150);
      throw new ConversationClientError("Delivery busy", 429, 100);
    }
    return f.deliver(id, input);
  });
  await f.prepareRecovery();
  f.recover();
  await eventually(() => f.deliveryTimers.entries.length === 1, "Missing delivery retry");
  assert.equal(f.deliveryTimers.entries[0]!.milliseconds, 100);
  f.setNow(1_350);
  f.deliveryTimers.invoke(0);
  await f.settled();
  assert.equal(successAttempts, 2);
  assert.equal(f.deliveryTimers.entries.length, 1, "Exhausted active delivery time must not receive a fresh budget");
  assert.equal(f.executions(), 1);
  assert.equal((await f.store.listTurnFailures(f.thread.id, 10))[0]!.causeCategory, "response_delivery_failed");
});

test("late Stop advances its completed trigger without waiting for metadata recovery", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, "legacy");
  await f.prepareRecovery();
  f.setNow(1_100);
  await f.relay.stopBinding(f.agent.id, f.human.id);
  assert.equal(f.interrupts(), 1);
  assert.equal(await f.store.getCursor(f.thread.id, f.agent.id), f.trigger.sequence);
  assert.deepEqual(await f.replies(), []);
  assert.equal(f.relay.workSnapshot().activeTurns, 0);
});

test("retirement still fences a successful answer when recovery crosses the execution deadline", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, "recoverable");
  await f.prepareRecovery();
  await f.changeRoster([f.human.id, f.writer.id], 2);
  await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 3);
  f.recover();
  await f.settled();
  assert.deepEqual(await f.replies(), []);
  assert.equal(f.executions(), 1);
  const fresh = await f.client.postMessage(f.thread.id, { participantId: f.human.id, body: "@agent Fresh after retirement" });
  await eventually(async () => (await f.store.getCursor(f.thread.id, f.agent.id)) >= fresh.sequence, "Fresh work did not complete");
  assert.deepEqual((await f.replies()).map((message) => message.body), ["Successful result 2"]);
});
