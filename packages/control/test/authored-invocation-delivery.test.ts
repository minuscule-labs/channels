import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationClient, createConversationHttpServer, createResourceId } from "@minu/channels-core";
import { captureAuthoredContext, prepareAuthoredInvocationTurn, AuthoredInvocationDeliveryUnavailableError,
  inspectAuthoredInvocationPublication, publishAuthoredInvocationMessage, prepareLinkedAuthoredInvocationTurn, InMemoryRelayBindingStore, ConversationRuntimeRelay, restoreConversationBindings,
  type AgentConversationBinding, type AgentRuntimePort, type RuntimePortTurn, type AuthoredInvocationPreparation } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";

async function fixture(options: { paused?: boolean; muted?: boolean; memory?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "minu-authored-preparation-"));
  const server = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const relayDatabaseUrl = localRelayLibSqlUrl(join(directory, "relay.db"));
  const store = options.memory ? new InMemoryRelayBindingStore() : await DrizzleLibSqlRelayStorage.open({ url: relayDatabaseUrl });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const member = await client.createIdentity({ type: "human", displayName: "Member" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Worker" });
  const observer = await client.createIdentity({ type: "agent", displayName: "Observer" });
  const workspace = await client.createWorkspace({ slug: "prepare", name: "Prepare" });
  for (const [identity, accessRole] of [[owner, "owner"], [member, "member"], [agent, "member"], [observer, "member"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase(), accessRole });
  }
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id, agent.id, observer.id] });
  const configuration = new LocalAgentHostConfiguration({ client, store });
  const skill = await configuration.createAuthoredDocument(workspace.id, owner.id, {
    kind: "skill", name: "Decision note", description: "Capture the decision", content: "PRIVATE_SELECTED_PROCEDURE_V1\n- Record the decision.",
  });
  await configuration.updateAuthoredDocument(workspace.id, skill.id, owner.id, { action: "publish", expectedVersion: 1 });
  const other = await configuration.createAuthoredDocument(workspace.id, owner.id, {
    kind: "skill", name: "Decision note", description: "Different identity", content: "PRIVATE_UNSELECTED_PROCEDURE",
  });
  await configuration.updateAuthoredDocument(workspace.id, other.id, owner.id, { action: "publish", expectedVersion: 1 });
  const snapshot = await captureAuthoredContext(store, workspace.id, conversation.id);
  const now = new Date().toISOString();
  await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: directory, createdAt: now, updatedAt: now });
  await store.putAgentConfig({ id: "agent-config", workspaceId: workspace.id, agentIdentityId: agent.id, status: "active", createdAt: now, updatedAt: now });
  await store.putBinding({ id: "binding", workspaceAgentConfigId: "agent-config", workspaceId: workspace.id, conversationId: conversation.id,
    agentIdentityId: agent.id, runtimeAdapter: "fixture", runtimeSessionId: "PRIVATE_RUNTIME", runtimeOwnerId: "PRIVATE_OWNER", generation: 1,
    state: options.paused ? "paused" : "connected", wakePolicy: options.muted ? "muted" : "mentions", createdAt: now, updatedAt: now }, { authoredContext: snapshot });
  const receipt = await configuration.acceptAuthoredSkillInvocation(conversation.id, member.id, "request", {
    documentId: skill.id, source: "workspace", revision: 1, arguments: "ACCEPTED_ARGUMENTS: @channel is task text", to: [agent.id],
  });
  const context: AuthoredInvocationPreparation = { workspaceId: workspace.id, conversationId: conversation.id, actorIdentityId: member.id, requestId: "request",
    target: { identityId: agent.id, bindingId: "binding", generation: 1 } };
  return { client, store, relayDatabaseUrl, owner, member, agent, observer, workspace, conversation, skill, configuration, receipt, context, snapshot,
    prepare: (value = context) => prepareAuthoredInvocationTurn(store, client, value),
    async close() { await store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function unavailable(error: unknown): boolean {
  return error instanceof AuthoredInvocationDeliveryUnavailableError && error.message === "Skill invocation delivery is unavailable"
    && !String(error).includes("PRIVATE_");
}

test("private preparation resolves only the accepted revision/arguments without messages, starts or intent mutation", async () => {
  const f = await fixture();
  try {
    const record = await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request");
    const bindings = await f.store.listConversationBindings(f.conversation.id);
    const prepared = await f.prepare();
    assert.equal(prepared.invocationId, f.receipt.id);
    assert.equal(prepared.documentId, f.skill.id);
    assert.equal(prepared.revision, 1);
    assert.equal(prepared.contentHash, record?.contentHash);
    assert.ok(prepared.input.includes("PRIVATE_SELECTED_PROCEDURE_V1\n- Record the decision."));
    assert.match(prepared.input, /ACCEPTED_ARGUMENTS/);
    assert.doesNotMatch(prepared.input, /PRIVATE_UNSELECTED|PRIVATE_RUNTIME|PRIVATE_OWNER/);
    await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, {
      action: "save", expectedVersion: 2, name: "Renamed V2", description: "New publication", content: "PRIVATE_NEW_REVISION_V2",
    });
    await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "publish", expectedVersion: 3 });
    assert.deepEqual(await f.prepare(), prepared, "Preparation must not resolve latest or another same-named skill");
    assert.deepEqual(await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request"), record);
    assert.deepEqual(await f.store.listConversationBindings(f.conversation.id), bindings);
    assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
  } finally { await f.close(); }
});

