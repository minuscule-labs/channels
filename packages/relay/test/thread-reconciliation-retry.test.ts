import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConversationClient, ConversationClientError, InMemoryConversationStorage, createConversationHttpServer } from "@minu/channels-core";
import { ConversationRuntimeRelay } from "../src/relay.ts";

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
  invoke(index: number): void {
    const entry = this.entries[index]!;
    assert.equal(entry.canceled, false);
    entry.callback();
  }
}

async function fixture(t: TestContext) {
  const server = await createConversationHttpServer();
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const cursors = new InMemoryConversationStorage();
  const started = deferred(), release = deferred(), completed = deferred(), failedCursor = deferred();
  let relay: ConversationRuntimeRelay | undefined;
  t.after(async () => { release.resolve(); await relay?.stop(); await server.close(); });
  const human = await client.createIdentity({ type: "human" });
  const agent = await client.createIdentity({ type: "agent" });
  const writer = await client.createIdentity({ type: "human" });
  const workspace = await client.createWorkspace({ slug: "thread-retry", name: "Thread retry" });
  for (const [identity, handle] of [[human, "human"], [agent, "agent"], [writer, "writer"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: handle,
      ...(identity === human ? { accessRole: "owner" as const } : {}) });
  }
  const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
  const root = await client.postMessage(parent.id, { participantId: human.id, body: "Root" });
  const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
  const history: Array<{ role: "assistant"; content: string }> = [];
  let sends = 0, observedRevision = 1;
  const runtime = {
    async status() { return "idle" as const; },
    async send() {
      const count = ++sends;
      if (count === 1) { started.resolve(); await release.promise; }
      history.push({ role: "assistant", content: `Successful result ${count}` });
      completed.resolve();
    },
    async messages() { return [...history]; },
    async interrupt() { release.resolve(); },
  };
  const originalEvents = client.events.bind(client);
  client.events = (id, options) => (async function* () {
    for await (const event of originalEvents(id, options)) {
      yield event;
      if (event.type === "roster.updated") observedRevision = Math.max(observedRevision, event.rosterRevision);
    }
  })();
  const retryTimers = new RetryTimers(), executionTimers = new RetryTimers();
  relay = new ConversationRuntimeRelay({ client, conversationId: thread.id, cursorStore: cursors,
    bindings: [{ participantId: agent.id, sessionId: "retry-session", runtime }],
    scheduleCatchUpRetryTimer: retryTimers.schedule, scheduleTurnRetryTimer: executionTimers.schedule });
  await relay.start();
  const trigger = await client.postMessage(thread.id, { participantId: human.id, body: "@agent Complete this work" });
  await started.promise;
  const originalCursor = client.getCursor.bind(client);
  let remaining = 0, cursorReads = 0;
  let failure: Error = new ConversationClientError("Temporary cursor failure", 503);
  client.getCursor = async (id, participantId) => {
    cursorReads += 1;
    if (remaining !== 0) {
      if (remaining > 0) remaining -= 1;
      failedCursor.resolve();
      throw failure;
    }
    return originalCursor(id, participantId);
  };
  const changeRoster = (participantIds: string[], expectedRosterRevision: number) => client.updateConversationParticipants(parent.id,
    { actorIdentityId: human.id, participantIds, expectedRosterRevision });
  return { client, cursors, relay, human, agent, writer, thread, trigger, release, completed, failedCursor,
    retryTimers, executionTimers, changeRoster,
    armFailures(count: number, error = failure) { remaining = count; failure = error; },
    reads: () => cursorReads, sends: () => sends, revision: () => observedRevision,
    replies: async () => (await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id),
  };
}

test("one failed live reconciliation preserves the successful result and recovers without unrelated traffic", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.armFailures(1);
  await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 1);
  await f.failedCursor.promise;
  f.release.resolve();
  await f.completed.promise;
  await eventually(() => f.retryTimers.entries.length === 1, "Reconciliation did not schedule its own retry");
  assert.deepEqual(await f.replies(), [], "Unknown retirement state must keep delivery closed");
  assert.equal(f.executionTimers.entries.length, 0, "Metadata failures must not consume Runtime execution retries");
  f.retryTimers.invoke(0);
  await eventually(async () => (await f.replies()).length === 1, "Successful result was not delivered after reconciliation recovered");
  await f.relay.waitForIdle();
  assert.ok(f.reads() >= 2, "Recovery must perform a new cursor read without another event");
  assert.equal(f.sends(), 1, "The completed Runtime work must not execute again");
  assert.deepEqual((await f.replies()).map((message) => message.body), ["Successful result 1"]);
  assert.equal(await f.cursors.getCursor(f.thread.id, f.agent.id), f.trigger.sequence);
});

