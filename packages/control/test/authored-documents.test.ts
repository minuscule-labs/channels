import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createConversationHttpServer, createResourceId } from "@minu/channels-core";
import { ConversationClient } from "@minu/channels-core/client";
import { captureAuthoredContext, publishAuthoredInvocationMessage, ConversationRuntimeRelay, restoreConversationBindings, type AgentRuntimePort, type RuntimePortTurn } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalControlClient } from "../src/client.ts";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import type { LocalAuthoredDocument, LocalAuthoredDocumentRevision, LocalAuthoredDocumentSummary, LocalConversationAuthoredContext, LocalAuthoredSkillInvocationReceipt, LocalAuthoredSkillInvocationPublicationReceipt } from "../src/contracts.ts";
import { createLocalControlHttpServer, LocalControlBrowserSessions, LocalControlService, type LocalControlAuditEvent } from "../src/server.ts";

async function fixture(options: { publicationEnabled?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "minu-authored-http-"));
  const publicServer = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(publicServer.endpoint, { serviceToken: publicServer.serviceToken });
  const relayDatabaseUrl = localRelayLibSqlUrl(join(directory, "relay.db"));
  const store = await DrizzleLibSqlRelayStorage.open({ url: relayDatabaseUrl });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const admin = await client.createIdentity({ type: "human", displayName: "Admin" });
  const member = await client.createIdentity({ type: "human", displayName: "Member" });
  const outsider = await client.createIdentity({ type: "human", displayName: "Outsider" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
  const workspace = await client.createWorkspace({ slug: "authored", name: "Authored" });
  const otherWorkspace = await client.createWorkspace({ slug: "other-authored", name: "Other" });
  for (const w of [workspace, otherWorkspace]) {
    await client.addWorkspaceMember(w.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  }
  for (const [identity, accessRole] of [[admin, "admin"], [member, "member"], [agent, "member"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase(), accessRole });
  }
  const channel = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
  const otherChannel = await client.createConversation({ workspaceId: otherWorkspace.id, participantIds: [owner.id] });
  const audit: LocalControlAuditEvent[] = [];
  const configuration = new LocalAgentHostConfiguration({ client, store, onAudit: (event) => audit.push(event) });
  const service = new LocalControlService({ conversations: client, bindings: store, runtimes: {}, configuration, authoredSkillPublicationEnabled: options.publicationEnabled });
  const servers: Array<Awaited<ReturnType<typeof createLocalControlHttpServer>>> = [];
  async function login(identityId: string, options: { now?: () => Date; sessionTtlMs?: number } = {}) {
    const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: identityId, ...options });
    const server = await createLocalControlHttpServer({ service, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], port: 0 });
    servers.push(server);
    const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const headers = { cookie, origin: sessions.browserOrigin, "content-type": "application/json" };
    const request = (path: string, method = "GET", body?: unknown) => fetch(`${server.endpoint}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { server, headers, request, sessions };
  }
  const session = await login(owner.id);
  return { ...session, login, client, store, configuration, service, directory, relayDatabaseUrl, workspace, otherWorkspace, channel, otherChannel, owner, admin, member, outsider, agent, audit,
    path: `/local/workspaces/${workspace.id}/authored-documents`,
    async close() { for (const server of servers) await server.close(); await publicServer.close(); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("ordinary browser posting cannot publish skill markers or activate recipients through copied metadata", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.server.endpoint}/local/conversations/${f.channel.id}/messages`, {
      method: "POST", headers: { ...f.headers, "idempotency-key": "forged-skill" },
      body: JSON.stringify({ participantId: f.owner.id, to: [f.agent.id], body: "Copied arguments", authoredInvocationId: "copied" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
    assert.deepEqual(await f.store.listWorkspaceBindings(f.workspace.id), []);
  } finally { await f.close(); }
});

const skill = { kind: "skill", name: "Decision note", description: "Capture a decision", content: "PRIVATE_PROCEDURE: save beneath the authorized base folder." };

test("HTTP authoring publishes immutable revisions, preserves stale drafts, and exposes no bodies in lists/public data", async () => {
  const f = await fixture();
  try {
    const created = await f.request(f.path, "POST", { ...skill, conversationId: f.channel.id });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    let document = await created.json() as LocalAuthoredDocument;
    assert.equal(document.createdBy, f.owner.id);
    assert.equal(document.version, 1);
    const path = `${f.path}/${document.id}`;
    assert.deepEqual(await (await f.request(`${path}/revisions`)).json(), []);
    const published = await f.request(path, "PATCH", { action: "publish", expectedVersion: 1 });
    assert.equal(published.status, 200);
    document = await published.json() as LocalAuthoredDocument;
    assert.equal(document.publishedRevision, 1);
    assert.equal(document.version, 2);
    const saved = await f.request(path, "PATCH", { action: "save", expectedVersion: 2, ...skill, kind: undefined, content: "PRIVATE_DRAFT_TWO" });
    assert.equal(saved.status, 200);
    document = await saved.json() as LocalAuthoredDocument;
    assert.equal(document.publishedRevision, 1);
    const stale = await f.request(path, "PATCH", { action: "save", expectedVersion: 2, name: "Stale", description: "Stale", content: "OVERWRITE" });
    assert.equal(stale.status, 409);
    assert.equal((await (await f.request(path)).json() as LocalAuthoredDocument).content, "PRIVATE_DRAFT_TWO");
    const revisions = await (await f.request(`${path}/revisions`)).json() as LocalAuthoredDocumentRevision[];
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.content, skill.content);
    assert.match(revisions[0]!.contentHash, /^[a-f0-9]{64}$/);
    const replay = await f.request(path, "PATCH", { action: "publish", expectedVersion: 1 });
    assert.equal(replay.status, 409);
    assert.equal((await (await f.request(`${path}/revisions`)).json() as unknown[]).length, 1);
    const summaries = await (await f.request(f.path)).json() as LocalAuthoredDocumentSummary[];
    assert.equal(summaries.length, 1);
    assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE_|content|description/);
    assert.doesNotMatch(JSON.stringify(f.audit), /PRIVATE_|PROCEDURE|content|description/);
    assert.deepEqual(f.audit.filter((event) => event.outcome === "accepted").map((event) => event.action), [
      "authored-document.created", "authored-document.published", "authored-document.updated",
    ]);
    assert.doesNotMatch(JSON.stringify(await f.client.getConversation(f.channel.id)), /PRIVATE_/);
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
    assert.deepEqual(await f.store.listWorkspaceBindings(f.workspace.id), [], "authoring does not activate sessions");
    assert.equal((await f.request(path, "PUT", {})).status, 405);
    assert.equal((await f.request(`${path}/revisions`, "PATCH", {})).status, 405);
  } finally { await f.close(); }
});

