import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConversationClient } from "../src/client.ts";
import { ConversationService } from "../src/conversation-service.ts";
import { createConversationHttpServer, type ConversationHttpServer } from "../src/http-server.ts";
import { InMemoryConversationStorage } from "../src/storage.ts";
import { createResourceId } from "../src/ids.ts";
import type { Conversation, ConversationEvent, ConversationMetadata } from "../src/types.ts";

// Specification-first coverage for acceptance 2–5 in the feature plan:
// https://notes.minusculelabs.com/notes/note_01a1a10ef7bc7138b2480b16e04e6e90
// The routes, response envelopes, explicit null for Unfiled, and naming/role
// defaults are the proposed contract, not evidence of feature implementation.
interface Folder {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
type FiledMetadata = ConversationMetadata & { folderId: string | null };

async function request<T>(
  server: ConversationHttpServer,
  path: string,
  expectedStatus: number | readonly number[],
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${server.endpoint}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.serviceToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const allowed = typeof expectedStatus === "number" ? [expectedStatus] : expectedStatus;
  assert.ok(allowed.includes(response.status), `${method} ${path}: expected ${allowed.join(" or ")}, got ${response.status}: ${text}`);
  const result = JSON.parse(text) as T;
  if (response.status >= 400) assert.equal(typeof (result as { error?: unknown }).error, "string");
  return result;
}

async function fixture(t: TestContext) {
  const storage = new InMemoryConversationStorage();
  const server = await createConversationHttpServer({ service: new ConversationService(storage) });
  t.after(() => server.close());
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const admin = await client.createIdentity({ type: "human", displayName: "Admin" });
  const member = await client.createIdentity({ type: "human", displayName: "Member" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
  const workspace = await client.createWorkspace({ slug: "folder-tests", name: "Folder tests" });
  for (const [identity, mentionHandle, accessRole] of [
    [owner, "owner", "owner"], [admin, "admin", "admin"],
    [member, "member", "member"], [agent, "agent", "member"],
  ] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle, accessRole });
  }
  const conversation = await client.createConversation({
    workspaceId: workspace.id, name: "Keep this name", actorIdentityId: owner.id,
    participantIds: [owner.id, agent.id],
  });
  const catalogue = `/workspaces/${workspace.id}/folders`;
  const assignment = `/conversations/${conversation.id}/folder`;
  const createFolder = async (name = "Engineering", actorIdentityId = owner.id) => {
    const { folder } = await request<{ folder: Folder }>(server, catalogue, 201, "POST", { name, actorIdentityId });
    assert.ok(folder.id);
    assert.equal(folder.workspaceId, workspace.id);
    return folder;
  };
  const folders = async () => (await request<{ folders: Folder[] }>(server, catalogue, 200)).folders;
  const metadata = async () => (await request<{ conversation: FiledMetadata }>(server, `/conversations/${conversation.id}`, 200)).conversation;
  return { storage, server, client, owner, admin, member, agent, workspace, conversation, catalogue, assignment, createFolder, folders, metadata };
}

function withoutFolder<T extends ConversationMetadata>(conversation: T): Omit<T, "folderId"> {
  const { folderId: _folderId, ...rest } = conversation as T & { folderId?: unknown };
  return rest;
}

test("folder catalogue supports owner/admin creation, trimmed names, stable-ID rename and empty folders", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.folders(), []);
  const before = await f.client.getConversation(f.conversation.id);
  const folder = await f.createFolder("  Engineering  ");
  assert.equal(folder.name, "Engineering");
  assert.ok(Number.isFinite(Date.parse(folder.createdAt)));
  assert.ok(Number.isFinite(Date.parse(folder.updatedAt)));
  const empty = await f.createFolder("x".repeat(100), f.admin.id);
  assert.notEqual(empty.id, folder.id);
  assert.equal(empty.name.length, 100);
  const { folder: renamed } = await request<{ folder: Folder }>(f.server, `${f.catalogue}/${folder.id}`, 200, "PATCH", {
    actorIdentityId: f.admin.id, name: "  Platform  ",
  });
  assert.equal(renamed.id, folder.id);
  assert.equal(renamed.workspaceId, folder.workspaceId);
  assert.equal(renamed.createdAt, folder.createdAt);
  assert.equal(renamed.name, "Platform");
  assert.deepEqual(new Set((await f.folders()).map(({ id }) => id)), new Set([folder.id, empty.id]));
  assert.deepEqual(await f.client.getConversation(f.conversation.id), before, "catalogue edits must not change Conversations");
});

