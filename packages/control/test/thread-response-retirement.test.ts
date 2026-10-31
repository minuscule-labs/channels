import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, ConversationClientError, ConversationService, InMemoryConversationStorage, createConversationHttpServer, type ConversationStorage, type ConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { ConversationRuntimeRelay } from "@minu/channels-relay";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function fixture(t: TestContext, kind: "memory" | "libsql") {
  const directory = await mkdtemp(join(tmpdir(), "thread-response-retirement-"));
  const stores = new Set<ConversationStorage>(), servers: ConversationHttpServer[] = [], relays: ConversationRuntimeRelay[] = [];
  const releases: Array<() => void> = [];
  t.after(async () => {
    releases.forEach((release) => release());
    await Promise.all(relays.map((relay) => relay.stop()));
    await Promise.all(servers.map((server) => server.close()));
    for (const store of stores) await store.close?.();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `file:${join(directory, "collaboration.db")}`;
  const storage: ConversationStorage = kind === "memory" ? new InMemoryConversationStorage()
    : await DrizzleLibSqlConversationStorage.open({ url });
  stores.add(storage);
  // Separate service/connection bypasses any process-local service admission lock.
  const competingStorage: ConversationStorage = kind === "memory" ? storage : await DrizzleLibSqlConversationStorage.open({ url });
  stores.add(competingStorage);
  const server = await createConversationHttpServer({ service: new ConversationService(storage) });
  servers.push(server);
  const competing = await createConversationHttpServer({ service: new ConversationService(competingStorage) });
  servers.push(competing);
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const rosterClient = new ConversationClient(competing.endpoint, { serviceToken: competing.serviceToken });
  const human = await client.createIdentity({ type: "human" });
  const agent = await client.createIdentity({ type: "agent" });
  const workspace = await client.createWorkspace({ slug: "response-retirement", name: "Response retirement" });
  await client.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "human", accessRole: "owner" });
  await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
  const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
  const root = await client.postMessage(parent.id, { participantId: human.id, body: "Root" });
  const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
  const removeAndReadd = async (mutator = rosterClient) => {
    await mutator.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id], expectedRosterRevision: 1 });
    await mutator.updateConversationParticipants(parent.id, { actorIdentityId: human.id, participantIds: [human.id, agent.id], expectedRosterRevision: 2 });
  };
  const response = (trigger: { id: string; sequence: number }, body: string) => ({ participantId: agent.id, body,
    triggerMessageId: trigger.id, triggerSequence: trigger.sequence });
  return { storage, client, rosterClient, human, agent, thread, relays, releases, removeAndReadd, response,
    replies: async () => (await client.listMessages(thread.id)).filter((message) => message.participantId === agent.id) };
}

for (const kind of ["memory", "libsql"] as const) {
  test(`delayed Relay delivery cannot publish a retired thread answer (${kind})`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, kind);
    const captured = deferred(), release = deferred();
    f.releases.push(release.resolve);
    const originalResponse = f.client.postResponse.bind(f.client);
    let holdOnce = true;
    const rejected: number[] = [];
    f.client.postResponse = async (id, input) => {
      if (holdOnce) { holdOnce = false; captured.resolve(); await release.promise; }
      try { return await originalResponse(id, input); }
      catch (error) { if (error instanceof ConversationClientError) rejected.push(error.status); throw error; }
    };
    let executions = 0;
    const history: Array<{ role: "assistant"; content: string }> = [];
    const privateCursors = new InMemoryConversationStorage();
    const relay = new ConversationRuntimeRelay({ client: f.client, conversationId: f.thread.id, cursorStore: privateCursors,
      bindings: [{ participantId: f.agent.id, sessionId: "delayed-response", runtime: {
        async status() { return "idle" as const; },
        async send() { history.push({ role: "assistant", content: `Answer ${++executions}` }); },
        async messages() { return [...history]; },
      } }] });
    f.relays.push(relay);
    await relay.start();
    const stale = await f.client.postMessage(f.thread.id, { participantId: f.human.id, body: "@agent Original request" });
    await captured.promise;
    // Live Relay notifications belong to its service instance; the separate
    // service is used by the stale-validation test, not as a cross-server bus.
    await f.removeAndReadd(f.client);
    await eventually(async () => (await privateCursors.getCursor(f.thread.id, f.agent.id)) >= stale.sequence,
      "Relay did not reconcile retirement while delivery was held");
    assert.equal(await f.storage.getCursor(f.thread.id, f.agent.id), stale.sequence);
    assert.deepEqual(await f.replies(), []);
    release.resolve();
    await eventually(() => relay.workSnapshot().activeTurns === 0, "Retired delivery did not settle");
    assert.ok(rejected.includes(409), "The authoritative HTTP commit must reject the retired request");
    assert.deepEqual(await f.replies(), [], "No original or failure answer may publish for retired work");
    const fresh = await f.client.postMessage(f.thread.id, { participantId: f.human.id, body: "@agent Fresh request" });
    await eventually(async () => (await privateCursors.getCursor(f.thread.id, f.agent.id)) >= fresh.sequence, "Fresh work did not complete");
    assert.equal(executions, 2);
    assert.deepEqual((await f.replies()).map((message) => message.body), ["Answer 2"]);
  });

  test(`storage commit rejects retirement after service validation but before commit (${kind})`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, kind);
    const stale = await f.client.postMessage(f.thread.id, { participantId: f.human.id, body: "@agent Obsolete request" });
    const entered = deferred(), release = deferred();
    f.releases.push(release.resolve);
    const originalCommit = f.storage.commitResponse.bind(f.storage);
    let holdOnce = true;
    f.storage.commitResponse = async (message, sequence) => {
      if (holdOnce) { holdOnce = false; entered.resolve(); await release.promise; }
      return originalCommit(message, sequence);
    };
    const pending = f.client.postResponse(f.thread.id, f.response(stale, "Obsolete answer"));
    await Promise.race([entered.promise, pending.then(() => assert.fail("Response bypassed storage commit"))]);
    await f.removeAndReadd();
    release.resolve();
    await assert.rejects(pending, (error) => error instanceof ConversationClientError && error.status === 409);
    assert.deepEqual(await f.replies(), []);
    const fresh = await f.client.postMessage(f.thread.id, { participantId: f.human.id, body: "@agent Fresh request" });
    const accepted = await f.client.postResponse(f.thread.id, f.response(fresh, "Fresh answer"));
    assert.equal(accepted.created, true);
    assert.equal(accepted.message.sequence, fresh.sequence + 1, "Rejected commit must not allocate a message sequence");
    assert.deepEqual((await f.replies()).map((message) => message.body), ["Fresh answer"]);
  });

  test(`already-committed response reuse survives thread retirement (${kind})`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, kind);
    const trigger = await f.client.postMessage(f.thread.id, { participantId: f.human.id, body: "@agent Request" });
    const first = await f.client.postResponse(f.thread.id, f.response(trigger, "Committed answer"));
    assert.equal(first.created, true);
    await f.removeAndReadd();
    assert.ok((await f.storage.getCursor(f.thread.id, f.agent.id)) > trigger.sequence);
    const replay = await f.rosterClient.postResponse(f.thread.id, f.response(trigger, "A retry must not replace the answer"));
    assert.equal(replay.created, false);
    assert.equal(replay.message.id, first.message.id);
    assert.equal(replay.message.body, "Committed answer");
    assert.deepEqual((await f.replies()).map((message) => message.body), ["Committed answer"]);
  });
}
