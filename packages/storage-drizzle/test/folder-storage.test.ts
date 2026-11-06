import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  ConversationFolderConflictError,
  ConversationService,
  createResourceId,
  InMemoryConversationStorage,
  type ConversationFolder,
  type ConversationStorage,
} from "@minu/channels-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { defaultConversationMigrationsFolder, DrizzleLibSqlConversationStorage, localLibSqlUrl } from "../src/storage.ts";
import { createV006ChannelsDatabase } from "./v006-fixture.ts";

// Direct storage contracts missing from the original HTTP acceptance batch.
// They do not require the service/API ticket's unimplemented folder routes.
async function fixture(t: TestContext, kind: "memory" | "libsql") {
  const directory = await mkdtemp(join(tmpdir(), "channels-folder-storage-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  const storage: ConversationStorage = kind === "memory"
    ? new InMemoryConversationStorage()
    : await DrizzleLibSqlConversationStorage.open({ url });
  const stores = [storage];
  t.after(async () => {
    try { for (const current of [...stores].reverse()) await current.close?.(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const service = new ConversationService(storage);
  const owner = await service.createIdentity({ type: "human" });
  const workspace = await service.createWorkspace({ slug: "folders", name: "Folders" });
  const other = await service.createWorkspace({ slug: "other", name: "Other" });
  for (const candidate of [workspace, other]) {
    await service.addWorkspaceMember(candidate.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  }
  const conversation = await service.createConversation({ workspaceId: workspace.id, participantIds: [owner.id], name: "Preserve me" });
  const folder = (name: string, workspaceId = workspace.id): ConversationFolder => ({
    id: createResourceId("folder"), workspaceId, name,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const writers = async () => {
    if (kind === "memory") return [storage];
    const second = await DrizzleLibSqlConversationStorage.open({ url });
    stores.push(second);
    return [storage, second];
  };
  return { storage, service, owner, workspace, other, conversation, folder, url, writers };
}

for (const kind of ["memory", "libsql"] as const) {
  test(`${kind} folder storage validates names, stable IDs, isolation and concurrent uniqueness`, async (t) => {
    const f = await fixture(t, kind);
    const engineering = await f.storage.createConversationFolder(f.folder("  Engineering  "));
    assert.equal(engineering.name, "Engineering");
    const empty = await f.storage.createConversationFolder(f.folder("Empty"));
    const foreign = await f.storage.createConversationFolder(f.folder("engineering", f.other.id));
    assert.deepEqual(await f.storage.listWorkspaceConversationFolders(f.workspace.id), [empty, engineering]);
    assert.deepEqual(await f.storage.listWorkspaceConversationFolders(f.other.id), [foreign]);
    assert.deepEqual(await f.storage.listWorkspaceConversationFolders("missing"), []);
    for (const name of ["", "  ", "x".repeat(101)]) {
      await assert.rejects(f.storage.createConversationFolder(f.folder(name)));
      await assert.rejects(f.storage.updateConversationFolderName(empty.id, name, empty.updatedAt));
    }
    await assert.rejects(f.storage.createConversationFolder(f.folder("engineering")), ConversationFolderConflictError);
    await assert.rejects(f.storage.createConversationFolder({ ...foreign, name: "Another" }), ConversationFolderConflictError);
    await assert.rejects(f.storage.createConversationFolder(f.folder("Missing Workspace", "missing")));
    await assert.rejects(f.storage.updateConversationFolderName(empty.id, "  ENGINEERING ", empty.updatedAt), ConversationFolderConflictError);
    assert.deepEqual(await f.storage.getConversationFolder(empty.id), empty);
    const renamed = await f.storage.updateConversationFolderName(engineering.id, " Platform ", "2026-01-02T00:00:00.000Z");
    assert.deepEqual(renamed, { ...engineering, name: "Platform", updatedAt: "2026-01-02T00:00:00.000Z" });
    assert.equal(await f.storage.getConversationFolder("missing"), undefined);
    assert.equal(await f.storage.updateConversationFolderName("missing", "Valid", empty.updatedAt), undefined);
    const unicode = await f.storage.createConversationFolder(f.folder("Ärea"));
    await assert.rejects(f.storage.createConversationFolder(f.folder("ärea")), ConversationFolderConflictError);
    const concurrent = await Promise.allSettled(["Research", " research "].map(name => f.storage.createConversationFolder(f.folder(name))));
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(result => result.status === "rejected" && result.reason instanceof ConversationFolderConflictError).length, 1);
    unicode.name = "Caller mutation";
    assert.equal((await f.storage.getConversationFolder(unicode.id))?.name, "Ärea");
    const listed = await f.storage.listWorkspaceConversationFolders(f.workspace.id);
    listed[0]!.name = "Another caller mutation";
    assert.equal((await f.storage.getConversationFolder(empty.id))?.name, "Empty");
    if (kind === "libsql") {
      const reopened = await DrizzleLibSqlConversationStorage.open({ url: f.url });
      try {
        assert.deepEqual(await reopened.getConversationFolder(engineering.id), renamed);
        assert.deepEqual(await reopened.getConversationFolder(foreign.id), foreign);
        assert.equal((await reopened.listWorkspaceConversationFolders(f.workspace.id)).length, 4);
      } finally { await reopened.close(); }
    }
  });

  test(`${kind} folder storage rejects NUL names on creation and rename without changing the catalogue`, async (t) => {
    const f = await fixture(t, kind);
    const roadmap = await f.storage.createConversationFolder(f.folder("Roadmap"));
    const planning = await f.storage.createConversationFolder(f.folder("Planning"));
    const before = await f.storage.listWorkspaceConversationFolders(f.workspace.id);
    for (const name of ["\u0000Roadmap", "Roadmap\u0000first", "Roadmap\u0000second", "Roadmap\u0000"]) {
      await assert.rejects(f.storage.createConversationFolder(f.folder(name)), /Folder name/);
      await assert.rejects(f.storage.updateConversationFolderName(planning.id, name, "2026-01-02T00:00:00.000Z"), /Folder name/);
      assert.deepEqual(await f.storage.listWorkspaceConversationFolders(f.workspace.id), before);
    }
    await assert.rejects(f.storage.createConversationFolder(f.folder(" roadmap ")), ConversationFolderConflictError);
    assert.deepEqual(await f.storage.getConversationFolder(roadmap.id), roadmap);
    const accepted = await f.storage.updateConversationFolderName(planning.id, "Project plan", planning.updatedAt);
    assert.equal(accepted?.name, "Project plan");
    if (kind === "libsql") {
      const reopened = await DrizzleLibSqlConversationStorage.open({ url: f.url });
      try {
        const folders = await reopened.listWorkspaceConversationFolders(f.workspace.id);
        assert.deepEqual(folders, [accepted, roadmap]);
        assert.equal(new Set(folders.map(folder => folder.name.toLowerCase())).size, folders.length);
        await assert.rejects(reopened.createConversationFolder(f.folder(" ROADMAP ")), ConversationFolderConflictError);
      } finally { await reopened.close(); }
    }
  });

  test(`${kind} concurrent nonconflicting folder renames complete on one database`, async (t) => {
    const f = await fixture(t, kind);
    const writers = await f.writers();
    for (const [index, second] of writers.entries()) {
      const left = await f.storage.createConversationFolder(f.folder(`Left ${index}`));
      const right = await f.storage.createConversationFolder(f.folder(`Right ${index}`));
      const results = await Promise.allSettled([
        f.storage.updateConversationFolderName(left.id, `Renamed left ${index}`, left.updatedAt),
        second.updateConversationFolderName(right.id, `Renamed right ${index}`, right.updatedAt),
      ]);
      assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
      assert.equal((await f.storage.getConversationFolder(left.id))?.name, `Renamed left ${index}`);
      assert.equal((await f.storage.getConversationFolder(right.id))?.name, `Renamed right ${index}`);
    }
  });

  test(`${kind} concurrent valid folder assignments complete on one database`, async (t) => {
    const f = await fixture(t, kind);
    const folder = await f.storage.createConversationFolder(f.folder("Engineering"));
    const other = await f.storage.createConversation({ ...f.conversation, id: createResourceId("conversation") });
    const writers = await f.writers();
    for (const second of writers) {
      await f.storage.assignConversationFolder(f.conversation.id, null);
      await f.storage.assignConversationFolder(other.id, null);
      const results = await Promise.allSettled([
        f.storage.assignConversationFolder(f.conversation.id, folder.id),
        second.assignConversationFolder(other.id, folder.id),
      ]);
      assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
      assert.equal((await f.storage.getConversationMetadata(f.conversation.id))?.folderId, folder.id);
      assert.equal((await f.storage.getConversationMetadata(other.id))?.folderId, folder.id);
    }
  });

  test(`${kind} concurrent duplicate folder renames return a domain conflict, not a database-lock error`, async (t) => {
    const f = await fixture(t, kind);
    const writers = await f.writers();
    for (const [index, second] of writers.entries()) {
      const left = await f.storage.createConversationFolder(f.folder(`Left ${index}`));
      const right = await f.storage.createConversationFolder(f.folder(`Right ${index}`));
      const results = await Promise.allSettled([
        f.storage.updateConversationFolderName(left.id, `Shared ${index}`, left.updatedAt),
        second.updateConversationFolderName(right.id, ` shared ${index} `, right.updatedAt),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1, JSON.stringify(results));
      assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof ConversationFolderConflictError).length, 1, JSON.stringify(results));
      const stored = await f.storage.listWorkspaceConversationFolders(f.workspace.id);
      assert.equal(stored.filter(folder => folder.name.toLowerCase() === `shared ${index}`).length, 1);
    }
  });

  test(`${kind} folder assignment preserves messages, rosters, cursors, lifecycle and thread snapshots`, async (t) => {
    const f = await fixture(t, kind);
    const folder = await f.storage.createConversationFolder(f.folder("Engineering"));
    const root = await f.service.createMessage(f.conversation.id, { participantId: f.owner.id, body: "Root" });
    const thread = await f.service.createThread(f.conversation.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
    await f.service.createMessage(thread.id, { participantId: f.owner.id, body: "Thread only" });
    await f.storage.setCursor(f.conversation.id, f.owner.id, 1);
    await f.storage.setCursor(thread.id, f.owner.id, 1);
    await f.storage.putConversationLifecycle({
      conversationId: f.conversation.id, workspaceId: f.workspace.id, state: "snoozed",
      snoozedUntil: "9999-01-01T00:00:00.000Z", createdAt: root.createdAt, updatedAt: root.createdAt,
    });
    const before = await f.storage.getConversation(f.conversation.id);
    const beforeThread = await f.storage.getConversation(thread.id);
    const lifecycle = await f.storage.getConversationLifecycle(f.conversation.id);
    assert.equal(before?.folderId, null, "legacy creation input is normalized to Unfiled");
    for (const folderId of [folder.id, folder.id, null]) {
      const assigned = await f.storage.assignConversationFolder(f.conversation.id, folderId);
      assert.equal(assigned?.folderId, folderId);
      assert.deepEqual(await f.storage.getConversation(f.conversation.id), { ...before, folderId });
      assert.deepEqual(await f.storage.getConversation(thread.id), beforeThread);
      assert.deepEqual(await f.storage.getConversationLifecycle(f.conversation.id), lifecycle);
      assert.equal(await f.storage.getCursor(f.conversation.id, f.owner.id), 1);
      assert.equal(await f.storage.getCursor(thread.id, f.owner.id), 1);
      assert.equal((await f.storage.listWorkspaceConversations(f.workspace.id)).find(item => item.id === f.conversation.id)?.folderId, folderId);
    }
    const filed = await f.storage.createConversation({ ...f.conversation, id: createResourceId("conversation"), folderId: folder.id });
    assert.equal(filed.folderId, folder.id);
    const replaced = await f.storage.replaceConversationParticipants(filed.id, filed.participants, filed.rosterRevision, root.createdAt);
    assert.equal(replaced?.conversation.folderId, folder.id, "roster responses retain assignment metadata");
    await f.storage.assignConversationFolder(f.conversation.id, folder.id);
    if (kind === "libsql") {
      const reopened = await DrizzleLibSqlConversationStorage.open({ url: f.url });
      try {
        assert.deepEqual(await reopened.getConversation(f.conversation.id), { ...before, folderId: folder.id });
        assert.deepEqual(await reopened.getConversation(thread.id), beforeThread);
        await reopened.assignConversationFolder(f.conversation.id, null);
        assert.equal((await f.storage.getConversationMetadata(f.conversation.id))?.folderId, null);
        assert.equal((await reopened.getConversationMetadata(filed.id))?.folderId, folder.id);
      } finally { await reopened.close(); }
    }
  });

  test(`${kind} direct folder writes reject invalid references and independent thread filing without mutation`, async (t) => {
    const f = await fixture(t, kind);
    const folder = await f.storage.createConversationFolder(f.folder("Engineering"));
    const foreign = await f.storage.createConversationFolder(f.folder("Foreign", f.other.id));
    const root = await f.service.createMessage(f.conversation.id, { participantId: f.owner.id, body: "Root" });
    const thread = await f.service.createThread(f.conversation.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
    const before = await f.storage.getConversation(f.conversation.id);
    const beforeThread = await f.storage.getConversation(thread.id);
    for (const folderId of ["missing", foreign.id]) {
      await assert.rejects(f.storage.assignConversationFolder(f.conversation.id, folderId));
      assert.deepEqual(await f.storage.getConversation(f.conversation.id), before);
    }
    for (const folderId of [folder.id, null]) {
      await assert.rejects(f.storage.assignConversationFolder(thread.id, folderId));
      assert.deepEqual(await f.storage.getConversation(thread.id), beforeThread);
    }
    for (const candidate of [
      { ...f.conversation, id: createResourceId("conversation"), workspaceId: f.other.id, folderId: folder.id },
      { ...f.conversation, id: createResourceId("conversation"), folderId: folder.id, thread: beforeThread!.thread },
    ]) {
      await assert.rejects(f.storage.createConversation(candidate));
      assert.equal(await f.storage.getConversation(candidate.id), undefined);
    }
    assert.equal(await f.storage.assignConversationFolder("missing", folder.id), undefined);
    assert.deepEqual(await f.storage.listWorkspaceConversations(f.workspace.id), [
      await f.storage.getConversationMetadata(f.conversation.id), await f.storage.getConversationMetadata(thread.id),
    ]);
    if (kind === "libsql") {
      const raw = createClient({ url: f.url });
      try {
        for (const [conversationId, folderId] of [[f.conversation.id, foreign.id], [f.conversation.id, "missing"], [thread.id, folder.id]]) {
          await assert.rejects(raw.execute({ sql: "UPDATE conversations SET folder_id = ? WHERE id = ?", args: [folderId!, conversationId!] }));
        }
        assert.deepEqual((await raw.execute("PRAGMA foreign_key_check")).rows, []);
      } finally { raw.close(); }
    }
  });
}

test("folder storage migration preserves a populated 0010 database and stays usable after reopen", async (t) => {
  const legacy = await createV006ChannelsDatabase();
  t.after(() => legacy.close());
  const raw = createClient({ url: legacy.url });
  let before: Record<string, unknown>;
  let oldRows: Record<string, unknown>[];
  const snapshot = async (client: ReturnType<typeof createClient>) => {
    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__drizzle%' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows;
    const result: Record<string, unknown> = {};
    for (const { name } of tables) {
      if (name === "conversation_folders") continue;
      const rows = (await client.execute(`SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`)).rows;
      result[String(name)] = rows.map(row => {
        const { folder_id: _folderId, ...original } = row;
        return original;
      });
    }
    return result;
  };
  try {
    const migrations = readMigrationFiles({ migrationsFolder: defaultConversationMigrationsFolder() }).slice(7, 11);
    assert.equal(migrations.length, 4);
    for (const migration of migrations) {
      for (const statement of migration.sql) await raw.execute(statement);
      await raw.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [migration.hash, migration.folderMillis] });
    }
    assert.equal((await raw.execute("PRAGMA table_info(conversations)")).rows.some(row => row.name === "folder_id"), false);
    await raw.executeMultiple(`
      INSERT INTO identities (id, type, status, created_at, updated_at) VALUES ('identity_old', 'human', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES ('workspace_old', 'old', 'Old', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, identity_id, mention_handle, access_role, status, joined_at, updated_at)
        VALUES ('workspace_old', 'identity_old', 'owner', 'owner', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO conversations (id, workspace_id, name, created_at, next_sequence, roster_revision) VALUES ('conversation_old', 'workspace_old', 'Old conversation', '2026-01-01', 2, 3);
      INSERT INTO participants (conversation_id, id, type, handle, status, position) VALUES ('conversation_old', 'identity_old', 'human', 'owner', 'active', 0);
      INSERT INTO messages (id, conversation_id, sequence, participant_id, targets_json, body, created_at)
        VALUES ('message_old', 'conversation_old', 1, 'identity_old', '[]', 'Preserved text', '2026-01-01');
      INSERT INTO agent_cursors (conversation_id, participant_id, last_processed_sequence, updated_at) VALUES ('conversation_old', 'identity_old', 1, '2026-01-01');
      INSERT INTO conversation_lifecycles (conversation_id, workspace_id, state, snoozed_until, created_at, updated_at)
        VALUES ('conversation_old', 'workspace_old', 'snoozed', '9999-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO conversations (id, workspace_id, name, created_at, next_sequence, roster_revision, parent_conversation_id, root_message_id, thread_context_json)
        VALUES ('conversation_thread_old', 'workspace_old', 'Old thread', '2026-01-01', 1, 3, 'conversation_old', 'message_old', '[]');
      INSERT INTO participants (conversation_id, id, type, handle, status, position) VALUES ('conversation_thread_old', 'identity_old', 'human', 'owner', 'active', 0);
    `);
    before = await snapshot(raw);
    oldRows = (await raw.execute("SELECT * FROM conversations ORDER BY rowid")).rows;
  } finally { raw.close(); }
  let storage = await DrizzleLibSqlConversationStorage.open({ url: legacy.url });
  try {
    const after = createClient({ url: legacy.url });
    try {
      assert.deepEqual(await snapshot(after), before);
      const assignment = (await after.execute("PRAGMA table_info(conversations)")).rows.find(row => row.name === "folder_id");
      assert.equal(assignment?.notnull, 0);
      assert.deepEqual((await after.execute("PRAGMA foreign_key_check")).rows, []);
    } finally { after.close(); }
    assert.deepEqual(await storage.listWorkspaceConversationFolders("workspace_old"), []);
    for (const row of oldRows) {
      assert.equal((await storage.getConversationMetadata(String(row.id)))?.folderId, null);
      assert.equal((await storage.getConversation(String(row.id)))?.rosterRevision, row.roster_revision);
    }
    assert.equal((await storage.getConversation("conversation_old"))?.messages[0]?.body, "Preserved text");
    assert.equal((await storage.getConversation("conversation_thread_old"))?.thread?.rootMessageId, "message_old");
    assert.equal(await storage.getCursor("conversation_old", "identity_old"), 1);
    assert.equal((await storage.getConversationLifecycle("conversation_old"))?.state, "snoozed");
    const message = await storage.appendMessage({ id: createResourceId("message"), conversationId: "conversation_old", participantId: "identity_old", to: [], body: "After upgrade", createdAt: "2026-01-02" });
    assert.equal(message.sequence, 2);
    await storage.close();
    storage = await DrizzleLibSqlConversationStorage.open({ url: legacy.url });
    assert.equal((await storage.getConversation("conversation_old"))?.messages[1]?.id, message.id);
  } finally { await storage.close(); }
});