test("folder name validation and case-insensitive uniqueness reject changes without partial mutation", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const other = await f.createFolder("Research");
  const baseline = await f.folders();
  for (const name of [undefined, null, "", " \t\n ", "x".repeat(101), 42, {}, []]) {
    await request(f.server, f.catalogue, 400, "POST", { actorIdentityId: f.owner.id, name });
    await request(f.server, `${f.catalogue}/${folder.id}`, 400, "PATCH", { actorIdentityId: f.owner.id, name });
    assert.deepEqual(await f.folders(), baseline);
  }
  for (const body of [null, [], 42, "not-an-object"]) {
    await request(f.server, f.catalogue, 400, "POST", body);
    await request(f.server, `${f.catalogue}/${folder.id}`, 400, "PATCH", body);
    assert.deepEqual(await f.folders(), baseline);
  }
  for (const name of ["Engineering", "engineering", "  ENGINEERING  "]) {
    await request(f.server, f.catalogue, [400, 409], "POST", { actorIdentityId: f.owner.id, name });
    await request(f.server, `${f.catalogue}/${other.id}`, [400, 409], "PATCH", { actorIdentityId: f.owner.id, name });
    assert.deepEqual(await f.folders(), baseline);
  }
  const second = await f.client.createWorkspace({ slug: "other", name: "Other" });
  await f.client.addWorkspaceMember(second.id, { identityId: f.owner.id, mentionHandle: "owner", accessRole: "owner" });
  const { folder: sameName } = await request<{ folder: Folder }>(f.server, `/workspaces/${second.id}/folders`, 201, "POST", {
    actorIdentityId: f.owner.id, name: "Engineering",
  });
  assert.notEqual(sameName.id, folder.id);
  assert.equal(sameName.workspaceId, second.id);
  assert.deepEqual(await f.folders(), baseline);
});

test("Conversation creation accepts a valid folder and normalizes omitted or null assignments to Unfiled", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const input = { workspaceId: f.workspace.id, participantIds: [f.owner.id], actorIdentityId: f.owner.id };
  for (const fields of [{}, { folderId: null }, { folderId: folder.id }]) {
    const { conversation } = await request<{ conversation: FiledMetadata }>(f.server, "/conversations", 201, "POST", { ...input, ...fields });
    const expected = "folderId" in fields ? fields.folderId : null;
    assert.equal(conversation.folderId, expected);
    const fetched = await request<{ conversation: FiledMetadata }>(f.server, `/conversations/${conversation.id}`, 200);
    assert.equal(fetched.conversation.folderId, expected);
    const listed = await request<{ conversations: FiledMetadata[] }>(f.server, `/workspaces/${f.workspace.id}/conversations`, 200);
    assert.equal(listed.conversations.find(({ id }) => id === conversation.id)?.folderId, expected);
  }
});

test("invalid folder input cannot create a partially filed or silently Unfiled Conversation", async (t) => {
  const f = await fixture(t);
  const before = await f.client.listWorkspaceConversations(f.workspace.id);
  for (const [folderId, status] of [["folder_missing", [400, 404]], ["", 400], ["   ", 400], [123, 400], [false, 400], [{}, 400], [[], 400]] as const) {
    await request(f.server, "/conversations", status, "POST", {
      workspaceId: f.workspace.id, participantIds: [f.owner.id], actorIdentityId: f.owner.id, folderId,
    });
    assert.deepEqual(await f.client.listWorkspaceConversations(f.workspace.id), before);
  }
});