for (const change of ["archive", "actor_revoked", "recipient_revoked", "agent_disabled", "paused", "muted", "generation"] as const) {
  test(`private preparation blocks ${change} without restarting or silently retargeting`, async () => {
    const f = await fixture({ paused: change === "paused", muted: change === "muted" });
    try {
      if (change === "archive") await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
      if (change === "actor_revoked" || change === "recipient_revoked") {
        await f.client.updateWorkspaceMember(f.workspace.id, change === "actor_revoked" ? f.member.id : f.agent.id,
          { actorIdentityId: f.owner.id, status: "disabled" });
      }
      if (change === "agent_disabled") await f.store.putAgentConfig({ ...(await f.store.getAgentConfig("agent-config"))!, status: "disabled" });
      if (change === "generation") await f.store.replaceBindingSession("binding", 1, "fixture", "PRIVATE_REPLACEMENT", new Date().toISOString(), "PRIVATE_OWNER",
        { authoredContext: f.snapshot });
      const bindings = await f.store.listConversationBindings(f.conversation.id);
      const record = await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request");
      await assert.rejects(f.prepare(), unavailable);
      assert.deepEqual(await f.store.listConversationBindings(f.conversation.id), bindings);
      assert.deepEqual(await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request"), record);
      assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
    } finally { await f.close(); }
  });
}

for (const race of ["archive", "actor_revoked"] as const) {
  test(`private preparation rechecks ${race} after the pinned body read`, async () => {
    const f = await fixture();
    try {
      const read = f.store.listAuthoredDocumentRevisions.bind(f.store);
      let changed = false;
      f.store.listAuthoredDocumentRevisions = async (...args) => {
        const result = await read(...args);
        if (!changed && args[1] === f.skill.id) {
          changed = true;
          if (race === "archive") await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
          else await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
        }
        return result;
      };
      await assert.rejects(f.prepare(), unavailable);
      assert.equal(changed, true);
      assert.equal((await f.store.getBinding("binding"))?.generation, 1);
      assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
    } finally { await f.close(); }
  });
}

test("private preparation rejects forged scope/target selectors rather than trusting copied references", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { workspaceId: "foreign" }, { conversationId: "other-conversation" }, { actorIdentityId: f.owner.id }, { requestId: f.receipt.id },
      { target: { ...f.context.target, identityId: f.owner.id } }, { target: { ...f.context.target, bindingId: "wrong-binding" } },
      { target: { ...f.context.target, generation: 2 } },
    ]) await assert.rejects(f.prepare({ ...f.context, ...change }), unavailable);
    assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
  } finally { await f.close(); }
});