test("HTTP authorization derives the human actor and isolates workspace/channel references", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.server.endpoint}${f.path}`)).status, 401);
    assert.equal((await fetch(`${f.server.endpoint}${f.path}`, { method: "POST", headers: { ...f.headers, origin: "http://attacker.invalid" }, body: JSON.stringify(skill) })).status, 403);
    assert.equal((await f.request(f.path, "POST", { ...skill, actorIdentityId: f.outsider.id })).status, 400);
    assert.equal((await f.request(f.path, "POST", { ...skill, conversationId: f.otherChannel.id })).status, 404);
    const root = await f.client.postMessage(f.channel.id, { participantId: f.owner.id, body: "Thread root", to: [] });
    const thread = await f.client.createThread(f.channel.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
    assert.equal((await f.request(f.path, "POST", { ...skill, conversationId: thread.id })).status, 409);
    const document = await (await f.request(f.path, "POST", skill)).json() as LocalAuthoredDocument;
    const path = `${f.path}/${document.id}`;
    const foreignPath = `/local/workspaces/${f.otherWorkspace.id}/authored-documents/${document.id}`;
    assert.equal((await f.request(foreignPath)).status, 404);
    assert.equal((await f.request(`${foreignPath}/revisions`)).status, 404);
    assert.equal((await f.request(foreignPath, "PATCH", { action: "publish", expectedVersion: 1 })).status, 404);
    for (const identity of [f.member, f.outsider, f.agent]) {
      const session = await f.login(identity.id);
      for (const [target, method, body] of [
        [f.path, "GET", undefined], [path, "GET", undefined], [`${path}/revisions`, "GET", undefined],
        [f.path, "POST", skill], [path, "PATCH", { action: "publish", expectedVersion: 1 }],
        [path, "PATCH", { action: "save", expectedVersion: 1, name: "Attack", content: "Attacker" }],
        [path, "PATCH", { action: "archive", expectedVersion: 1 }],
      ] as const) {
        const response = await session.request(target, method, body);
        assert.equal(response.status, 403);
        assert.doesNotMatch(await response.text(), /PRIVATE_PROCEDURE/);
      }
    }
    const admin = await f.login(f.admin.id);
    const published = await admin.request(path, "PATCH", { action: "publish", expectedVersion: 1 });
    assert.equal(published.status, 200);
    assert.equal((await published.json() as LocalAuthoredDocument).updatedBy, f.admin.id);
    await f.client.updateWorkspaceMember(f.workspace.id, f.admin.id, { actorIdentityId: f.owner.id, status: "disabled" });
    assert.equal((await admin.request(path)).status, 403);
    assert.equal((await admin.request(path, "PATCH", { action: "archive", expectedVersion: 2 })).status, 403);
    assert.equal((await (await f.request(path)).json() as LocalAuthoredDocument).state, "active");
    assert.equal((await f.store.listAuthoredDocuments(f.workspace.id)).length, 1);
  } finally { await f.close(); }
});

test("HTTP instructions are unique per scope, clear through publication, and accept no executable/extra fields", async () => {
  const f = await fixture();
  try {
    const instructions = { kind: "instructions", content: "Save beneath F1" };
    const workspaceInstructions = await (await f.request(f.path, "POST", instructions)).json() as LocalAuthoredDocument;
    assert.equal((await f.request(f.path, "POST", instructions)).status, 409);
    const channelInstructions = await f.request(f.path, "POST", { ...instructions, conversationId: f.channel.id });
    assert.equal(channelInstructions.status, 201);
    assert.equal((await f.request(f.path, "POST", { ...instructions, conversationId: f.channel.id })).status, 409);
    const path = `${f.path}/${workspaceInstructions.id}`;
    assert.equal((await f.request(path, "PATCH", { action: "archive", expectedVersion: 1 })).status, 400);
    assert.equal((await f.request(path, "PATCH", { action: "save", expectedVersion: 1, content: "" })).status, 200);
    assert.equal((await f.request(path, "PATCH", { action: "publish", expectedVersion: 2 })).status, 200);
    const history = await (await f.request(`${path}/revisions`)).json() as LocalAuthoredDocumentRevision[];
    assert.equal(history[0]?.content, "");
    for (const body of [
      { ...skill, scripts: ["run.sh"] }, { ...skill, permissions: ["write"] }, { ...skill, scope: "global" },
      { ...skill, content: "😀".repeat(16_385) }, { ...skill, name: " " }, { ...instructions, name: "Override" },
    ]) assert.equal((await f.request(f.path, "POST", body)).status, 400);
    const blank = await (await f.request(f.path, "POST", { kind: "skill", name: "Draft", content: "" })).json() as LocalAuthoredDocument;
    const blankPath = `${f.path}/${blank.id}`;
    assert.equal((await f.request(blankPath, "PATCH", { action: "publish", expectedVersion: 1 })).status, 400);
    for (const expectedVersion of [undefined, null, 0, 1.5, "1"]) {
      assert.equal((await f.request(blankPath, "PATCH", { action: "archive", expectedVersion })).status, 400);
    }
    assert.equal((await f.request(blankPath, "PATCH", { action: "save", expectedVersion: 1, ...skill, kind: undefined, conversationId: f.channel.id })).status, 400);
    assert.equal((await f.request(blankPath, "PATCH", { action: "archive", expectedVersion: 1 })).status, 200);
    assert.equal((await f.request(blankPath, "PATCH", { action: "publish", expectedVersion: 2 })).status, 409);
  } finally { await f.close(); }
});

test("HTTP effective context distinguishes published defaults, legacy, applied, and pending launch manifests", async () => {
  const f = await fixture();
  try {
    const document = await (await f.request(f.path, "POST", { kind: "instructions", content: "PUBLISHED_DEFAULT_V1" })).json() as LocalAuthoredDocument;
    const documentPath = `${f.path}/${document.id}`;
    await f.request(documentPath, "PATCH", { action: "publish", expectedVersion: 1 });
    const path = `/local/conversations/${f.channel.id}/authored-context`;
    const read = async () => {
      const response = await f.request(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return await response.json() as LocalConversationAuthoredContext;
    };
    const initial = await read();
    assert.match(initial.instructions!, /PUBLISHED_DEFAULT_V1/);
    assert.equal(initial.agents[0]?.status, "not_started");
    const now = new Date().toISOString();
    await f.store.putAgentConfig({ id: "context-agent-config", workspaceId: f.workspace.id, agentIdentityId: f.agent.id, status: "active", createdAt: now, updatedAt: now });
    await f.store.putBinding({ id: "context-binding", workspaceAgentConfigId: "context-agent-config", workspaceId: f.workspace.id,
      conversationId: f.channel.id, agentIdentityId: f.agent.id, runtimeAdapter: "fixture", runtimeSessionId: "initial", runtimeOwnerId: "owned",
      generation: 1, state: "connected", wakePolicy: "mentions", createdAt: now, updatedAt: now });
    assert.equal((await read()).agents[0]?.status, "legacy");
    await f.store.replaceBindingSession("context-binding", 1, "fixture", "replacement", now, "owned", { authoredContext: initial.published });
    assert.equal((await read()).agents[0]?.status, "applied");
    await f.request(documentPath, "PATCH", { action: "save", expectedVersion: 2, content: "DRAFT_DEFAULT_V2" });
    assert.equal((await read()).agents[0]?.status, "applied", "A draft alone does not create pending published changes");
    assert.doesNotMatch((await read()).instructions!, /DRAFT_DEFAULT_V2/);
    await f.request(documentPath, "PATCH", { action: "publish", expectedVersion: 3 });
    const pending = await read();
    assert.equal(pending.agents[0]?.status, "pending");
    assert.equal(pending.agents[0]?.applied?.[0]?.revision, 1);
    assert.equal(pending.published.documents[0]?.revision, 2);
    assert.match(pending.instructions!, /DRAFT_DEFAULT_V2/);
    assert.doesNotMatch(JSON.stringify(pending.agents), /DEFAULT_V/);
    const member = await f.login(f.member.id);
    assert.equal((await member.request(path)).status, 403);
    assert.equal((await fetch(`${f.server.endpoint}${path}`)).status, 401);
    const root = await f.client.postMessage(f.channel.id, { participantId: f.owner.id, body: "Thread root", to: [] });
    const thread = await f.client.createThread(f.channel.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
    const inherited = await (await f.request(`/local/conversations/${thread.id}/authored-context`)).json() as LocalConversationAuthoredContext;
    assert.equal(inherited.channelId, f.channel.id);
    assert.deepEqual(inherited.published.documents, pending.published.documents);
    assert.equal(inherited.agents[0]?.status, "not_started", "Thread sessions do not reuse parent applied state");
    const foreign = await (await f.request(`/local/conversations/${f.otherChannel.id}/authored-context`)).json() as LocalConversationAuthoredContext;
    assert.deepEqual(foreign.published.documents, []);
    assert.equal(foreign.instructions, undefined);
  } finally { await f.close(); }
});

async function invocationFixture(options: { publicationEnabled?: boolean } = {}) {
  const f = await fixture(options);
  const peer = await f.client.createIdentity({ type: "agent", displayName: "Peer" });
  await f.client.addWorkspaceMember(f.workspace.id, { identityId: peer.id, mentionHandle: "peer" });
  await f.client.updateConversationParticipants(f.channel.id, { actorIdentityId: f.owner.id, expectedRosterRevision: 1,
    participantIds: [f.owner.id, f.admin.id, f.member.id, f.agent.id, peer.id] });
  async function createSkill(conversationId?: string) {
    const response = await f.request(f.path, "POST", { ...skill, ...(conversationId ? { conversationId } : {}) });
    assert.equal(response.status, 201);
    const document = await response.json() as LocalAuthoredDocument;
    assert.equal((await f.request(`${f.path}/${document.id}`, "PATCH", { action: "publish", expectedVersion: 1 })).status, 200);
    return document;
  }
  const document = await createSkill();
  const channelSkill = await createSkill(f.channel.id);
  const snapshot = await captureAuthoredContext(f.store, f.workspace.id, f.channel.id);
  for (const identity of [f.agent, peer]) {
    const now = new Date().toISOString();
    await f.store.putAgentConfig({ id: `cfg-${identity.id}`, workspaceId: f.workspace.id, agentIdentityId: identity.id, status: "active", createdAt: now, updatedAt: now });
    await f.store.putBinding({ id: `binding-${identity.id}`, workspaceAgentConfigId: `cfg-${identity.id}`,
      workspaceId: f.workspace.id, conversationId: f.channel.id, agentIdentityId: identity.id,
      runtimeAdapter: "fixture", runtimeSessionId: `PRIVATE_RUNTIME_${identity.id}`, runtimeOwnerId: "PRIVATE_OWNER",
      generation: 1, state: "connected", wakePolicy: "mentions", createdAt: now, updatedAt: now },
    { authoredContext: snapshot });
  }
  const invocationPath = `/local/conversations/${f.channel.id}/skill-invocations`;
  const input = { documentId: document.id, source: "workspace" as const, revision: 1,
    arguments: "ARGUMENT_MARKER: @peer @channel are task text, not recipients", to: [f.agent.id, peer.id] };
  type BrowserSession = Awaited<ReturnType<typeof f.login>>;
  const submit = (requestId: string, body: unknown = input, session: BrowserSession = f) =>
    fetch(`${session.server.endpoint}${invocationPath}`, { method: "POST", headers: { ...session.headers, "idempotency-key": requestId }, body: JSON.stringify(body) });
  const read = (requestId: string, session: BrowserSession = f) => session.request(`${invocationPath}/${encodeURIComponent(requestId)}`);
  const publicationPath = `/local/conversations/${f.channel.id}/skill-invocation-publications`;
  const readPublication = (requestId: string, session: BrowserSession = f) => session.request(`${publicationPath}?${new URLSearchParams({ requestId })}`);
  const publish = (receipt: Pick<LocalAuthoredSkillInvocationReceipt, "id" | "requestId">, session: BrowserSession = f) =>
    session.request(publicationPath, "POST", { requestId: receipt.requestId, invocationId: receipt.id });
  return { ...f, peer, document, channelSkill, snapshot, createSkill, invocationPath, input, submit, read, publicationPath, readPublication, publish };
}


type InvocationHttpFixture = Awaited<ReturnType<typeof invocationFixture>>;

function prohibitPublicationHttpEffects(f: InvocationHttpFixture, options: { allowProcedureReads?: boolean } = {}) {
  let effects = 0;
  const prohibited = async () => { effects += 1; throw new Error("PRIVATE_UNEXPECTED_PUBLICATION_EFFECT"); };
  f.client.postMessage = prohibited;
  f.client.postResponse = prohibited;
  f.store.reserveAuthoredSkillInvocation = prohibited;
  f.store.reserveAuthoredInvocationMessageLink = prohibited;
  f.store.acquireBindingLease = prohibited;
  f.store.renewBindingLease = prohibited;
  f.store.putBinding = prohibited;
  f.store.setCursor = prohibited;
  if (!options.allowProcedureReads) {
    f.store.getAuthoredDocument = prohibited;
    f.store.listAuthoredDocumentRevisions = prohibited;
  }
  return () => assert.equal(effects, 0, options.allowProcedureReads
    ? "Denied publication must not publish, accept, wake, renew or mutate queues/sessions"
    : "GET publication must not publish, accept, wake, renew, mutate queues/sessions or resolve procedures");
}

const publicationContext = (f: InvocationHttpFixture, requestId: string, actorIdentityId = f.owner.id) =>
  ({ workspaceId: f.workspace.id, conversationId: f.channel.id, actorIdentityId, requestId });

for (const status of ["not_linked", "not_observed", "observed"] as const) {
  test(`HTTP publication receipt returns private no-store ${status} without activating the producer`, async () => {
    const f = await invocationFixture();
    try {
      const key = "publication /?#+% ü";
      const accepted = await (await f.submit(key)).json() as LocalAuthoredSkillInvocationReceipt;
      let messageId: string | undefined;
      if (status === "not_observed") {
        messageId = createResourceId("message");
        await f.store.reserveAuthoredInvocationMessageLink({ invocationId: accepted.id, messageId });
      } else if (status === "observed") {
        messageId = (await publishAuthoredInvocationMessage(f.store, f.client, publicationContext(f, key))).id;
      }
      const operation = await f.store.getAuthoredSkillInvocation(f.channel.id, f.owner.id, key);
      const bindings = await f.store.listConversationBindings(f.channel.id);
      const link = await f.store.getAuthoredInvocationMessageLink(accepted.id);
      const assertNoEffects = prohibitPublicationHttpEffects(f);
      const response = await f.readPublication(key);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json() as LocalAuthoredSkillInvocationPublicationReceipt;
      assert.deepEqual(result, { requestId: key, invocationId: accepted.id, status, ...(messageId ? { messageId } : {}) });
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|ARGUMENT_MARKER|arguments|documentId|actorIdentityId|generation|contentHash/);
      assert.deepEqual(await (await f.readPublication(key)).json(), result);
      assertNoEffects();
      assert.deepEqual(await f.store.getAuthoredSkillInvocation(f.channel.id, f.owner.id, key), operation);
      assert.deepEqual(await f.store.getAuthoredInvocationMessageLink(accepted.id), link);
      assert.deepEqual(await f.store.listConversationBindings(f.channel.id), bindings);
      assert.equal((await f.client.listMessages(f.channel.id)).length, status === "observed" ? 1 : 0);
    } finally { await f.close(); }
  });
}

test("HTTP publication receipt resolves lost Core acknowledgment after retirement without re-publication", async () => {
  const f = await invocationFixture();
  try {
    const key = "retired uncertainty";
    const accepted = await (await f.submit(key)).json() as LocalAuthoredSkillInvocationReceipt;
    const post = f.client.postMessage.bind(f.client);
    f.client.postMessage = async (...args) => { await post(...args); throw new Error("PRIVATE_LOST_CORE_ACK"); };
    await assert.rejects(publishAuthoredInvocationMessage(f.store, f.client, publicationContext(f, key)), /Skill invocation delivery is unavailable/);
    const original = (await f.client.listMessages(f.channel.id))[0]!;
    assert.equal((await f.request(`${f.path}/${f.document.id}`, "PATCH", { action: "archive", expectedVersion: 2 })).status, 200);
    const assertNoEffects = prohibitPublicationHttpEffects(f);
    const response = await f.readPublication(key);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requestId: key, invocationId: accepted.id, status: "observed", messageId: original.id });
    assertNoEffects();
    assert.deepEqual((await f.client.listMessages(f.channel.id)).map(message => message.id), [original.id]);
  } finally { await f.close(); }
});

test("HTTP publication receipt derives actor from the cookie and isolates identical keys between active humans", async () => {
  const f = await invocationFixture();
  try {
    const key = "shared-key";
    const ownerReceipt = await (await f.submit(key)).json() as LocalAuthoredSkillInvocationReceipt;
    await publishAuthoredInvocationMessage(f.store, f.client, publicationContext(f, key));
    const member = await f.login(f.member.id);
    const spoofed = `${f.publicationPath}?${new URLSearchParams({ requestId: key, actorIdentityId: f.owner.id, workspaceId: f.workspace.id })}`;
    const request = () => fetch(`${member.server.endpoint}${spoofed}`, {
      headers: { ...member.headers, "x-minu-actor-id": f.owner.id },
    });
    assert.equal((await request()).status, 404, "Active members cannot select another actor with query/header values");
    const memberReceipt = await (await f.submit(key, f.input, member)).json() as LocalAuthoredSkillInvocationReceipt;
    const assertNoEffects = prohibitPublicationHttpEffects(f);
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requestId: key, invocationId: memberReceipt.id, status: "not_linked" });
    assert.notEqual(memberReceipt.id, ownerReceipt.id);
    const admin = await f.login(f.admin.id);
    assert.equal((await f.readPublication(key, admin)).status, 404);
    for (const identity of [f.outsider, f.agent]) {
      const session = await f.login(identity.id);
      assert.equal((await f.readPublication(key, session)).status, 403);
    }
    const foreign = `/local/conversations/${f.otherChannel.id}/skill-invocation-publications?${new URLSearchParams({ requestId: key })}`;
    assert.equal((await f.request(foreign)).status, 404);
    assert.equal((await f.readPublication("missing")).status, 404);
    assert.equal((await f.readPublication(ownerReceipt.id)).status, 404, "The public operation ID is not a private request selector");
    assertNoEffects();
  } finally { await f.close(); }
});

test("HTTP publication receipt enforces cookie/origin, one valid request key and GET-only access", async () => {
  const f = await invocationFixture();
  try {
    assert.equal((await f.submit("auth-key")).status, 202);
    const assertNoEffects = prohibitPublicationHttpEffects(f);
    const path = `${f.publicationPath}?requestId=auth-key`;
    assert.equal((await fetch(`${f.server.endpoint}${path}`)).status, 401);
    assert.equal((await fetch(`${f.server.endpoint}${path}`, { headers: { ...f.headers, origin: "http://attacker.invalid" } })).status, 403);
    for (const query of ["", "?requestId=", "?requestId=a&requestId=b", `?${new URLSearchParams({ requestId: "é".repeat(128) })}`]) {
      assert.equal((await f.request(f.publicationPath + query)).status, 400);
    }
    assert.equal((await f.request("/local/conversations/%ZZ/skill-invocation-publications?requestId=auth-key")).status, 400);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await f.request(path, method, {});
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET");
    }
    assertNoEffects();
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
  } finally { await f.close(); }
});

test("HTTP publication receipt denies revoked membership before and during observation without exposing a status", async () => {
  const f = await invocationFixture();
  try {
    const member = await f.login(f.member.id);
    const key = "revoked-reader";
    assert.equal((await f.submit(key, f.input, member)).status, 202);
    await publishAuthoredInvocationMessage(f.store, f.client, publicationContext(f, key, f.member.id));
    const list = f.client.listMessages.bind(f.client);
    let revoked = false;
    f.client.listMessages = async (...args) => {
      const messages = await list(...args);
      if (!revoked) {
        revoked = true;
        await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
      }
      return messages;
    };
    const assertNoEffects = prohibitPublicationHttpEffects(f);
    const response = await f.readPublication(key, member);
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /invocationId|messageId|PRIVATE_|ARGUMENT_MARKER/);
    assert.equal((await f.readPublication(key, member)).status, 403);
    assertNoEffects();
    assert.equal((await list(f.channel.id)).length, 1);
  } finally { await f.close(); }
});

test("HTTP publication receipt revalidates browser session after an observation completes", async () => {
  const f = await invocationFixture();
  try {
    const key = "expiring-session";
    assert.equal((await f.submit(key)).status, 202);
    await publishAuthoredInvocationMessage(f.store, f.client, publicationContext(f, key));
    let clock = Date.now();
    const session = await f.login(f.owner.id, { now: () => new Date(clock), sessionTtlMs: 1_000 });
    const list = f.client.listMessages.bind(f.client);
    f.client.listMessages = async (...args) => { const result = await list(...args); clock += 1_001; return result; };
    const assertNoEffects = prohibitPublicationHttpEffects(f);
    const response = await f.readPublication(key, session);
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /invocationId|messageId|PRIVATE_|ARGUMENT_MARKER/);
    assertNoEffects();
  } finally { await f.close(); }
});

test("HTTP publication receipt sanitizes inspection failures without falling back to acceptance or a retry", async () => {
  const f = await invocationFixture();
  try {
    const key = "unavailable-observation";
    assert.equal((await f.submit(key)).status, 202);
    f.store.getAuthoredInvocationMessageLink = async () => { throw new Error("PRIVATE_LINK_FAILURE /private/host/path"); };
    const assertNoEffects = prohibitPublicationHttpEffects(f);
    const response = await f.readPublication(key);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Skill invocation publication is unavailable" });
    assertNoEffects();
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
  } finally { await f.close(); }
});

test("HTTP publication typed client preserves opaque slash/query/Unicode/dot-only request keys with credentialed GETs", async () => {
  const f = await invocationFixture();
  const originalFetch = globalThis.fetch;
  try {
    const calls: Array<{ url: string; method: string | undefined; credentials: RequestCredentials | undefined }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith(f.server.endpoint + "/local/")) {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(f.headers)) headers.set(name, value);
        if (url.includes("/skill-invocation-publications?")) calls.push({ url, method: init?.method ?? "GET", credentials: init?.credentials });
        return originalFetch(input, { ...init, headers });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const client = new LocalControlClient(f.server.endpoint);
    for (const key of [".", "..", "opaque /?#+% ü", " token "]) {
      // HTTP header transport trims outer whitespace; seed this exact stored key
      // directly so this test covers query identity without changing acceptance.
      const accepted = key.trim() !== key
        ? await f.configuration.acceptAuthoredSkillInvocation(f.channel.id, f.owner.id, key, f.input)
        : await (await f.submit(key)).json() as LocalAuthoredSkillInvocationReceipt;
      const result = await client.getAuthoredSkillInvocationPublication(f.channel.id, key);
      assert.deepEqual(result, { requestId: key, invocationId: accepted.id, status: "not_linked" });
    }
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.method === "GET" && call.credentials === "include"));
    assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get("requestId")), [".", "..", "opaque /?#+% ü", " token "]);
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});


async function waitPublication(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Publication condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("HTTP explicit publication is default-disabled without changing GET or acceptance semantics", async () => {
  const f = await invocationFixture();
  try {
    const receipt = await (await f.submit("disabled-producer")).json() as LocalAuthoredSkillInvocationReceipt;
    const assertNoEffects = prohibitPublicationHttpEffects(f);
    const response = await f.publish(receipt);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal((await f.readPublication(receipt.requestId)).status, 200);
    assert.equal(await f.store.getAuthoredInvocationMessageLink(receipt.id), undefined);
    assertNoEffects();
  } finally { await f.close(); }
});

test("HTTP explicit publication freezes intent and association; observed repeat/retirement never reposts", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  try {
    const receipt = await (await f.submit("explicit-original")).json() as LocalAuthoredSkillInvocationReceipt;
    const operation = await f.store.getAuthoredSkillInvocation(f.channel.id, f.owner.id, receipt.requestId);
    const bindings = await f.store.listConversationBindings(f.channel.id);
    const post = f.client.postMessage.bind(f.client);
    let posts = 0;
    f.client.postMessage = async (conversationId, input, options) => {
      posts += 1;
      const link = await f.store.getAuthoredInvocationMessageLink(receipt.id);
      assert.equal(input.id, link?.messageId, "Private link must already be durable");
      assert.equal(input.authoredInvocationId, receipt.id);
      assert.equal(input.body, receipt.arguments);
      assert.deepEqual(input.to, receipt.to);
      assert.equal(options?.idempotencyKey, `authored-invocation:${receipt.id}`);
      return post(conversationId, input, options);
    };
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
    const response = await f.publish(receipt);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const published = await response.json() as LocalAuthoredSkillInvocationPublicationReceipt;
    assert.equal(published.status, "observed");
    assert.doesNotMatch(JSON.stringify(published), /PRIVATE_|ARGUMENT_MARKER|arguments|generation|contentHash/);
    const repeats = await Promise.all([f.publish(receipt), f.publish(receipt)]);
    for (const repeated of repeats) { assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), published); }
    assert.equal((await f.request(`${f.path}/${f.document.id}`, "PATCH", { action: "archive", expectedVersion: 2 })).status, 200);
    assert.deepEqual(await (await f.publish(receipt)).json(), published);
    assert.equal(posts, 1);
    assert.equal((await f.client.listMessages(f.channel.id)).length, 1);
    assert.deepEqual(await f.store.getAuthoredSkillInvocation(f.channel.id, f.owner.id, receipt.requestId), operation);
    assert.deepEqual(await f.store.listConversationBindings(f.channel.id), bindings);
    assert.doesNotMatch(JSON.stringify(f.audit), /PRIVATE_|ARGUMENT_MARKER/);
  } finally { await f.close(); }
});

test("HTTP explicit publication rejects spoofed/replacement payloads and cross-actor receipt IDs before writes", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  try {
    const receipt = await (await f.submit("explicit-shared")).json() as LocalAuthoredSkillInvocationReceipt;
    const body = { requestId: receipt.requestId, invocationId: receipt.id };
    let posts = 0;
    f.client.postMessage = async () => { posts += 1; throw new Error("PRIVATE_UNEXPECTED_SEND"); };
    assert.equal((await fetch(`${f.server.endpoint}${f.publicationPath}`, { method: "POST", body: JSON.stringify(body) })).status, 401);
    assert.equal((await fetch(`${f.server.endpoint}${f.publicationPath}`, { method: "POST", headers: { ...f.headers, origin: "http://attacker.invalid" }, body: JSON.stringify(body) })).status, 403);
    for (const changed of [{ actorIdentityId: f.member.id }, { to: [f.peer.id] }, { arguments: "replace" }, { revision: 2 }, { source: "channel" }, { enabled: true }]) {
      assert.equal((await f.request(f.publicationPath, "POST", { ...body, ...changed })).status, 400);
    }
    for (const value of [{}, { requestId: receipt.requestId }, { ...body, requestId: "" }, { ...body, invocationId: "x".repeat(129) }]) {
      assert.equal((await f.request(f.publicationPath, "POST", value)).status, 400);
    }
    assert.equal((await f.request(`${f.publicationPath}?requestId=other`, "POST", body)).status, 400);
    assert.equal((await f.request(f.publicationPath, "POST", { ...body, invocationId: "different" })).status, 409);
    assert.equal((await f.publish({ ...receipt, requestId: "missing" })).status, 404);
    const member = await f.login(f.member.id);
    assert.equal((await f.publish(receipt, member)).status, 404);
    const own = await (await f.submit(receipt.requestId, f.input, member)).json() as LocalAuthoredSkillInvocationReceipt;
    const spoof = await fetch(`${member.server.endpoint}${f.publicationPath}?actorIdentityId=${f.owner.id}`, {
      method: "POST", headers: { ...member.headers, "x-minu-actor-id": f.owner.id }, body: JSON.stringify(body),
    });
    assert.equal(spoof.status, 409, "A stale other-human receipt cannot select the same-key own operation");
    assert.equal(await f.store.getAuthoredInvocationMessageLink(own.id), undefined);
    for (const identity of [f.outsider, f.agent]) assert.equal((await f.publish(receipt, await f.login(identity.id))).status, 403);
    assert.equal(posts, 0);
    assert.equal(await f.store.getAuthoredInvocationMessageLink(receipt.id), undefined);
  } finally { await f.close(); }
});

test("HTTP explicit publication typed client uses accepted wire-key identity without raw-header normalization", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  const originalFetch = globalThis.fetch;
  try {
    const accepted = await (await f.submit(" wire-key ")).json() as LocalAuthoredSkillInvocationReceipt;
    assert.equal(accepted.requestId, "wire-key", "HTTP transport canonicalizes outer header whitespace");
    assert.equal((await f.publish({ ...accepted, requestId: " wire-key " })).status, 404, "Publication must not silently trim or reinterpret a selector");
    assert.equal(await f.store.getAuthoredInvocationMessageLink(accepted.id), undefined);
    const bodies: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input).startsWith(f.server.endpoint + "/local/")) {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(f.headers)) headers.set(name, value);
        headers.set("idempotency-key", "not-the-selector");
        if (init?.method === "POST" && String(input).endsWith("/skill-invocation-publications")) bodies.push(JSON.parse(String(init.body)));
        return originalFetch(input, { ...init, headers });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const client = new LocalControlClient(f.server.endpoint);
    const published = await client.publishAuthoredSkillInvocation(f.channel.id, accepted);
    assert.equal(published.status, "observed");
    assert.equal(published.requestId, accepted.requestId);
    const exact = await f.configuration.acceptAuthoredSkillInvocation(f.channel.id, f.owner.id, " stored raw ", f.input);
    assert.equal((await client.publishAuthoredSkillInvocation(f.channel.id, exact)).requestId, " stored raw ");
    assert.deepEqual(bodies, [{ requestId: accepted.requestId, invocationId: accepted.id }, { requestId: exact.requestId, invocationId: exact.id }]);
    assert.equal((await f.client.listMessages(f.channel.id)).length, 2);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test("HTTP explicit publication reconciles a committed lost Core acknowledgment without another send", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  try {
    const receipt = await (await f.submit("explicit-lost-ack")).json() as LocalAuthoredSkillInvocationReceipt;
    const post = f.client.postMessage.bind(f.client);
    let posts = 0;
    f.client.postMessage = async (...args) => { posts += 1; await post(...args); throw new Error("PRIVATE_CORE_ACK_LOST"); };
    const failed = await f.publish(receipt);
    assert.equal(failed.status, 409);
    assert.doesNotMatch(await failed.text(), /PRIVATE_|ARGUMENT_MARKER/);
    const link = await f.store.getAuthoredInvocationMessageLink(receipt.id);
    assert.equal((await f.readPublication(receipt.requestId)).status, 200);
    const repeated = await f.publish(receipt);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { requestId: receipt.requestId, invocationId: receipt.id, status: "observed", messageId: link!.messageId });
    assert.equal(posts, 1);
    assert.equal((await f.client.listMessages(f.channel.id)).length, 1);
  } finally { await f.close(); }
});

for (const failure of ["link_ack", "core_not_committed"] as const) {
  test(`HTTP explicit publication blocks unresolved ${failure} without inferring a resend from absence`, async () => {
    const f = await invocationFixture({ publicationEnabled: true });
    try {
      const receipt = await (await f.submit(failure)).json() as LocalAuthoredSkillInvocationReceipt;
      let posts = 0;
      const post = f.client.postMessage.bind(f.client);
      f.client.postMessage = async (...args) => {
        posts += 1;
        if (failure === "core_not_committed") throw new Error("PRIVATE_TRANSPORT_FAILURE");
        return post(...args);
      };
      if (failure === "link_ack") {
        const reserve = f.store.reserveAuthoredInvocationMessageLink.bind(f.store);
        f.store.reserveAuthoredInvocationMessageLink = async link => { await reserve(link); throw new Error("PRIVATE_LINK_ACK_LOST"); };
      }
      assert.equal((await f.publish(receipt)).status, 409);
      const link = (await f.store.getAuthoredInvocationMessageLink(receipt.id))!;
      assert.ok(link);
      assert.deepEqual(await (await f.readPublication(receipt.requestId)).json(),
        { requestId: receipt.requestId, invocationId: receipt.id, status: "not_observed", messageId: link.messageId });
      assert.equal((await f.publish(receipt)).status, 409);
      assert.deepEqual(await f.store.getAuthoredInvocationMessageLink(receipt.id), link);
      assert.equal(posts, failure === "link_ack" ? 0 : 1);
      assert.deepEqual(await f.client.listMessages(f.channel.id), []);
    } finally { await f.close(); }
  });
}

for (const change of ["archive", "actor_revoked", "stopped"] as const) {
  test(`HTTP explicit publication blocks ${change} before reserving a public association`, async () => {
    const f = await invocationFixture({ publicationEnabled: true });
    try {
      const member = await f.login(f.member.id);
      const receipt = await (await f.submit(change, f.input, member)).json() as LocalAuthoredSkillInvocationReceipt;
      if (change === "archive") assert.equal((await f.request(`${f.path}/${f.document.id}`, "PATCH", { action: "archive", expectedVersion: 2 })).status, 200);
      else if (change === "actor_revoked") await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
      else {
        const binding = (await f.store.listConversationBindings(f.channel.id))[0]!;
        await f.store.disableBinding(binding.id, binding.generation, new Date().toISOString());
      }
      const bindings = await f.store.listConversationBindings(f.channel.id);
      const assertNoEffects = prohibitPublicationHttpEffects(f, { allowProcedureReads: true });
      assert.equal((await f.publish(receipt, member)).status, change === "actor_revoked" ? 403 : 409);
      assertNoEffects();
      assert.equal(await f.store.getAuthoredInvocationMessageLink(receipt.id), undefined);
      assert.deepEqual(await f.store.listConversationBindings(f.channel.id), bindings);
      assert.deepEqual(await f.client.listMessages(f.channel.id), []);
    } finally { await f.close(); }
  });
}

for (const boundary of ["before_link", "after_link"] as const) {
  test(`HTTP explicit publication fences browser expiry ${boundary} without a Core send`, async () => {
    const f = await invocationFixture({ publicationEnabled: true });
    try {
      const receipt = await (await f.submit(boundary)).json() as LocalAuthoredSkillInvocationReceipt;
      let clock = Date.now();
      const session = await f.login(f.owner.id, { now: () => new Date(clock), sessionTtlMs: 1_000 });
      if (boundary === "before_link") {
        const read = f.store.listAuthoredDocumentRevisions.bind(f.store);
        f.store.listAuthoredDocumentRevisions = async (...args) => { const rows = await read(...args); clock += 1_001; return rows; };
      } else {
        const reserve = f.store.reserveAuthoredInvocationMessageLink.bind(f.store);
        f.store.reserveAuthoredInvocationMessageLink = async link => { const result = await reserve(link); clock += 1_001; return result; };
      }
      let posts = 0;
      f.client.postMessage = async () => { posts += 1; throw new Error("PRIVATE_UNEXPECTED_SEND"); };
      const response = await f.publish(receipt, session);
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /PRIVATE_|ARGUMENT_MARKER|messageId/);
      assert.equal(posts, 0);
      assert.equal(!!await f.store.getAuthoredInvocationMessageLink(receipt.id), boundary === "after_link");
      assert.deepEqual(await f.client.listMessages(f.channel.id), []);
    } finally { await f.close(); }
  });
}

test("HTTP explicit publication session loss after Core commit reconciles the original identity without reposting", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  try {
    const receipt = await (await f.submit("session-after-commit")).json() as LocalAuthoredSkillInvocationReceipt;
    let clock = Date.now();
    const session = await f.login(f.owner.id, { now: () => new Date(clock), sessionTtlMs: 1_000 });
    const post = f.client.postMessage.bind(f.client);
    let posts = 0;
    f.client.postMessage = async (...args) => { posts += 1; const message = await post(...args); clock += 1_001; return message; };
    const response = await f.publish(receipt, session);
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /messageId|PRIVATE_|ARGUMENT_MARKER/);
    const original = (await f.client.listMessages(f.channel.id))[0]!;
    const repeated = await f.publish(receipt);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { requestId: receipt.requestId, invocationId: receipt.id, status: "observed", messageId: original.id });
    assert.equal(posts, 1);
    assert.equal((await f.store.getAuthoredInvocationMessageLink(receipt.id))?.messageId, original.id);
  } finally { await f.close(); }
});

test("HTTP explicit publication rechecks the browser session after waiting in the Conversation send queue", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await (await f.submit("queue-first")).json() as LocalAuthoredSkillInvocationReceipt;
    const second = await (await f.submit("queue-second")).json() as LocalAuthoredSkillInvocationReceipt;
    const post = f.client.postMessage.bind(f.client);
    let entered = false;
    let posts = 0;
    f.client.postMessage = async (...args) => { posts += 1; entered = true; await blocked; return post(...args); };
    const publishing = f.publish(first);
    await waitPublication(async () => entered);
    let clock = Date.now();
    const expiring = await f.login(f.owner.id, { now: () => new Date(clock), sessionTtlMs: 1_000 });
    const publish = f.service.publishAuthoredSkillInvocation.bind(f.service);
    let queued = false;
    f.service.publishAuthoredSkillInvocation = (...args) => {
      const pending = publish(...args);
      if ((args[2] as { requestId?: string }).requestId === second.requestId) queued = true;
      return pending;
    };
    const waiting = f.publish(second, expiring);
    await waitPublication(async () => queued);
    clock += 1_001;
    release();
    assert.equal((await publishing).status, 200);
    assert.equal((await waiting).status, 401);
    assert.equal(posts, 1);
    assert.equal(await f.store.getAuthoredInvocationMessageLink(second.id), undefined);
  } finally { release(); await f.close(); }
});

test("explicit publication across independent configuration/store writers posts only from the new-link owner", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  const other = await DrizzleLibSqlRelayStorage.open({ url: f.relayDatabaseUrl });
  try {
    const receipt = await (await f.submit("competing-producers")).json() as LocalAuthoredSkillInvocationReceipt;
    const otherConfiguration = new LocalAgentHostConfiguration({ client: f.client, store: other });
    let arrivals = 0;
    let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    for (const store of [f.store, other]) {
      const read = store.getAuthoredInvocationMessageLink.bind(store);
      let intercepted = false;
      store.getAuthoredInvocationMessageLink = async id => {
        const link = await read(id);
        if (!intercepted && id === receipt.id) {
          intercepted = true; arrivals += 1;
          if (arrivals === 2) release();
          await both;
        }
        return link;
      };
    }
    let posts = 0;
    const post = f.client.postMessage.bind(f.client);
    f.client.postMessage = async (...args) => { posts += 1; return post(...args); };
    const body = { requestId: receipt.requestId, invocationId: receipt.id };
    const outcomes = await Promise.allSettled([
      f.configuration.publishAuthoredSkillInvocation(f.channel.id, f.owner.id, body),
      otherConfiguration.publishAuthoredSkillInvocation(f.channel.id, f.owner.id, body),
    ]);
    assert.ok(outcomes.some(outcome => outcome.status === "fulfilled"));
    assert.equal(posts, 1);
    assert.equal((await f.client.listMessages(f.channel.id)).length, 1);
  } finally { await other.close(); await f.close(); }
});

test("HTTP explicit publication reaches only the accepted addressed restored Runtime turn", async () => {
  const f = await invocationFixture({ publicationEnabled: true });
  let restored: Awaited<ReturnType<typeof restoreConversationBindings>> | undefined;
  let relay: ConversationRuntimeRelay | undefined;
  try {
    const receipt = await (await f.submit("addressed-http", { ...f.input, to: [f.agent.id] })).json() as LocalAuthoredSkillInvocationReceipt;
    const now = new Date().toISOString();
    await f.store.putWorkspaceConfig({ workspaceId: f.workspace.id, rootUri: f.directory, createdAt: now, updatedAt: now });
    const turns = new Map<string, RuntimePortTurn>();
    const inputs: Array<{ sessionId: string; input: string }> = [];
    const runtime: AgentRuntimePort = {
      async status() { return "idle"; }, async messages() { return []; }, async send() { throw new Error("No legacy send"); },
      async getManagedSession(id, ownerId) { return { id, ownerId, state: "active" }; },
      async resume(id, ownerId) { return { id, ownerId }; },
      async turn(_sessionId, id) { return turns.get(id); },
      async startTurn(sessionId, id, input) {
        inputs.push({ sessionId, input });
        const turn: RuntimePortTurn = { id, status: "completed", input, response: { role: "assistant", content: "Simulated decision captured" }, createdAt: now, updatedAt: now };
        turns.set(id, turn); return turn;
      },
    };
    restored = await restoreConversationBindings({ client: f.client, store: f.store, conversationId: f.channel.id,
      leaseOwner: "http-fixture-host", runtimes: { fixture: runtime } });
    assert.equal(restored.bindings.length, 2);
    restored.bindings.find(binding => binding.participantId === f.peer.id)!.wakePolicy = "all_messages";
    relay = new ConversationRuntimeRelay({ client: f.client, conversationId: f.channel.id, bindings: restored.bindings, cursorStore: f.store, turnPollIntervalMs: 5 });
    await relay.start();
    const response = await f.publish(receipt);
    assert.equal(response.status, 200);
    const observation = await response.json() as LocalAuthoredSkillInvocationPublicationReceipt;
    assert.equal(observation.status, "observed");
    const original = (await f.client.listMessages(f.channel.id)).find(message => message.authoredInvocationId === receipt.id)!;
    await waitPublication(async () => (await f.store.getCursor(f.channel.id, f.agent.id)) >= original.sequence);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.sessionId, `PRIVATE_RUNTIME_${f.agent.id}`);
    assert.match(inputs[0]!.input, /PRIVATE_PROCEDURE/);
    assert.match(inputs[0]!.input, /ARGUMENT_MARKER/);
    assert.deepEqual(original.to, [f.agent.id]);
    assert.doesNotMatch(JSON.stringify(await f.client.listMessages(f.channel.id)), /PRIVATE_PROCEDURE|PRIVATE_RUNTIME|PRIVATE_OWNER/);
  } finally { await relay?.stop(); await restored?.close(); await f.close(); }
});

test("HTTP invocation acceptance freezes exact identity/revision/recipients and resolves retries without dispatch", async () => {
  const f = await invocationFixture();
  try {
    const first = await f.submit("accept/1");
    assert.equal(first.status, 202);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const receipt = await first.json() as LocalAuthoredSkillInvocationReceipt;
    assert.equal(receipt.acceptance, "accepted");
    assert.equal(receipt.documentId, f.document.id);
    assert.equal(receipt.actorIdentityId, f.owner.id);
    assert.deepEqual(receipt.to, [...f.input.to].sort());
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_PROCEDURE|PRIVATE_RUNTIME|PRIVATE_OWNER|binding-/);
    assert.deepEqual(await (await f.read("accept/1")).json(), receipt);
    const repeated = await f.submit("accept/1", { ...f.input, to: [...f.input.to].reverse() });
    assert.equal(repeated.status, 202);
    assert.deepEqual(await repeated.json(), receipt);
    const parallel = await Promise.all([f.submit("parallel"), f.submit("parallel")]);
    assert.ok(parallel.every(response => response.status === 202));
    assert.deepEqual(await parallel[0]!.json(), await parallel[1]!.json());
    for (const change of [{ arguments: "changed" }, { to: [f.agent.id] }, { documentId: f.channelSkill.id, source: "channel" }, { revision: 2 }]) {
      assert.equal((await f.submit("accept/1", { ...f.input, ...change })).status, 409);
    }
    const sameName = await f.submit("different-identity", { ...f.input, documentId: f.channelSkill.id, source: "channel" });
    assert.equal(sameName.status, 202);
    assert.equal((await sameName.json() as LocalAuthoredSkillInvocationReceipt).documentId, f.channelSkill.id);
    const record = await f.store.getAuthoredSkillInvocation(f.channel.id, f.owner.id, "accept/1");
    assert.equal(record?.targets.length, 2);
    assert.ok(record?.targets.every(target => target.generation === 1));
    assert.doesNotMatch(JSON.stringify(f.audit), /PRIVATE_PROCEDURE|ARGUMENT_MARKER|PRIVATE_RUNTIME|PRIVATE_OWNER/);
    assert.deepEqual(await f.client.listMessages(f.channel.id), [], "Acceptance must not publish a bare chat message");
    assert.equal((await f.store.listConversationBindings(f.channel.id)).length, 2, "No implicit starts/replacement");
  } finally { await f.close(); }
});

test("HTTP old pinned revisions remain explicit and archived acceptance receipts do not reaccept work", async () => {
  const f = await invocationFixture();
  try {
    const receipt = await (await f.submit("before-publication")).json();
    const path = `${f.path}/${f.document.id}`;
    assert.equal((await f.request(path, "PATCH", { action: "save", expectedVersion: 2, ...skill, kind: undefined, content: "PRIVATE_NEW_PROCEDURE" })).status, 200);
    assert.equal((await f.request(path, "PATCH", { action: "publish", expectedVersion: 3 })).status, 200);
    assert.equal((await f.submit("old-pinned", f.input)).status, 202);
    assert.equal((await f.submit("not-in-manifest", { ...f.input, revision: 2 })).status, 409);
    assert.equal((await f.read("not-in-manifest")).status, 404);
    assert.deepEqual(await (await f.submit("before-publication")).json(), receipt);
    const bindings = await f.store.listConversationBindings(f.channel.id);
    assert.equal((await f.request(path, "PATCH", { action: "archive", expectedVersion: 4 })).status, 200);
    assert.deepEqual(await f.store.listConversationBindings(f.channel.id), bindings, "Archival must not restart, stop or replace retained sessions");
    assert.equal((await f.submit("after-archive")).status, 409);
    assert.equal((await f.read("after-archive")).status, 404);
    assert.deepEqual(await (await f.submit("before-publication")).json(), receipt, "Resolve existing acknowledgment, not new dispatch");
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
  } finally { await f.close(); }
});

test("HTTP invocation validation rejects forged, foreign, unsupported and partial recipient requests", async () => {
  const f = await invocationFixture();
  try {
    const invalid = [
      { ...f.input, actorIdentityId: f.member.id }, { ...f.input, requestId: "body-override" }, { ...f.input, source: "harness" },
      { ...f.input, source: "global" }, { ...f.input, to: [] }, { ...f.input, to: [f.agent.id, f.agent.id] },
      { ...f.input, revision: 0 }, { ...f.input, revision: null }, { ...f.input, arguments: "😀".repeat(16_385) },
    ];
    for (const [i, input] of invalid.entries()) {
      assert.equal((await f.submit(`invalid-${i}`, input)).status, 400);
      assert.equal((await f.read(`invalid-${i}`)).status, 404);
    }
    for (const [i, recipient] of [f.owner.id, f.outsider.id, "@conversation", "@channel", "peer"].entries()) {
      assert.equal((await f.submit(`recipient-${i}`, { ...f.input, to: [recipient] })).status, 409);
      assert.equal((await f.read(`recipient-${i}`)).status, 404);
    }
    assert.equal((await f.submit("wrong-source", { ...f.input, source: "channel" })).status, 404);
    assert.equal((await f.submit("foreign-id", { ...f.input, documentId: "not-readable" })).status, 404);
    const sibling = await f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id, f.agent.id] });
    const siblingSkill = await f.createSkill(sibling.id);
    assert.equal((await f.submit("sibling", { ...f.input, source: "channel", documentId: siblingSkill.id })).status, 404);
    const draft = await (await f.request(f.path, "POST", { kind: "skill", name: "Draft", content: "PRIVATE_DRAFT" })).json() as LocalAuthoredDocument;
    assert.equal((await f.submit("unpublished", { ...f.input, documentId: draft.id })).status, 409);
    const peerBinding = (await f.store.listConversationBindings(f.channel.id)).find(binding => binding.agentIdentityId === f.peer.id)!;
    await f.store.replaceBindingSession(peerBinding.id, peerBinding.generation, "fixture", "PRIVATE_UNAVAILABLE", new Date().toISOString(), "PRIVATE_OWNER",
      { authoredContext: { ...f.snapshot, documents: [] } });
    assert.equal((await f.submit("partial-group")).status, 409);
    assert.equal((await f.read("partial-group")).status, 404);
    assert.deepEqual(await f.client.listMessages(f.channel.id), []);
  } finally { await f.close(); }
});

test("HTTP invocation authority accepts active human members, while receipts stay actor scoped", async () => {
  const f = await invocationFixture();
  try {
    assert.equal((await fetch(`${f.server.endpoint}${f.invocationPath}`, { method: "POST", body: JSON.stringify(f.input) })).status, 401);
    assert.equal((await fetch(`${f.server.endpoint}${f.invocationPath}`, { method: "POST", headers: { ...f.headers, origin: "http://attacker.invalid", "idempotency-key": "bad-origin" }, body: JSON.stringify(f.input) })).status, 403);
    assert.equal((await f.request(f.invocationPath, "POST", f.input)).status, 400, "An idempotency key is mandatory");
    assert.equal((await f.submit("actor-scoped")).status, 202);
    for (const identity of [f.outsider, f.agent]) {
      const session = await f.login(identity.id);
      assert.equal((await f.submit("actor-scoped", f.input, session)).status, 403);
      assert.equal((await f.read("actor-scoped", session)).status, 403);
    }
    const member = await f.login(f.member.id);
    assert.equal((await f.read("actor-scoped", member)).status, 404, "Members cannot read another actor's receipt");
    const accepted = await f.submit("actor-scoped", f.input, member);
    assert.equal(accepted.status, 202);
    const memberReceipt = await accepted.json() as LocalAuthoredSkillInvocationReceipt;
    assert.equal(memberReceipt.actorIdentityId, f.member.id);
    assert.deepEqual(await (await f.read("actor-scoped", member)).json(), memberReceipt);
    assert.equal((await member.request(`${f.path}/${f.document.id}`)).status, 403, "Use does not grant private draft reads");
    assert.equal((await member.request(f.path, "POST", skill)).status, 403, "Use does not grant authoring");
    assert.equal((await member.request(`${f.path}/${f.document.id}`, "PATCH", { action: "archive", expectedVersion: 2 })).status, 403);
    await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
    assert.equal((await f.read("actor-scoped", member)).status, 403);
    assert.equal((await f.submit("actor-scoped", f.input, member)).status, 403);
    await f.client.addWorkspaceMember(f.workspace.id, { identityId: f.outsider.id, mentionHandle: "observer" });
    const observer = await f.login(f.outsider.id);
    assert.equal((await f.submit("not-a-participant", f.input, observer)).status, 403, "Workspace membership alone grants no Conversation access");
    assert.equal((await f.read("actor-scoped", observer)).status, 403);
    const admin = await f.login(f.admin.id);
    assert.equal((await f.read("actor-scoped", admin)).status, 404);
    const adminReceipt = await f.submit("actor-scoped", f.input, admin);
    assert.equal(adminReceipt.status, 202);
    assert.equal((await adminReceipt.json() as LocalAuthoredSkillInvocationReceipt).actorIdentityId, f.admin.id);
    await f.client.updateWorkspaceMember(f.workspace.id, f.admin.id, { actorIdentityId: f.owner.id, status: "disabled" });
    assert.equal((await f.read("actor-scoped", admin)).status, 403);
    assert.equal((await f.submit("actor-scoped", f.input, admin)).status, 403);
    assert.equal((await f.request(f.invocationPath)).status, 405);
    assert.equal((await f.request(`${f.invocationPath}/actor-scoped`, "PATCH", {})).status, 405);
  } finally { await f.close(); }
});

for (const change of ["generation", "archive"] as const) {
  test(`HTTP acceptance rechecks ${change} at the durable commit boundary without partial intent`, async () => {
    const f = await invocationFixture();
    try {
      const reserve = f.store.reserveAuthoredSkillInvocation.bind(f.store);
      f.store.reserveAuthoredSkillInvocation = async record => {
        if (change === "generation") {
          const target = record.targets[0]!;
          await f.store.replaceBindingSession(target.bindingId, target.generation, "fixture", "PRIVATE_CHANGED", new Date().toISOString(), "PRIVATE_OWNER",
            { authoredContext: f.snapshot });
        } else {
          await f.store.mutateAuthoredDocument(f.workspace.id, f.document.id, { action: "archive", expectedVersion: 2, actorIdentityId: f.owner.id, timestamp: new Date().toISOString() });
        }
        return reserve(record);
      };
      assert.equal((await f.submit("commit-fence")).status, 409);
      assert.equal((await f.read("commit-fence")).status, 404);
      assert.deepEqual(await f.client.listMessages(f.channel.id), []);
    } finally { await f.close(); }
  });
}

test("HTTP acceptance resolves a post-commit lost acknowledgment by receipt before an exact retry", async () => {
  const f = await invocationFixture();
  try {
    const reserve = f.store.reserveAuthoredSkillInvocation.bind(f.store);
    f.store.reserveAuthoredSkillInvocation = async record => {
      await reserve(record);
      throw new Error("PRIVATE_AFTER_COMMIT_ERROR");
    };
    const failed = await f.submit("lost-ack");
    assert.equal(failed.status, 409);
    assert.doesNotMatch(await failed.text(), /PRIVATE_AFTER_COMMIT_ERROR|PRIVATE_PROCEDURE/);
    f.store.reserveAuthoredSkillInvocation = reserve;
    const inspected = await f.read("lost-ack");
    assert.equal(inspected.status, 200);
    const receipt = await inspected.json();
    const retry = await f.submit("lost-ack");
    assert.equal(retry.status, 202);
    assert.deepEqual(await retry.json(), receipt);
    assert.equal((await f.submit("lost-ack", { ...f.input, arguments: "changed" })).status, 409);
    assert.deepEqual(await f.client.listMessages(f.channel.id), [], "Even uncertain acceptance never sends a bare request");
  } finally { await f.close(); }
});

test("HTTP effective status is Unavailable for unresolved/corrupt pinned instructions, not ordinary Pending", async () => {
  const f = await fixture();
  const { createClient } = createRequire(import.meta.resolve("@minu/channels-relay-storage-drizzle"))("@libsql/client");
  const raw = createClient({ url: f.relayDatabaseUrl });
  try {
    const document = await (await f.request(f.path, "POST", { kind: "instructions", content: "PRIVATE_OLD_INSTRUCTIONS" })).json() as LocalAuthoredDocument;
    const documentPath = `${f.path}/${document.id}`;
    assert.equal((await f.request(documentPath, "PATCH", { action: "publish", expectedVersion: 1 })).status, 200);
    const snapshot = await captureAuthoredContext(f.store, f.workspace.id, f.channel.id);
    const now = new Date().toISOString();
    await f.store.putAgentConfig({ id: "availability-config", workspaceId: f.workspace.id, agentIdentityId: f.agent.id, status: "active", createdAt: now, updatedAt: now });
    await f.store.putBinding({ id: "availability-binding", workspaceAgentConfigId: "availability-config", workspaceId: f.workspace.id,
      conversationId: f.channel.id, agentIdentityId: f.agent.id, runtimeAdapter: "fixture", runtimeSessionId: "PRIVATE_SESSION", runtimeOwnerId: "PRIVATE_OWNER",
      generation: 1, state: "connected", wakePolicy: "mentions", createdAt: now, updatedAt: now }, { authoredContext: snapshot });
    assert.equal((await f.request(documentPath, "PATCH", { action: "save", expectedVersion: 2, content: "PRIVATE_CURRENT_INSTRUCTIONS" })).status, 200);
    assert.equal((await f.request(documentPath, "PATCH", { action: "publish", expectedVersion: 3 })).status, 200);
    const read = async () => {
      const response = await f.request(`/local/conversations/${f.channel.id}/authored-context`);
      assert.equal(response.status, 200);
      const body = await response.json() as LocalConversationAuthoredContext;
      assert.doesNotMatch(JSON.stringify(body.agents), /PRIVATE_OLD|PRIVATE_CURRENT|PRIVATE_SESSION|PRIVATE_OWNER/);
      return body.agents[0]!;
    };
    assert.equal((await read()).status, "pending", "A resolvable old publication really is Pending");
    for (const ref of [{ ...snapshot.documents[0]!, revision: 999 }, { ...snapshot.documents[0]!, contentHash: "f".repeat(64) }]) {
      await raw.execute({ sql: "UPDATE conversation_agent_session_history SET authored_context = ? WHERE binding_id = ?",
        args: [JSON.stringify({ ...snapshot, documents: [ref] }), "availability-binding"] });
      const agent = await read();
      assert.equal(agent.status, "unavailable");
      assert.equal(agent.applied, undefined);
    }
    await raw.execute({ sql: "UPDATE conversation_agent_session_history SET authored_context = ? WHERE binding_id = ?",
      args: [JSON.stringify(snapshot), "availability-binding"] });
    assert.equal((await read()).status, "pending");
    await raw.execute({ sql: "UPDATE authored_document_revisions SET content = ? WHERE document_id = ? AND revision = 1",
      args: ["PRIVATE_CORRUPTED_OLD_BODY", document.id] });
    assert.equal((await read()).status, "unavailable", "A current healthy publication must not hide a corrupt pinned body");
  } finally { raw.close(); await f.close(); }
});