test("file, move, rename folder and unfile preserve messages, cursors, roster and thread ancestry", async (t) => {
  const f = await fixture(t);
  const source = await f.createFolder();
  const target = await f.createFolder("Research");
  const root = await f.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "Parent root", to: [f.agent.id] });
  const thread = await f.client.createThread(f.conversation.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
  await f.client.postMessage(thread.id, { participantId: f.owner.id, body: "Thread-only reply" });
  await f.storage.setCursor(f.conversation.id, f.agent.id, root.sequence);
  await f.storage.setCursor(thread.id, f.agent.id, 1);
  const before = await f.server.service.getConversation(f.conversation.id);
  const beforeThread = await f.server.service.getConversation(thread.id);
  const beforeLifecycle = await f.client.getConversationLifecycle(f.conversation.id);
  const events: ConversationEvent[] = [];
  const observedFolders: unknown[] = [];
  const unsubscribe = await f.server.service.subscribe(f.conversation.id, async (event) => {
    events.push(event);
    observedFolders.push((await f.storage.getConversationMetadata(f.conversation.id) as FiledMetadata).folderId);
  });
  t.after(unsubscribe);
  for (const folderId of [source.id, target.id, null]) {
    const { conversation } = await request<{ conversation: FiledMetadata }>(f.server, f.assignment, 200, "PATCH", { actorIdentityId: f.admin.id, folderId });
    assert.equal(conversation.id, f.conversation.id);
    assert.equal(conversation.folderId, folderId);
    assert.equal((await f.metadata()).folderId, folderId);
    assert.deepEqual(withoutFolder(await f.server.service.getConversation(f.conversation.id)), withoutFolder(before));
    assert.deepEqual(withoutFolder(await f.server.service.getConversation(thread.id)), withoutFolder(beforeThread));
    assert.deepEqual(await f.client.getConversationLifecycle(f.conversation.id), beforeLifecycle);
    assert.equal(await f.client.getCursor(f.conversation.id, f.agent.id), root.sequence);
    assert.equal(await f.client.getCursor(thread.id, f.agent.id), 1);
    const listed = await request<{ conversations: FiledMetadata[] }>(f.server, `/workspaces/${f.workspace.id}/conversations`, 200);
    assert.equal(listed.conversations.find(({ id }) => id === f.conversation.id)?.folderId, folderId);
    if (folderId === source.id) {
      await request(f.server, `${f.catalogue}/${source.id}`, 200, "PATCH", { actorIdentityId: f.owner.id, name: "Renamed folder" });
      assert.equal((await f.metadata()).folderId, source.id, "assignment must use the stable ID, not the folder name");
    }
  }
  assert.deepEqual(events.map(({ type, conversationId }) => [type, conversationId]), Array.from({ length: 3 }, () => ["conversation.updated", f.conversation.id]));
  assert.deepEqual(observedFolders, [source.id, target.id, null], "events must observe committed assignments");
});

test("assigning the current folder or Unfiled is a no-op, including update events", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const events: ConversationEvent[] = [];
  const unsubscribe = await f.server.service.subscribe(f.conversation.id, (event) => { events.push(event); });
  t.after(unsubscribe);
  for (const folderId of [null, folder.id]) {
    if (folderId !== null) await request(f.server, f.assignment, 200, "PATCH", { actorIdentityId: f.owner.id, folderId });
    const before = await f.metadata();
    events.length = 0;
    await request(f.server, f.assignment, 200, "PATCH", { actorIdentityId: f.owner.id, folderId });
    assert.deepEqual(await f.metadata(), before);
    assert.deepEqual(events, []);
  }
});