for (const failure of ["missing", "corrupt", "raw_error"] as const) {
  test(`private preparation fails closed on ${failure} publication without raw errors or bare-message fallback`, async () => {
    const f = await fixture();
    try {
      const read = f.store.listAuthoredDocumentRevisions.bind(f.store);
      f.store.listAuthoredDocumentRevisions = async (...args) => {
        if (failure === "raw_error") throw new Error("PRIVATE_RAW_STORAGE_ERROR");
        if (failure === "missing") return [];
        return (await read(...args)).map(row => ({ ...row, content: "PRIVATE_CORRUPTED_BODY" }));
      };
      await assert.rejects(f.prepare(), unavailable);
      assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
    } finally { await f.close(); }
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function fakeRuntime() {
  const turns = new Map<string, RuntimePortTurn>();
  const prompts: string[] = [];
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; },
    async messages() { return []; },
    async send() { throw new Error("Legacy send must not run"); },
    async interrupt() {},
    async getManagedSession(id, ownerId) { return { id, ownerId, state: "active" }; },
    async resume(id, ownerId) { return { id, ownerId }; },
    async turn(_session, turnId) { return turns.get(turnId); },
    async startTurn(_session, turnId, input) {
      prompts.push(input);
      const now = new Date().toISOString();
      const turn: RuntimePortTurn = { id: turnId, status: "completed", input, response: { role: "assistant", content: "Decision captured" }, createdAt: now, updatedAt: now };
      turns.set(turnId, turn);
      return turn;
    },
  };
  return { runtime, prompts, turns };
}

function deliveryRelay(f: Fixture, runtime: AgentRuntimePort, binding: Partial<AgentConversationBinding> = {}) {
  return new ConversationRuntimeRelay({
    client: f.client, conversationId: f.conversation.id, cursorStore: f.store, turnPollIntervalMs: 5,
    bindings: [{ participantId: f.agent.id, sessionId: "PRIVATE_RUNTIME", runtime,
      verifyLease: async () => true,
      prepareAuthoredTurn: async message => (await prepareLinkedAuthoredInvocationTurn(f.store, f.client, message, f.context.target))?.input,
      ...binding }],
  });
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await assertion()) {
    if (Date.now() >= deadline) throw new Error("Delivery condition was not met");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const memory of [false, true]) {
  test(`${memory ? "memory" : "sqlite"}: immutable private message links precede public publication and cannot be rebound`, async () => {
    const f = await fixture({ memory });
    try {
      const before = await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request");
      const post = f.client.postMessage.bind(f.client);
      let observed = false;
      f.client.postMessage = async (conversationId, input, options) => {
        assert.equal((await f.store.getAuthoredSkillInvocationForMessage(conversationId, input.id!))?.id, f.receipt.id);
        assert.doesNotMatch(JSON.stringify(input), /PRIVATE_SELECTED|PRIVATE_UNSELECTED|PRIVATE_RUNTIME|PRIVATE_OWNER/);
        observed = true;
        return post(conversationId, input, options);
      };
      const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
      assert.equal(observed, true);
      assert.equal(message.authoredInvocationId, f.receipt.id);
      assert.equal(message.body, before!.arguments);
      assert.deepEqual(message.to, [f.agent.id], "Argument mentions must not change recipients");
      assert.deepEqual(await publishAuthoredInvocationMessage(f.store, f.client, f.context), message);
      assert.deepEqual(await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request"), before);
      assert.equal((await f.client.listMessages(f.conversation.id)).length, 1);
      const link = await f.store.getAuthoredInvocationMessageLink(f.receipt.id);
      assert.deepEqual(await f.store.reserveAuthoredInvocationMessageLink({ invocationId: f.receipt.id, messageId: createResourceId("message") }), link);
      assert.equal(await f.store.reserveAuthoredInvocationMessageLink({ invocationId: "absent", messageId: createResourceId("message") }), undefined);
      const second = await f.configuration.acceptAuthoredSkillInvocation(f.conversation.id, f.member.id, "second", {
        documentId: f.skill.id, source: "workspace", revision: 1, arguments: "Another request", to: [f.agent.id],
      });
      assert.equal(await f.store.reserveAuthoredInvocationMessageLink({ invocationId: second.id, messageId: message.id }), undefined);
      assert.equal(await f.store.getAuthoredSkillInvocationForMessage("other-conversation", message.id), undefined);
      const publicConversation = await f.client.getConversation(f.conversation.id);
      const thread = await f.client.createThread(f.conversation.id, { actorIdentityId: f.member.id, rootMessageId: message.id });
      assert.doesNotMatch(JSON.stringify([publicConversation, thread]), /PRIVATE_SELECTED|PRIVATE_UNSELECTED|PRIVATE_RUNTIME|PRIVATE_OWNER/);
    } finally { await f.close(); }
  });
}

test("only a trusted exact public message can assemble a procedure; copied, stripped or altered references fail closed", async () => {
  const f = await fixture();
  try {
    const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    assert.match((await prepareLinkedAuthoredInvocationTurn(f.store, f.client, message, f.context.target))!.input, /PRIVATE_SELECTED_PROCEDURE_V1/);
    for (const change of [
      { id: createResourceId("message") }, { authoredInvocationId: undefined }, { authoredInvocationId: "copied" },
      { body: "changed" }, { participantId: f.owner.id }, { to: [f.owner.id] }, { replyTo: message.id },
      { conversationId: "other-conversation" },
    ]) await assert.rejects(prepareLinkedAuthoredInvocationTurn(f.store, f.client, { ...message, ...change }, f.context.target), unavailable);
    const ordinary = await f.client.postMessage(f.conversation.id, { participantId: f.member.id, to: [], body: message.body });
    assert.equal(await prepareLinkedAuthoredInvocationTurn(f.store, f.client, ordinary, f.context.target), undefined);
  } finally { await f.close(); }
});

function prohibitInspectionEffects(client: ConversationClient, store: Fixture["store"]) {
  let effects = 0;
  const prohibited = async () => { effects += 1; throw new Error("PRIVATE_UNEXPECTED_INSPECTION_EFFECT"); };
  client.postMessage = prohibited;
  client.postResponse = prohibited;
  store.reserveAuthoredInvocationMessageLink = prohibited;
  store.reserveAuthoredSkillInvocation = prohibited;
  store.acquireBindingLease = prohibited;
  store.renewBindingLease = prohibited;
  store.putBinding = prohibited;
  store.setCursor = prohibited;
  store.getAuthoredDocument = prohibited;
  store.listAuthoredDocumentRevisions = prohibited;
  return () => assert.equal(effects, 0, "Inspection must not publish, reserve, renew, change queues/sessions or resolve procedure bodies");
}

for (const memory of [false, true]) {
  test(`publication inspection ${memory ? "memory" : "sqlite"}: resolves lost Core acknowledgment after retirement without sending; SQLite survives reopen`, async () => {
    const f = await fixture({ memory });
    let reopened: DrizzleLibSqlRelayStorage | undefined;
    try {
      const post = f.client.postMessage.bind(f.client);
      let posts = 0;
      f.client.postMessage = async (...args) => { posts += 1; await post(...args); throw new Error("PRIVATE_CORE_ACK_LOST"); };
      await assert.rejects(publishAuthoredInvocationMessage(f.store, f.client, f.context), unavailable);
      assert.equal(posts, 1);
      const original = (await f.client.listMessages(f.conversation.id))[0]!;
      await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
      if (!memory) {
        await f.store.close();
        reopened = await DrizzleLibSqlRelayStorage.open({ url: f.relayDatabaseUrl });
      }
      const store = reopened ?? f.store;
      const operation = await store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request");
      const link = await store.getAuthoredInvocationMessageLink(f.receipt.id);
      const bindings = await store.listConversationBindings(f.conversation.id);
      const assertNoEffects = prohibitInspectionEffects(f.client, store);
      const expected = { invocationId: f.receipt.id, status: "observed", messageId: original.id };
      assert.deepEqual(await inspectAuthoredInvocationPublication(store, f.client, f.context), expected);
      assert.deepEqual(await inspectAuthoredInvocationPublication(store, f.client, f.context), expected);
      assertNoEffects();
      assert.equal(posts, 1);
      assert.deepEqual(await store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request"), operation);
      assert.deepEqual(await store.getAuthoredInvocationMessageLink(f.receipt.id), link);
      assert.deepEqual(await store.listConversationBindings(f.conversation.id), bindings);
      assert.deepEqual((await f.client.listMessages(f.conversation.id)).map(message => message.id), [original.id]);
      assert.doesNotMatch(JSON.stringify(expected), /PRIVATE_|arguments|contentHash|binding|generation|input/);
    } finally { await reopened?.close(); await f.close(); }
  });

  test(`publication inspection ${memory ? "memory" : "sqlite"}: lost link acknowledgment retains not-observed association after retirement`, async () => {
    const f = await fixture({ memory });
    try {
      const reserve = f.store.reserveAuthoredInvocationMessageLink.bind(f.store);
      let reservations = 0;
      f.store.reserveAuthoredInvocationMessageLink = async link => {
        reservations += 1;
        await reserve(link);
        throw new Error("PRIVATE_LINK_ACK_LOST");
      };
      await assert.rejects(publishAuthoredInvocationMessage(f.store, f.client, f.context), unavailable);
      const link = (await f.store.getAuthoredInvocationMessageLink(f.receipt.id))!;
      await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
      const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
      assert.deepEqual(await inspectAuthoredInvocationPublication(f.store, f.client, f.context),
        { invocationId: f.receipt.id, status: "not_observed", messageId: link.messageId });
      assertNoEffects();
      assert.equal(reservations, 1);
      assert.deepEqual(await f.store.getAuthoredInvocationMessageLink(f.receipt.id), link);
      assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
    } finally { await f.close(); }
  });
}

test("publication inspection ignores copied public metadata and never reconstructs or replaces a private association", async () => {
  const f = await fixture();
  try {
    const operation = (await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request"))!;
    const copied = await f.client.postMessage(f.conversation.id, {
      participantId: f.member.id, authoredInvocationId: f.receipt.id, to: [f.agent.id], body: operation.arguments,
    });
    const reserve = f.store.reserveAuthoredInvocationMessageLink.bind(f.store);
    const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
    assert.deepEqual(await inspectAuthoredInvocationPublication(f.store, f.client, f.context), { invocationId: f.receipt.id, status: "not_linked" });
    const messageId = createResourceId("message");
    // Explicit fixture setup, not an inspection/retry: reserve a different original ID.
    await reserve({ invocationId: f.receipt.id, messageId });
    assert.deepEqual(await inspectAuthoredInvocationPublication(f.store, f.client, f.context),
      { invocationId: f.receipt.id, status: "not_observed", messageId });
    assertNoEffects();
    assert.notEqual(messageId, copied.id);
    assert.deepEqual((await f.client.listMessages(f.conversation.id)).map(message => message.id), [copied.id]);
    assert.deepEqual(await f.store.getAuthoredSkillInvocation(f.conversation.id, f.member.id, "request"), operation);
  } finally { await f.close(); }
});

test("publication inspection denies revoked human access before private reads, preserving the original operation/link", async () => {
  const f = await fixture();
  try {
    await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    const read = f.store.getAuthoredSkillInvocation.bind(f.store);
    const operation = await read(f.conversation.id, f.member.id, "request");
    const link = await f.store.getAuthoredInvocationMessageLink(f.receipt.id);
    await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
    let privateReads = 0;
    f.store.getAuthoredSkillInvocation = async (...args) => { privateReads += 1; return read(...args); };
    const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
    await assert.rejects(inspectAuthoredInvocationPublication(f.store, f.client, f.context), unavailable);
    assertNoEffects();
    assert.equal(privateReads, 0);
    assert.deepEqual(await read(f.conversation.id, f.member.id, "request"), operation);
    assert.deepEqual(await f.store.getAuthoredInvocationMessageLink(f.receipt.id), link);
    assert.equal((await f.client.listMessages(f.conversation.id)).length, 1);
  } finally { await f.close(); }
});

for (const boundary of ["private_link", "public_snapshot"] as const) {
  test(`publication inspection rechecks human access after ${boundary} I/O instead of returning a stale observation`, async () => {
    const f = await fixture();
    try {
      await publishAuthoredInvocationMessage(f.store, f.client, f.context);
      const read = f.store.getAuthoredInvocationMessageLink.bind(f.store);
      const list = f.client.listMessages.bind(f.client);
      const link = await read(f.receipt.id);
      let changed = false;
      const revoke = async () => {
        if (!changed) {
          changed = true;
          await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
        }
      };
      if (boundary === "private_link") {
        f.store.getAuthoredInvocationMessageLink = async id => { const result = await read(id); await revoke(); return result; };
      } else {
        f.client.listMessages = async (...args) => { const result = await list(...args); await revoke(); return result; };
      }
      const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
      await assert.rejects(inspectAuthoredInvocationPublication(f.store, f.client, f.context), unavailable);
      assert.equal(changed, true);
      assertNoEffects();
      assert.deepEqual(await read(f.receipt.id), link);
      assert.equal((await list(f.conversation.id)).length, 1);
    } finally { await f.close(); }
  });
}

test("publication inspection of prior recipient delivery history remains readable without authorizing revoked recipients", async () => {
  const f = await fixture();
  try {
    const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    await f.client.updateWorkspaceMember(f.workspace.id, f.agent.id, { actorIdentityId: f.owner.id, status: "disabled" });
    const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
    assert.deepEqual(await inspectAuthoredInvocationPublication(f.store, f.client, f.context),
      { invocationId: f.receipt.id, status: "observed", messageId: message.id });
    assertNoEffects();
    assert.equal((await f.client.listMessages(f.conversation.id)).length, 1);
  } finally { await f.close(); }
});

test("publication inspection rejects foreign actors/scopes/request selectors rather than selecting by public invocation ID", async () => {
  const f = await fixture();
  try {
    await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
    for (const change of [{ workspaceId: "foreign" }, { conversationId: "foreign" }, { actorIdentityId: f.owner.id }, { requestId: f.receipt.id }]) {
      await assert.rejects(inspectAuthoredInvocationPublication(f.store, f.client, { ...f.context, ...change }), unavailable);
    }
    assertNoEffects();
    assert.equal((await f.client.listMessages(f.conversation.id)).length, 1);
  } finally { await f.close(); }
});

test("publication inspection fails closed on an altered original message or corrupt link, not as an absent publication", async () => {
  const f = await fixture();
  try {
    const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    const list = f.client.listMessages.bind(f.client);
    const read = f.store.getAuthoredInvocationMessageLink.bind(f.store);
    const link = (await read(f.receipt.id))!;
    const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
    for (const change of [{ body: "PRIVATE_ALTERED_BODY" }, { authoredInvocationId: undefined }, { to: [f.owner.id] }]) {
      f.client.listMessages = async (...args) => (await list(...args)).map(row => row.id === message.id ? { ...row, ...change } : row);
      await assert.rejects(inspectAuthoredInvocationPublication(f.store, f.client, f.context), unavailable);
    }
    f.client.listMessages = list;
    for (const change of [{ invocationId: "other" }, { messageId: "invalid" }]) {
      f.store.getAuthoredInvocationMessageLink = async () => ({ ...link, ...change });
      await assert.rejects(inspectAuthoredInvocationPublication(f.store, f.client, f.context), unavailable);
    }
    assertNoEffects();
    assert.deepEqual(await read(f.receipt.id), link);
    assert.equal((await f.client.listMessages(f.conversation.id)).length, 1);
  } finally { await f.close(); }
});

for (const failure of ["private_link", "public_snapshot"] as const) {
  test(`publication inspection ${failure} read failure is unavailable, never inferred absence or a resend`, async () => {
    const f = await fixture();
    try {
      await publishAuthoredInvocationMessage(f.store, f.client, f.context);
      const list = f.client.listMessages.bind(f.client);
      if (failure === "private_link") f.store.getAuthoredInvocationMessageLink = async () => { throw new Error("PRIVATE_LINK_READ_ERROR"); };
      else f.client.listMessages = async () => { throw new Error("PRIVATE_CORE_READ_ERROR"); };
      const assertNoEffects = prohibitInspectionEffects(f.client, f.store);
      await assert.rejects(inspectAuthoredInvocationPublication(f.store, f.client, f.context), unavailable);
      assertNoEffects();
      assert.equal((await list(f.conversation.id)).length, 1);
    } finally { await f.close(); }
  });
}

test("lost private-link acknowledgment performs no Core send and explicit retry keeps the committed message ID", async () => {
  const f = await fixture();
  try {
    const reserve = f.store.reserveAuthoredInvocationMessageLink.bind(f.store);
    let writes = 0;
    f.store.reserveAuthoredInvocationMessageLink = async link => {
      writes += 1;
      await reserve(link);
      throw new Error("PRIVATE_LINK_ACK_LOST");
    };
    await assert.rejects(publishAuthoredInvocationMessage(f.store, f.client, f.context), unavailable);
    assert.equal(writes, 1);
    assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
    const committed = await f.store.getAuthoredInvocationMessageLink(f.receipt.id);
    assert.ok(committed);
    f.store.reserveAuthoredInvocationMessageLink = reserve;
    assert.equal((await publishAuthoredInvocationMessage(f.store, f.client, f.context)).id, committed.messageId);
  } finally { await f.close(); }
});

test("concurrent private publishers preserve one durable link and one Core message", async () => {
  const f = await fixture();
  const other = await DrizzleLibSqlRelayStorage.open({ url: f.relayDatabaseUrl });
  try {
    const results = await Promise.allSettled([publishAuthoredInvocationMessage(f.store, f.client, f.context),
      publishAuthoredInvocationMessage(other, f.client, f.context)]);
    assert.ok(results.some(result => result.status === "fulfilled"));
    const link = await f.store.getAuthoredInvocationMessageLink(f.receipt.id);
    assert.ok(link);
    for (const result of results) {
      if (result.status === "fulfilled") assert.equal(result.value.id, link.messageId);
      else assert.ok(unavailable(result.reason));
    }
    assert.equal((await f.client.listMessages(f.conversation.id)).length, 1);
  } finally { await other.close(); await f.close(); }
});

test("lost Core publication acknowledgment keeps a durable link and exact retry publishes no duplicate after reopen", async () => {
  const f = await fixture();
  let reopened: DrizzleLibSqlRelayStorage | undefined;
  try {
    const post = f.client.postMessage.bind(f.client);
    let posts = 0;
    f.client.postMessage = async (...args) => {
      posts += 1;
      await post(...args);
      throw new Error("PRIVATE_LOST_ACK");
    };
    await assert.rejects(publishAuthoredInvocationMessage(f.store, f.client, f.context), unavailable);
    assert.equal(posts, 1, "No automatic mutation retry");
    const first = (await f.client.listMessages(f.conversation.id))[0]!;
    await f.store.close();
    reopened = await DrizzleLibSqlRelayStorage.open({ url: f.relayDatabaseUrl });
    f.client.postMessage = post;
    const replay = await publishAuthoredInvocationMessage(reopened, f.client, f.context);
    assert.equal(replay.id, first.id);
    assert.equal((await reopened.getAuthoredSkillInvocationForMessage(f.conversation.id, first.id))?.id, f.receipt.id);
    assert.equal((await f.client.listMessages(f.conversation.id)).length, 1);
  } finally { await reopened?.close(); await f.close(); }
});

test("Relay delivers the pinned procedure privately through a restored addressed binding, never to an all_messages observer", async () => {
  const f = await fixture();
  const r = fakeRuntime();
  let restored: Awaited<ReturnType<typeof restoreConversationBindings>> | undefined;
  let relay: ConversationRuntimeRelay | undefined;
  try {
    const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    restored = await restoreConversationBindings({ client: f.client, store: f.store, conversationId: f.conversation.id,
      leaseOwner: "test-host", runtimes: { fixture: r.runtime } });
    assert.equal(restored.bindings.length, 1);
    assert.ok(restored.bindings[0]!.prepareAuthoredTurn);
    const observer = fakeRuntime();
    relay = new ConversationRuntimeRelay({
      client: f.client, conversationId: f.conversation.id, cursorStore: f.store, turnPollIntervalMs: 5,
      bindings: [...restored.bindings, { participantId: f.observer.id, sessionId: "observer", runtime: observer.runtime, wakePolicy: "all_messages" }],
    });
    await relay.start();
    await waitFor(async () => (await f.store.getCursor(f.conversation.id, f.agent.id)) >= message.sequence);
    assert.equal(r.prompts.length, 1);
    assert.match(r.prompts[0]!, /PRIVATE_SELECTED_PROCEDURE_V1/);
    assert.match(r.prompts[0]!, /ACCEPTED_ARGUMENTS/);
    assert.doesNotMatch(r.prompts[0]!, /PRIVATE_UNSELECTED/);
    assert.equal(observer.prompts.length, 0);
    assert.doesNotMatch(JSON.stringify(await f.client.listMessages(f.conversation.id)), /PRIVATE_SELECTED|PRIVATE_UNSELECTED/);
  } finally { await relay?.stop(); await restored?.close(); await f.close(); }
});

for (const change of ["archive", "actor_revoked", "stop"] as const) {
  test(`Relay rechecks ${change} after waiting for an idle Runtime, never sending bare arguments`, async () => {
    const f = await fixture();
    const r = fakeRuntime();
    let busy = true;
    let waited = false;
    r.runtime.status = async () => { waited = true; return busy ? "working" : "idle"; };
    const relay = deliveryRelay(f, r.runtime);
    try {
      const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
      await relay.start();
      await waitFor(async () => waited);
      if (change === "archive") await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
      else if (change === "actor_revoked") await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
      else await f.store.disableBinding("binding", 1, new Date().toISOString());
      busy = false;
      await waitFor(async () => (await f.store.getCursor(f.conversation.id, f.agent.id)) >= message.sequence);
      assert.deepEqual(r.prompts, []);
    } finally { busy = false; await relay.stop(); await f.close(); }
  });
}

for (const change of ["archive", "actor_revoked"] as const) {
  test(`Relay blocks late ${change} during the final lease wait before Runtime admission`, async () => {
    const f = await fixture();
    const r = fakeRuntime();
    let restored: Awaited<ReturnType<typeof restoreConversationBindings>> | undefined;
    let relay: ConversationRuntimeRelay | undefined;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let prepared = false;
    let leaseWaiting = false;
    let legacySends = 0;
    r.runtime.send = async () => { legacySends += 1; throw new Error("No legacy fallback"); };
    try {
      restored = await restoreConversationBindings({
        client: f.client, store: f.store, conversationId: f.conversation.id,
        leaseOwner: "late-admission-host", runtimes: { fixture: r.runtime },
      });
      assert.equal(restored.bindings.length, 1);
      const binding = restored.bindings[0]!;
      const prepare = binding.prepareAuthoredTurn!;
      const verifyLease = binding.verifyLease!;
      binding.prepareAuthoredTurn = async message => {
        const result = await prepare(message);
        prepared = true;
        return result;
      };
      binding.verifyLease = async () => {
        if (prepared && !leaseWaiting) { leaseWaiting = true; await blocked; }
        return verifyLease();
      };
      const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
      relay = new ConversationRuntimeRelay({
        client: f.client, conversationId: f.conversation.id, cursorStore: f.store,
        turnPollIntervalMs: 5, bindings: restored.bindings,
      });
      await relay.start();
      await waitFor(async () => leaseWaiting);
      assert.equal(r.prompts.length, 0);
      if (change === "archive") {
        await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
        assert.equal((await f.store.getAuthoredDocument(f.workspace.id, f.skill.id))?.state, "archived");
      } else {
        await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
        assert.equal((await f.client.listWorkspaceMembers(f.workspace.id)).find(member => member.identityId === f.member.id)?.status, "disabled");
      }
      assert.equal(r.prompts.length, 0, "The policy change must finish before any Runtime start");
      release();
      await waitFor(async () => (await f.store.getCursor(f.conversation.id, f.agent.id)) >= message.sequence);
      assert.equal(r.prompts.length, 0, "Do not dispatch stale prepared input after the lease wait");
      assert.equal(r.turns.size, 0);
      assert.equal(legacySends, 0);
      assert.equal((await f.store.getBinding("binding"))?.generation, 1, "No replacement session");
      assert.doesNotMatch(JSON.stringify(await f.client.listMessages(f.conversation.id)), /PRIVATE_SELECTED|PRIVATE_UNSELECTED/);
    } finally { release(); await relay?.stop(); await restored?.close(); await f.close(); }
  });
}

for (const scenario of ["takeover", "expired"] as const) {
  test(`Relay lease-aware final preparation blocks ${scenario} before Runtime start`, async () => {
    const f = await fixture();
    const r = fakeRuntime();
    let clock = Date.now();
    let restored: Awaited<ReturnType<typeof restoreConversationBindings>> | undefined;
    let relay: ConversationRuntimeRelay | undefined;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let preparationCalls = 0;
    let finalPreparationWaiting = false;
    let legacySends = 0;
    r.runtime.send = async () => { legacySends += 1; throw new Error("No legacy fallback"); };
    try {
      restored = await restoreConversationBindings({
        client: f.client, store: f.store, conversationId: f.conversation.id, leaseOwner: "old-host",
        runtimes: { fixture: r.runtime }, now: () => new Date(clock),
      });
      assert.equal(restored.bindings.length, 1);
      const binding = restored.bindings[0]!;
      const prepare = binding.prepareAuthoredTurn!;
      const verifyLease = binding.verifyLease!;
      binding.prepareAuthoredTurn = async message => {
        preparationCalls += 1;
        if (preparationCalls === 2) { finalPreparationWaiting = true; await blocked; }
        return prepare(message);
      };
      const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
      relay = new ConversationRuntimeRelay({
        client: f.client, conversationId: f.conversation.id, cursorStore: f.store,
        turnPollIntervalMs: 5, bindings: restored.bindings,
      });
      await relay.start();
      await waitFor(async () => finalPreparationWaiting);
      assert.equal(r.prompts.length, 0);
      const previous = (await f.store.getBinding("binding"))!;
      assert.equal(previous.leaseOwner, "old-host");
      clock = Date.parse(previous.leaseExpiresAt!) + (scenario === "takeover" ? 1 : 0);
      if (scenario === "takeover") {
        const replacement = await f.store.acquireBindingLease("binding", "new-host",
          new Date(clock).toISOString(), new Date(clock + 30_000).toISOString(), { generation: 1, state: "connected" });
        assert.equal(replacement?.leaseOwner, "new-host");
        assert.equal(replacement?.generation, 1, "Lease takeover must not require a session replacement");
      } else {
        assert.equal((await f.store.getBinding("binding"))?.leaseOwner, "old-host");
      }
      assert.equal(await verifyLease(), false, "The old host's real restored lease verifier rejects expired/lost ownership");
      assert.equal(r.prompts.length, 0, "Lease loss must complete before any Runtime start");
      release();
      await waitFor(async () => r.prompts.length > 0 || relay!.activity(f.agent.id) === undefined);
      assert.equal(r.prompts.length, 0, "An expired or superseded owner cannot dispatch private input");
      assert.equal(r.turns.size, 0);
      assert.equal(legacySends, 0);
      assert.deepEqual((await f.client.listMessages(f.conversation.id)).map(row => row.id), [message.id],
        "The fenced old host must not publish a response/failure either");
    } finally { release(); await relay?.stop(); await restored?.close(); await f.close(); }
  });
}

for (const memory of [false, true]) {
  test(`${memory ? "memory" : "sqlite"}: lease-aware preparation requires the expected owner and strictly live expiry without renewal`, async () => {
    const f = await fixture({ memory });
    try {
      const clock = Date.now();
      const expiry = clock + 30_000;
      const claimed = await f.store.acquireBindingLease("binding", "expected-host", new Date(clock).toISOString(), new Date(expiry).toISOString());
      assert.ok(claimed);
      const context = { ...f.context, lease: { owner: "expected-host", now: () => new Date(clock) } };
      assert.match((await f.prepare(context)).input, /PRIVATE_SELECTED_PROCEDURE_V1/);
      await assert.rejects(f.prepare({ ...context, lease: { owner: "other-host", now: context.lease.now } }), unavailable);
      await assert.rejects(f.prepare({ ...context, lease: { ...context.lease, now: () => new Date(expiry) } }), unavailable);
      assert.deepEqual(await f.store.getBinding("binding"), claimed, "Validation must not renew or bless another owner's lease");
      await f.store.releaseBindingLease("binding", 1, "expected-host");
      await assert.rejects(f.prepare(context), unavailable);
      assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
    } finally { await f.close(); }
  });
}

test("lease loss during private preparation fences the final send", async () => {
  const f = await fixture();
  const r = fakeRuntime();
  let prepared = false;
  const relay = deliveryRelay(f, r.runtime, {
    verifyLease: async () => !prepared,
    prepareAuthoredTurn: async message => {
      const input = (await prepareLinkedAuthoredInvocationTurn(f.store, f.client, message, f.context.target))?.input;
      prepared = true;
      return input;
    },
  });
  try {
    await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    await relay.start();
    await waitFor(async () => prepared);
    await relay.stop();
    assert.deepEqual(r.prompts, []);
  } finally { await relay.stop(); await f.close(); }
});

test("Stop while the final private preparation is in flight prevents Runtime admission", async () => {
  const f = await fixture();
  const r = fakeRuntime();
  let preparing = false;
  let stopping = false;
  let stopStatusPending = false;
  let releaseStatus!: () => void;
  const statusBlocked = new Promise<void>(resolve => { releaseStatus = resolve; });
  r.runtime.status = async () => {
    if (stopping) { stopStatusPending = true; await statusBlocked; }
    return "idle";
  };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const relay = deliveryRelay(f, r.runtime, {
    prepareAuthoredTurn: async message => {
      preparing = true;
      await blocked;
      return (await prepareLinkedAuthoredInvocationTurn(f.store, f.client, message, f.context.target))?.input;
    },
  });
  try {
    await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    await relay.start();
    await waitFor(async () => preparing);
    stopping = true;
    const stopped = relay.stopBinding(f.agent.id, f.member.id);
    await waitFor(async () => stopStatusPending);
    release();
    await waitFor(async () => relay.activity(f.agent.id) === undefined);
    assert.deepEqual(r.prompts, [], "Stop intent fences admission even before its status check returns");
    releaseStatus();
    await stopped;
  } finally { release(); releaseStatus(); await relay.stop(); await f.close(); }
});

for (const boundary of ["forged", "missing-resolver", "legacy"] as const) {
  test(`Relay rejects ${boundary} authored delivery without plain-text/native fallback`, async () => {
    const f = await fixture();
    const r = fakeRuntime();
    if (boundary === "legacy") { delete r.runtime.startTurn; delete r.runtime.turn; }
    const relay = deliveryRelay(f, r.runtime, boundary === "missing-resolver" ? { prepareAuthoredTurn: undefined } : {});
    try {
      const message = boundary === "forged"
        ? await f.client.postMessage(f.conversation.id, { authoredInvocationId: f.receipt.id, participantId: f.member.id, to: [f.agent.id], body: "Copied public metadata" })
        : await publishAuthoredInvocationMessage(f.store, f.client, f.context);
      await relay.start();
      await waitFor(async () => (await f.store.getCursor(f.conversation.id, f.agent.id)) >= message.sequence);
      assert.deepEqual(r.prompts, []);
      assert.doesNotMatch(JSON.stringify(await f.client.listMessages(f.conversation.id)), /PRIVATE_SELECTED|PRIVATE_UNSELECTED/);
    } finally { await relay.stop(); await f.close(); }
  });
}

test("retirement does not interrupt an already accepted running turn", async () => {
  const f = await fixture();
  const r = fakeRuntime();
  let interrupts = 0;
  r.runtime.interrupt = async () => { interrupts += 1; };
  const start = r.runtime.startTurn!;
  r.runtime.startTurn = async (...args) => {
    const turn = await start(...args);
    const running: RuntimePortTurn = { ...turn, status: "running", response: undefined };
    r.turns.set(turn.id, running);
    return running;
  };
  const relay = deliveryRelay(f, r.runtime);
  try {
    const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    await relay.start();
    await waitFor(async () => r.prompts.length === 1);
    await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
    const turn = [...r.turns.values()][0]!;
    r.turns.set(turn.id, { ...turn, status: "completed", response: { role: "assistant", content: "Decision captured" } });
    await waitFor(async () => (await f.store.getCursor(f.conversation.id, f.agent.id)) >= message.sequence);
    assert.equal(interrupts, 0);
    assert.equal(r.prompts.length, 1);
  } finally { await relay.stop(); await f.close(); }
});

test("uncertain Runtime start is reconciled by the same turn ID after retirement, without a second start", async () => {
  const f = await fixture();
  const r = fakeRuntime();
  const start = r.runtime.startTurn!;
  r.runtime.startTurn = async (...args) => {
    await start(...args);
    await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
    throw new Error("PRIVATE_RUNTIME_ACK_LOST");
  };
  const relay = deliveryRelay(f, r.runtime);
  try {
    const message = await publishAuthoredInvocationMessage(f.store, f.client, f.context);
    await relay.start();
    await waitFor(async () => (await f.store.getCursor(f.conversation.id, f.agent.id)) >= message.sequence);
    assert.equal(r.prompts.length, 1);
    assert.equal(r.turns.size, 1);
    assert.equal((await f.client.listMessages(f.conversation.id)).filter(row => row.body === "Decision captured").length, 1);
  } finally { await relay.stop(); await f.close(); }
});
