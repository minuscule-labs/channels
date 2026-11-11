import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { ConversationClient, ConversationService, createConversationHttpServer, createResourceId, type ConversationMetadata } from "@minu/channels-core";
import { defaultConversationMigrationsFolder, DrizzleLibSqlConversationStorage, localLibSqlUrl } from "../src/storage.ts";
import { createV006ChannelsDatabase } from "./v006-fixture.ts";

// Acceptance 1–5: real public collaboration storage, never the user's database.
// Proposed contract: https://notes.minusculelabs.com/notes/note_01a1a10ef7bc7138b2480b16e04e6e90
interface Folder { id: string; workspaceId: string; name: string; createdAt: string; updatedAt: string }
type FiledMetadata = ConversationMetadata & { folderId: string | null };

async function openDatabase(url: string) {
  const storage = await DrizzleLibSqlConversationStorage.open({ url });
  try {
    const server = await createConversationHttpServer({ service: new ConversationService(storage) });
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const request = async <T>(path: string, status: number | readonly number[], method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(`${server.endpoint}${path}`, {
        method,
        headers: { authorization: `Bearer ${server.serviceToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const allowed = typeof status === "number" ? [status] : status;
      assert.ok(allowed.includes(response.status), `${method} ${path}: expected ${allowed.join(" or ")}, got ${response.status}: ${text}`);
      return JSON.parse(text) as T;
    };
    return { storage, server, client, request, url };
  } catch (error) {
    await storage.close();
    throw error;
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "channels-folders-"));
  let database: Awaited<ReturnType<typeof openDatabase>> | undefined;
  t.after(async () => {
    try { await database?.server.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  database = await openDatabase(localLibSqlUrl(join(directory, "conversations.db")));
  const owner = await database.client.createIdentity({ type: "human" });
  const workspace = await database.client.createWorkspace({ slug: "folders", name: "Folders" });
  await database.client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  const conversation = await database.client.createConversation({
    workspaceId: workspace.id, participantIds: [owner.id], actorIdentityId: owner.id, name: "Keep me",
  });
  return { database, owner, workspace, conversation, catalogue: `/workspaces/${workspace.id}/folders` };
}

async function snapshot(client: ReturnType<typeof createClient>) {
  const result: Record<string, unknown> = {};
  // Explicit pre-feature columns prevent the new nullable assignment column from
  // masking rewrites of existing Conversation or thread data.
  result.conversations = (await client.execute(`SELECT id, workspace_id, name, created_at, next_sequence, roster_revision,
    parent_conversation_id, root_message_id, thread_context_json FROM conversations ORDER BY id`)).rows;
  for (const [table, order] of [
    ["identities", "id"], ["workspaces", "id"], ["workspace_members", "workspace_id, identity_id"],
    ["participants", "conversation_id, id"], ["messages", "conversation_id, sequence"],
    ["message_idempotency", "conversation_id, participant_id, idempotency_key"],
    ["response_deliveries", "conversation_id, participant_id, trigger_message_id"],
    ["agent_cursors", "conversation_id, participant_id"], ["conversation_lifecycles", "conversation_id"],
    ["conversation_attachments", "id"],
  ]) {
    const columns = table === "messages" ? "id, conversation_id, sequence, participant_id, targets_json, body, reply_to, created_at" : "*";
    result[table!] = (await client.execute(`SELECT ${columns} FROM ${table} ORDER BY ${order}`)).rows;
  }
  return result;
}

test("folder migration upgrades a populated pre-folder database without rewriting collaboration data", async (t) => {
  const legacy = await createV006ChannelsDatabase();
  let database: Awaited<ReturnType<typeof openDatabase>> | undefined;
  t.after(async () => {
    try { await database?.server.close(); }
    finally { await legacy.close(); }
  });
  const raw = createClient({ url: legacy.url });
  let before: Awaited<ReturnType<typeof snapshot>>;
  const root = {
    id: "message_root", conversationId: "conversation_parent", sequence: 1, participantId: "identity_owner",
    to: ["identity_agent"], body: "Preserved root", createdAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    // Freeze the baseline at 0010 (threads). Do NOT use all current migrations:
    // adding the folder migration must exercise a genuine upgrade, not a fresh DB.
    const preFolderMigrations = readMigrationFiles({ migrationsFolder: defaultConversationMigrationsFolder() }).slice(7, 11);
    assert.equal(preFolderMigrations.length, 4);
    for (const migration of preFolderMigrations) {
      for (const statement of migration.sql) await raw.execute(statement);
      await raw.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [migration.hash, migration.folderMillis] });
    }
    assert.equal((await raw.execute("PRAGMA table_info(conversations)")).rows.some(({ name }) => name === "folder_id"), false);
    await raw.executeMultiple(`
      INSERT INTO identities (id, type, status, created_at, updated_at) VALUES
        ('identity_owner', 'human', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('identity_agent', 'agent', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES
        ('workspace_legacy', 'legacy', 'Legacy', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO workspace_members (workspace_id, identity_id, mention_handle, access_role, status, joined_at, updated_at) VALUES
        ('workspace_legacy', 'identity_owner', 'owner', 'owner', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('workspace_legacy', 'identity_agent', 'agent', 'member', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, workspace_id, name, created_at, next_sequence, roster_revision) VALUES
        ('conversation_parent', 'workspace_legacy', 'Parent', '2026-01-01T00:00:00.000Z', 3, 3),
        ('conversation_snoozed', 'workspace_legacy', 'Snoozed', '2026-01-01T00:00:00.000Z', 1, 1),
        ('conversation_settled', 'workspace_legacy', 'Settled', '2026-01-01T00:00:00.000Z', 1, 1);
      INSERT INTO messages (id, conversation_id, sequence, participant_id, targets_json, body, created_at) VALUES
        ('message_root', 'conversation_parent', 1, 'identity_owner', '["identity_agent"]', 'Preserved root', '2026-01-01T00:00:00.000Z'),
        ('message_response', 'conversation_parent', 2, 'identity_agent', '[]', 'Preserved answer', '2026-01-01T00:00:01.000Z');
      INSERT INTO message_idempotency (conversation_id, participant_id, idempotency_key, request_fingerprint, message_id, created_at) VALUES
        ('conversation_parent', 'identity_owner', 'root-key', 'root-fingerprint', 'message_root', '2026-01-01T00:00:00.000Z');
      INSERT INTO response_deliveries (conversation_id, participant_id, trigger_message_id, trigger_sequence, response_message_id, created_at) VALUES
        ('conversation_parent', 'identity_agent', 'message_root', 1, 'message_response', '2026-01-01T00:00:01.000Z');
      INSERT INTO agent_cursors (conversation_id, participant_id, last_processed_sequence, updated_at) VALUES
        ('conversation_parent', 'identity_agent', 2, '2026-01-01T00:00:01.000Z');
      INSERT INTO conversation_lifecycles (conversation_id, workspace_id, state, snoozed_until, settled_at, created_at, updated_at) VALUES
        ('conversation_snoozed', 'workspace_legacy', 'snoozed', '9999-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('conversation_settled', 'workspace_legacy', 'settled', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    await raw.execute({
      sql: `INSERT INTO conversations (id, workspace_id, name, created_at, next_sequence, roster_revision, parent_conversation_id, root_message_id, thread_context_json)
        VALUES ('conversation_thread', 'workspace_legacy', 'Thread', '2026-01-01T00:00:00.000Z', 2, 3, 'conversation_parent', 'message_root', ?)`,
      args: [JSON.stringify([root])],
    });
    for (const conversationId of ["conversation_parent", "conversation_thread", "conversation_snoozed", "conversation_settled"]) {
      for (const [identityId, type, handle, position] of [["identity_owner", "human", "owner", 0], ["identity_agent", "agent", "agent", 1]] as const) {
        await raw.execute({
          sql: "INSERT INTO participants (conversation_id, id, type, handle, status, position) VALUES (?, ?, ?, ?, 'active', ?)",
          args: [conversationId, identityId, type, handle, position],
        });
      }
    }
    await raw.executeMultiple(`
      INSERT INTO messages (id, conversation_id, sequence, participant_id, targets_json, body, created_at) VALUES
        ('message_reply', 'conversation_thread', 1, 'identity_owner', '[]', 'Thread-only reply', '2026-01-01T00:00:02.000Z');
      INSERT INTO agent_cursors (conversation_id, participant_id, last_processed_sequence, updated_at) VALUES
        ('conversation_thread', 'identity_agent', 1, '2026-01-01T00:00:02.000Z');
    `);
    assert.deepEqual((await raw.execute("PRAGMA foreign_key_check")).rows, []);
    before = await snapshot(raw);
  } finally { raw.close(); }

  database = await openDatabase(legacy.url);
  const after = createClient({ url: legacy.url });
  try {
    assert.deepEqual(await snapshot(after), before);
    assert.ok((await after.execute("SELECT authored_invocation_id FROM messages")).rows.every(row => row.authored_invocation_id === null));
    assert.deepEqual((await after.execute("PRAGMA foreign_key_check")).rows, []);
    const assignmentColumn = (await after.execute("PRAGMA table_info(conversations)")).rows.find(({ name }) => name === "folder_id");
    assert.ok(assignmentColumn, "migration must add the persisted assignment column");
    assert.equal(assignmentColumn.notnull, 0, "existing Conversations must not need a folder backfill");
    assert.deepEqual((await after.execute("SELECT folder_id FROM conversations WHERE parent_conversation_id IS NULL")).rows, [
      { folder_id: null }, { folder_id: null }, { folder_id: null },
    ]);
  } finally { after.close(); }
  assert.deepEqual((await database.request<{ folders: Folder[] }>("/workspaces/workspace_legacy/folders", 200)).folders, []);
  const conversations = await database.request<{ conversations: FiledMetadata[] }>("/workspaces/workspace_legacy/conversations", 200);
  assert.deepEqual(new Set(conversations.conversations.map(({ id }) => id)), new Set(["conversation_parent", "conversation_snoozed", "conversation_settled"]));
  for (const conversation of conversations.conversations) assert.equal(conversation.folderId, null);
  assert.deepEqual((await database.client.getConversation("conversation_thread")).thread, {
    parentConversationId: "conversation_parent", rootMessageId: "message_root", context: [root],
  });
  assert.equal(await database.client.getCursor("conversation_parent", "identity_agent"), 2);
  assert.equal(await database.client.getCursor("conversation_thread", "identity_agent"), 1);
  assert.equal((await database.client.getConversationLifecycle("conversation_snoozed")).state, "snoozed");
  assert.equal((await database.client.getConversationLifecycle("conversation_settled")).state, "settled");
  const message = await database.client.postMessage("conversation_parent", { participantId: "identity_owner", body: "Usable after upgrade" });
  assert.equal(message.sequence, 3);
  await database.server.close();
  Object.assign(database, await openDatabase(legacy.url));
  assert.equal((await database.client.listMessages("conversation_parent"))[2]?.id, message.id);
});

test("folder catalogue, creation-time assignments, moves and Unfiled survive libSQL reopen", async (t) => {
  const f = await fixture(t);
  const { folder } = await f.database.request<{ folder: Folder }>(f.catalogue, 201, "POST", { actorIdentityId: f.owner.id, name: "Engineering" });
  const { folder: empty } = await f.database.request<{ folder: Folder }>(f.catalogue, 201, "POST", { actorIdentityId: f.owner.id, name: "Empty" });
  const root = await f.database.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "Keep my transcript" });
  const thread = await f.database.client.createThread(f.conversation.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
  const before = await f.database.client.getConversation(f.conversation.id);
  const beforeThread = await f.database.client.getConversation(thread.id);
  const { conversation: created } = await f.database.request<{ conversation: FiledMetadata }>("/conversations", 201, "POST", {
    workspaceId: f.workspace.id, participantIds: [f.owner.id], actorIdentityId: f.owner.id, folderId: folder.id,
  });
  await f.database.request(`/conversations/${f.conversation.id}/folder`, 200, "PATCH", { actorIdentityId: f.owner.id, folderId: folder.id });
  const { folder: renamed } = await f.database.request<{ folder: Folder }>(`${f.catalogue}/${folder.id}`, 200, "PATCH", { actorIdentityId: f.owner.id, name: "Platform" });
  await f.database.server.close();
  Object.assign(f.database, await openDatabase(f.database.url));
  const catalogue = await f.database.request<{ folders: Folder[] }>(f.catalogue, 200);
  assert.deepEqual(new Map(catalogue.folders.map((item) => [item.id, item])), new Map([[renamed.id, renamed], [empty.id, empty]]));
  for (const id of [f.conversation.id, created.id]) {
    assert.equal((await f.database.request<{ conversation: FiledMetadata }>(`/conversations/${id}`, 200)).conversation.folderId, folder.id);
  }
  const { folderId: _folderId, ...after } = (await f.database.request<{ conversation: FiledMetadata }>(`/conversations/${f.conversation.id}`, 200)).conversation;
  const { folderId: _beforeFolderId, ...beforeWithoutFolder } = before as FiledMetadata;
  assert.deepEqual(after, beforeWithoutFolder);
  const { folderId: _threadFolderId, ...afterThread } = await f.database.client.getConversation(thread.id) as FiledMetadata;
  const { folderId: _beforeThreadFolderId, ...beforeThreadWithoutFolder } = beforeThread as FiledMetadata;
  assert.deepEqual(afterThread, beforeThreadWithoutFolder);
  assert.deepEqual((await f.database.client.listMessages(f.conversation.id)).map(({ id }) => id), [root.id]);
  await f.database.request(`/conversations/${f.conversation.id}/folder`, 200, "PATCH", { actorIdentityId: f.owner.id, folderId: null });
  await f.database.server.close();
  Object.assign(f.database, await openDatabase(f.database.url));
  assert.equal((await f.database.request<{ conversation: FiledMetadata }>(`/conversations/${f.conversation.id}`, 200)).conversation.folderId, null);
  assert.equal((await f.database.request<{ conversation: FiledMetadata }>(`/conversations/${created.id}`, 200)).conversation.folderId, folder.id);
});

test("libSQL storage rejects missing folder references before committing a Conversation or roster", async (t) => {
  const f = await fixture(t);
  const candidate = { ...f.conversation, id: createResourceId("conversation"), messages: [], folderId: "folder_missing" };
  await assert.rejects(f.database.storage.createConversation(candidate));
  assert.equal(await f.database.storage.getConversation(candidate.id), undefined);
  const raw = createClient({ url: f.database.url });
  try {
    assert.deepEqual((await raw.execute({ sql: "SELECT id FROM participants WHERE conversation_id = ?", args: [candidate.id] })).rows, []);
    assert.deepEqual((await raw.execute("PRAGMA foreign_key_check")).rows, []);
  } finally { raw.close(); }
});

test("libSQL storage independently enforces same-Workspace membership and rejects filed threads", async (t) => {
  const f = await fixture(t);
  const { folder } = await f.database.request<{ folder: Folder }>(f.catalogue, 201, "POST", { actorIdentityId: f.owner.id, name: "Engineering" });
  const other = await f.database.client.createWorkspace({ slug: "other", name: "Other" });
  await f.database.client.addWorkspaceMember(other.id, { identityId: f.owner.id, mentionHandle: "owner", accessRole: "owner" });
  const root = await f.database.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "Unused thread root" });
  for (const candidate of [
    { ...f.conversation, id: createResourceId("conversation"), workspaceId: other.id, messages: [], folderId: folder.id },
    { ...f.conversation, id: createResourceId("conversation"), messages: [], folderId: folder.id,
      thread: { parentConversationId: f.conversation.id, rootMessageId: root.id, context: [root] } },
  ]) {
    await assert.rejects(f.database.storage.createConversation(candidate));
    assert.equal(await f.database.storage.getConversation(candidate.id), undefined);
    const raw = createClient({ url: f.database.url });
    try {
      assert.deepEqual((await raw.execute({ sql: "SELECT id FROM participants WHERE conversation_id = ?", args: [candidate.id] })).rows, []);
    } finally { raw.close(); }
  }
});

test("concurrent case-insensitive folder creation commits exactly one durable folder", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.database.request<{ folders: Folder[] }>(f.catalogue, 200)).folders, []);
  const results = await Promise.all(["Engineering", "  engineering  "].map(async (name) => {
    const response = await fetch(`${f.database.server.endpoint}${f.catalogue}`, {
      method: "POST", headers: { authorization: `Bearer ${f.database.server.serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ actorIdentityId: f.owner.id, name }),
    });
    return { status: response.status, body: await response.json() as { folder?: Folder; error?: string } };
  }));
  assert.equal(results.filter(({ status }) => status === 201).length, 1);
  const rejected = results.find(({ status }) => status !== 201)!;
  assert.ok([400, 409].includes(rejected.status), JSON.stringify(results));
  assert.equal(typeof rejected.body.error, "string");
  const created = results.find(({ status }) => status === 201)!.body.folder!;
  await f.database.server.close();
  Object.assign(f.database, await openDatabase(f.database.url));
  const { folders } = await f.database.request<{ folders: Folder[] }>(f.catalogue, 200);
  assert.deepEqual(folders, [created]);
  assert.equal(created.name, created.name.trim());
});