test("missing, malformed, cross-Workspace and independent thread assignments leave state unchanged", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const second = await f.client.createWorkspace({ slug: "second", name: "Second" });
  await f.client.addWorkspaceMember(second.id, { identityId: f.owner.id, mentionHandle: "owner", accessRole: "owner" });
  const { folder: foreign } = await request<{ folder: Folder }>(f.server, `/workspaces/${second.id}/folders`, 201, "POST", { actorIdentityId: f.owner.id, name: "Foreign" });
  const root = await f.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "Thread root" });
  const thread = await f.client.createThread(f.conversation.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
  await request(f.server, f.assignment, 200, "PATCH", { actorIdentityId: f.owner.id, folderId: folder.id });
  const before = await f.server.service.getConversation(f.conversation.id);
  const beforeThread = await f.server.service.getConversation(thread.id);
  const beforeList = await f.client.listWorkspaceConversations(f.workspace.id);
  const events: ConversationEvent[] = [];
  const unsubscribe = await f.server.service.subscribe(f.conversation.id, (event) => { events.push(event); });
  t.after(unsubscribe);
  for (const [fields, status] of [
    [{}, 400], [{ folderId: "" }, 400], [{ folderId: "  " }, 400],
    [{ folderId: 42 }, 400], [{ folderId: {} }, 400], [{ folderId: [] }, 400], [{ folderId: false }, 400],
    [{ folderId: folder.id.slice(0, -1) + (folder.id.endsWith("0") ? "1" : "0") }, 404], [{ folderId: foreign.id }, 400],
  ] as const) {
    await request(f.server, f.assignment, status, "PATCH", { actorIdentityId: f.owner.id, ...fields });
    assert.deepEqual(await f.server.service.getConversation(f.conversation.id), before);
  }
  for (const body of [null, [], 42, "not-an-object"]) {
    await request(f.server, f.assignment, 400, "PATCH", body);
    assert.deepEqual(await f.server.service.getConversation(f.conversation.id), before);
  }
  for (const folderId of [folder.id, null]) {
    await request(f.server, `/conversations/${thread.id}/folder`, 400, "PATCH", { actorIdentityId: f.owner.id, folderId });
  }
  await request(f.server, `/conversations/${createResourceId("conversation")}/folder`, 404, "PATCH", { actorIdentityId: f.owner.id, folderId: folder.id });
  const missingFolderId = folder.id.slice(0, -1) + (folder.id.endsWith("0") ? "1" : "0");
  await request(f.server, `${f.catalogue}/${missingFolderId}`, 404, "PATCH", { actorIdentityId: f.owner.id, name: "Missing" });
  await request(f.server, `${f.catalogue}/${foreign.id}`, [400, 404], "PATCH", { actorIdentityId: f.owner.id, name: "Wrong Workspace" });
  const missingWorkspace = `/workspaces/${createResourceId("workspace")}/folders`;
  await request(f.server, missingWorkspace, 404);
  await request(f.server, missingWorkspace, 404, "POST", { actorIdentityId: f.owner.id, name: "Missing Workspace" });
  await request(f.server, "/conversations", 400, "POST", {
    workspaceId: f.workspace.id, participantIds: [f.owner.id], actorIdentityId: f.owner.id, folderId: foreign.id,
  });
  assert.deepEqual(await f.server.service.getConversation(thread.id), beforeThread);
  assert.deepEqual(await f.client.listWorkspaceConversations(f.workspace.id), beforeList);
  assert.deepEqual(await f.folders(), [folder]);
  assert.deepEqual((await request<{ folders: Folder[] }>(f.server, `/workspaces/${second.id}/folders`, 200)).folders, [foreign]);
  assert.deepEqual(events, []);
});

test("folder administration rejects missing, member, nonmember and disabled actors without mutation", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const outsider = await f.client.createIdentity({ type: "human" });
  const disabledMember = await f.client.createIdentity({ type: "human" });
  const disabledIdentity = await f.client.createIdentity({ type: "human" });
  for (const [identity, mentionHandle] of [[disabledMember, "disabled-member"], [disabledIdentity, "disabled-identity"]] as const) {
    await f.client.addWorkspaceMember(f.workspace.id, { identityId: identity.id, mentionHandle, accessRole: "admin" });
  }
  await f.client.updateWorkspaceMember(f.workspace.id, disabledMember.id, { actorIdentityId: f.owner.id, status: "disabled" });
  await f.storage.updateIdentity({ ...disabledIdentity, status: "disabled" });
  const before = await f.server.service.getConversation(f.conversation.id);
  const beforeList = await f.client.listWorkspaceConversations(f.workspace.id);
  for (const actorIdentityId of [undefined, "", 42, f.member.id, outsider.id, disabledMember.id, disabledIdentity.id]) {
    await request(f.server, f.catalogue, 400, "POST", { actorIdentityId, name: "Unauthorized" });
    await request(f.server, `${f.catalogue}/${folder.id}`, 400, "PATCH", { actorIdentityId, name: "Unauthorized" });
    await request(f.server, f.assignment, 400, "PATCH", { actorIdentityId, folderId: folder.id });
    if (typeof actorIdentityId === "string" && actorIdentityId.trim()) {
      await request(f.server, "/conversations", 400, "POST", {
        workspaceId: f.workspace.id, participantIds: [f.owner.id], actorIdentityId, folderId: folder.id,
      });
    }
    assert.deepEqual(await f.folders(), [folder]);
    assert.deepEqual(await f.server.service.getConversation(f.conversation.id), before);
    assert.deepEqual(await f.client.listWorkspaceConversations(f.workspace.id), beforeList);
  }
  // The core service credential is not a per-human confidentiality boundary.
  // Ordinary members' navigation visibility is exercised through the gateway.
});