test("reconciliation retries use capped backoff, remain fail-closed and abort on shutdown", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.armFailures(-1);
  await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 1);
  await f.failedCursor.promise;
  f.release.resolve();
  await f.completed.promise;
  const expected = [250, 500, 1_000, 2_000, 5_000, 5_000];
  for (let index = 0; index < expected.length; index += 1) {
    await eventually(() => f.retryTimers.entries.length > index, "Missing reconciliation backoff");
    assert.equal(f.retryTimers.entries[index]!.milliseconds, expected[index]);
    if (index + 1 < expected.length) f.retryTimers.invoke(index);
  }
  assert.deepEqual(await f.replies(), []);
  assert.equal(f.executionTimers.entries.length, 0);
  assert.equal(await f.cursors.getCursor(f.thread.id, f.agent.id), 0);
  const reads = f.reads();
  await f.relay.stop();
  assert.equal(f.retryTimers.entries.at(-1)!.canceled, true, "Shutdown must cancel pending backoff");
  assert.equal(f.reads(), reads);
  assert.equal(f.sends(), 1);
  assert.deepEqual(await f.replies(), []);
});

test("revocation during a reconciliation retry still fences the completed result", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.armFailures(1);
  await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 1);
  await f.failedCursor.promise;
  f.release.resolve();
  await f.completed.promise;
  await eventually(() => f.retryTimers.entries.length === 1, "Missing reconciliation retry");
  await f.changeRoster([f.human.id, f.writer.id], 2);
  await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 3);
  await eventually(() => f.revision() === 4, "Roster invalidation was blocked behind retry");
  f.retryTimers.invoke(0);
  await eventually(() => f.relay.workSnapshot().activeTurns === 0, "Retired active result did not settle");
  assert.deepEqual(await f.replies(), []);
  assert.equal(f.sends(), 1);
  const fresh = await f.client.postMessage(f.thread.id, { participantId: f.human.id, body: "@agent Fresh work after recovery" });
  await eventually(async () => (await f.cursors.getCursor(f.thread.id, f.agent.id)) >= fresh.sequence, "Fresh work did not recover");
  assert.deepEqual((await f.replies()).map((message) => message.body), ["Successful result 2"]);
});

for (const action of ["retire", "stop"] as const) {
  test(`binding ${action} settles without waiting for shared reconciliation recovery`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    f.armFailures(-1);
    await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 1);
    await f.failedCursor.promise;
    f.release.resolve();
    await f.completed.promise;
    await eventually(() => f.retryTimers.entries.length === 1, "Missing reconciliation retry");
    let settled = false;
    const stopping = action === "retire" ? f.relay.retire(f.agent.id) : f.relay.stopBinding(f.agent.id, f.human.id);
    void stopping.then(() => { settled = true; }, () => { settled = true; });
    await eventually(() => settled, `Binding ${action} was blocked by a peer-scoped reconciliation wait`);
    await stopping;
    assert.deepEqual(await f.replies(), []);
    assert.equal(f.sends(), 1);
    assert.equal(f.executionTimers.entries.length, 0);
    if (action === "stop") assert.equal(await f.cursors.getCursor(f.thread.id, f.agent.id), f.trigger.sequence);
  });
}

test("permanent reconciliation denial fences delivery without execution retries", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.armFailures(-1, new ConversationClientError("Cursor access denied", 403));
  await f.changeRoster([f.human.id, f.agent.id, f.writer.id], 1);
  await f.failedCursor.promise;
  f.release.resolve();
  await f.completed.promise;
  await eventually(() => f.relay.workSnapshot().activeTurns === 0, "Permanent denial did not fence the turn");
  assert.deepEqual(await f.replies(), []);
  assert.equal(f.retryTimers.entries.length, 0);
  assert.equal(f.executionTimers.entries.length, 0);
  assert.equal(f.sends(), 1);
});
