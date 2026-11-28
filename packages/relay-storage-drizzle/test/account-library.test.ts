import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { InMemoryRelayBindingStore, type AccountLibraryItem, type RelayBindingStore } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

const item: AccountLibraryItem = { id: "skill-1", ownerIdentityId: "account-1", kind: "skill", name: "Review", description: "Review changes",
  content: "Original content", version: 1, state: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const mutation = { action: "save", expectedVersion: 1, timestamp: "2026-01-02T00:00:00Z",
  content: { kind: "skill", name: "Review updated", description: "Review changes", content: "Updated content" } } as const;

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend} account library commits versions atomically, isolates owners, and returns detached records`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-library-store-"));
    const store: RelayBindingStore = backend === "memory" ? new InMemoryRelayBindingStore()
      : await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
    try {
      assert.deepEqual(await store.createAccountLibraryItem(item), item);
      assert.equal(await store.createAccountLibraryItem({ ...item, ownerIdentityId: "account-2" }), undefined);
      assert.equal(await store.getAccountLibraryItem("account-2", item.id), undefined);
      assert.deepEqual(await store.listAccountLibraryItems("account-2"), []);
      assert.deepEqual(await store.listAccountLibraryVersions("account-2", item.id), []);
      assert.equal(await store.mutateAccountLibraryItem("account-2", item.id, mutation), undefined);
      const fetched = (await store.getAccountLibraryItem(item.ownerIdentityId, item.id))!;
      fetched.name = "Unpersisted edit";
      assert.deepEqual(await store.getAccountLibraryItem(item.ownerIdentityId, item.id), item);
      const results = await Promise.all([
        store.mutateAccountLibraryItem(item.ownerIdentityId, item.id, mutation),
        store.mutateAccountLibraryItem(item.ownerIdentityId, item.id, mutation),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      const updated = results.find(Boolean)!;
      assert.equal(updated.version, 2);
      assert.equal(updated.id, item.id);
      assert.deepEqual(await store.listAccountLibraryVersions(item.ownerIdentityId, item.id), [item, updated]);
      assert.equal(await store.mutateAccountLibraryItem(item.ownerIdentityId, item.id, { ...mutation, expectedVersion: 2,
        content: { kind: "agent-template", name: "Wrong kind", description: "Wrong", configuration: {} } }), undefined);
      const archived = await store.mutateAccountLibraryItem(item.ownerIdentityId, item.id, { action: "archive", expectedVersion: 2, timestamp: mutation.timestamp });
      assert.equal(archived?.state, "archived");
      assert.equal(archived?.version, 3);
      assert.equal(await store.mutateAccountLibraryItem(item.ownerIdentityId, item.id, { ...mutation, expectedVersion: 3 }), undefined);
      assert.equal((await store.listAccountLibraryVersions(item.ownerIdentityId, item.id)).length, 3);
    } finally {
      if (store instanceof DrizzleLibSqlRelayStorage) await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("SQLite rolls back head creation and updates when immutable version insertion fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-library-rollback-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  const store = await DrizzleLibSqlRelayStorage.open({ url });
  const client = createClient({ url });
  try {
    await client.execute("CREATE TRIGGER reject_library_version BEFORE INSERT ON account_library_versions BEGIN SELECT RAISE(ABORT, 'reject version'); END");
    await assert.rejects(store.createAccountLibraryItem(item), error => String((error as { cause?: unknown }).cause).includes("reject version"));
    assert.equal(await store.getAccountLibraryItem(item.ownerIdentityId, item.id), undefined);
    assert.deepEqual(await store.listAccountLibraryVersions(item.ownerIdentityId, item.id), []);
    await client.execute("DROP TRIGGER reject_library_version");
    await store.createAccountLibraryItem(item);
    await client.execute("CREATE TRIGGER reject_library_version BEFORE INSERT ON account_library_versions BEGIN SELECT RAISE(ABORT, 'reject version'); END");
    await assert.rejects(store.mutateAccountLibraryItem(item.ownerIdentityId, item.id, mutation), error => String((error as { cause?: unknown }).cause).includes("reject version"));
    assert.deepEqual(await store.getAccountLibraryItem(item.ownerIdentityId, item.id), item);
    assert.deepEqual(await store.listAccountLibraryVersions(item.ownerIdentityId, item.id), [item]);
  } finally { client.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("account library migrates an existing relay database without changing authored content and survives reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-library-migration-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store = await DrizzleLibSqlRelayStorage.open({ url });
  try {
    const document = { id: "workspace-skill", workspaceId: "workspace-1", kind: "skill" as const,
      name: "Workspace skill", description: "Workspace only", content: "Keep this private", version: 1, state: "active" as const,
      createdBy: "account-1", updatedBy: "account-1", createdAt: item.createdAt, updatedAt: item.updatedAt };
    await store.createAuthoredDocument(document, true);
    const before = await store.getAuthoredDocument(document.workspaceId, document.id);
    const revisions = await store.listAuthoredDocumentRevisions(document.workspaceId, document.id);
    await store.close();
    // Simulate the exact pre-M1 schema/migration marker before reopening through the migrator.
    const client = createClient({ url });
    await client.execute("DROP TABLE agent_credentials");
    await client.execute("DROP TABLE workspace_compositions");
    await client.execute("ALTER TABLE workspace_agent_configs DROP COLUMN workspace_skill_ids");
    await client.execute("ALTER TABLE workspace_agent_configs DROP COLUMN account_skills");
    await client.execute("DROP TABLE account_library_versions");
    await client.execute("DROP TABLE account_library_items");
    await client.execute("DELETE FROM __drizzle_migrations WHERE created_at >= 1799539200012");
    client.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.deepEqual(await store.getAuthoredDocument(document.workspaceId, document.id), before);
    assert.deepEqual(await store.listAuthoredDocumentRevisions(document.workspaceId, document.id), revisions);
    assert.deepEqual(await store.listAccountLibraryItems(item.ownerIdentityId), []);
    await store.createAccountLibraryItem(item);
    const updated = await store.mutateAccountLibraryItem(item.ownerIdentityId, item.id, mutation);
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.deepEqual(await store.getAccountLibraryItem(item.ownerIdentityId, item.id), updated);
    assert.deepEqual(await store.listAccountLibraryVersions(item.ownerIdentityId, item.id), [item, updated]);
    assert.deepEqual(await store.getAuthoredDocument(document.workspaceId, document.id), before);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