test("archived Workspace guards apply to folder creation, rename and assignment", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const before = await f.server.service.getConversation(f.conversation.id);
  await f.storage.updateWorkspace({ ...f.workspace, status: "archived" });
  await request(f.server, f.catalogue, 400, "POST", { actorIdentityId: f.owner.id, name: "Blocked" });
  await request(f.server, `${f.catalogue}/${folder.id}`, 400, "PATCH", { actorIdentityId: f.owner.id, name: "Blocked" });
  await request(f.server, f.assignment, 400, "PATCH", { actorIdentityId: f.owner.id, folderId: folder.id });
  assert.deepEqual(await f.server.service.getConversation(f.conversation.id), before);
  assert.deepEqual(await f.folders(), [folder]);
});

test("Snoozed Conversations may move; reopen retains assignment and Settled moves require reopening", async (t) => {
  const f = await fixture(t);
  const source = await f.createFolder();
  const target = await f.createFolder("Research");
  await request(f.server, f.assignment, 200, "PATCH", { actorIdentityId: f.owner.id, folderId: source.id });
  const snoozed = await f.client.updateConversationLifecycle(f.conversation.id, {
    actorIdentityId: f.owner.id, state: "snoozed", snoozedUntil: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal((await f.metadata()).folderId, source.id);
  await request(f.server, f.assignment, 200, "PATCH", { actorIdentityId: f.owner.id, folderId: target.id });
  assert.deepEqual(await f.client.getConversationLifecycle(f.conversation.id), snoozed);
  await f.client.updateConversationLifecycle(f.conversation.id, { actorIdentityId: f.owner.id, state: "active" });
  assert.equal((await f.metadata()).folderId, target.id);
  const settled = await f.client.updateConversationLifecycle(f.conversation.id, { actorIdentityId: f.owner.id, state: "settled" });
  const before = await f.server.service.getConversation(f.conversation.id);
  for (const folderId of [source.id, null]) {
    await request(f.server, f.assignment, 400, "PATCH", { actorIdentityId: f.owner.id, folderId });
    assert.deepEqual(await f.server.service.getConversation(f.conversation.id), before);
    assert.deepEqual(await f.client.getConversationLifecycle(f.conversation.id), settled);
  }
  await f.client.updateConversationLifecycle(f.conversation.id, { actorIdentityId: f.owner.id, state: "active" });
  assert.equal((await f.metadata()).folderId, target.id);
  await request(f.server, f.assignment, 200, "PATCH", { actorIdentityId: f.owner.id, folderId: source.id });
  assert.equal((await f.metadata()).folderId, source.id);
});

test("in-memory storage rejects a missing folder at Conversation creation, without storing participants", async (t) => {
  const f = await fixture(t);
  const candidate = { ...f.conversation, id: createResourceId("conversation"), folderId: "folder_missing", messages: [] };
  await assert.rejects(f.storage.createConversation(candidate));
  assert.equal(await f.storage.getConversation(candidate.id), undefined);
  assert.deepEqual((await f.storage.listWorkspaceConversations(f.workspace.id)).map(({ id }) => id), [f.conversation.id]);
});

test("in-memory storage independently rejects cross-Workspace references and filed thread creation", async (t) => {
  const f = await fixture(t);
  const folder = await f.createFolder();
  const other = await f.client.createWorkspace({ slug: "storage-other", name: "Storage other" });
  await f.client.addWorkspaceMember(other.id, { identityId: f.owner.id, mentionHandle: "owner", accessRole: "owner" });
  await f.client.addWorkspaceMember(other.id, { identityId: f.agent.id, mentionHandle: "agent" });
  const crossWorkspace = { ...f.conversation, id: createResourceId("conversation"), workspaceId: other.id, folderId: folder.id, messages: [] };
  await assert.rejects(f.storage.createConversation(crossWorkspace));
  assert.equal(await f.storage.getConversation(crossWorkspace.id), undefined);
  const root = await f.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "Unused root" });
  const thread: Conversation & { folderId: string } = {
    ...f.conversation, id: createResourceId("conversation"), messages: [], folderId: folder.id,
    thread: { parentConversationId: f.conversation.id, rootMessageId: root.id, context: [root] },
  };
  await assert.rejects(f.storage.createConversation(thread));
  assert.equal(await f.storage.getConversation(thread.id), undefined);
});
