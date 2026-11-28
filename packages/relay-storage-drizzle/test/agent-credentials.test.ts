import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrizzleLibSqlRelayStorage, defaultRelayMigrationsFolder, localRelayLibSqlUrl } from "../src/storage.ts";
import type { AgentCredentialRecord } from "../src/agent-credentials.ts";

test("private credentials migrate from 0028 without altering existing config; CAS and uniqueness persist", async t => {
  const directory = await mkdtemp(join(tmpdir(), "channels-credential-migration-"));
  let store: DrizzleLibSqlRelayStorage | undefined;
  t.after(async () => { await store?.close(); await rm(directory, { recursive: true, force: true }); });
  const oldMigrations = join(directory, "old-migrations");
  await mkdir(join(oldMigrations, "meta"), { recursive: true });
  const migrations = defaultRelayMigrationsFolder();
  const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>; [key: string]: unknown;
  };
  const oldEntries = journal.entries.filter(entry => entry.idx <= 28);
  for (const entry of oldEntries) await copyFile(join(migrations, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));
  await writeFile(join(oldMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  store = await DrizzleLibSqlRelayStorage.open({ url, migrationsFolder: oldMigrations });
  const timestamp = "2026-11-26T00:00:00.000Z";
  const configuration = { workspaceId: "workspace-a", rootUri: "file:///tmp", createdAt: timestamp, updatedAt: timestamp };
  await store.putWorkspaceConfig(configuration);
  const persistedConfiguration = await store.getWorkspaceConfig("workspace-a");
  await store.close();
  store = await DrizzleLibSqlRelayStorage.open({ url });
  assert.deepEqual(await store.getWorkspaceConfig("workspace-a"), persistedConfiguration);
  const record: AgentCredentialRecord = { id: "a".repeat(32), workspaceId: "workspace-a", principalIdentityId: "human-a",
    requestId: "request_0000000001", name: "PM", capabilities: ["conversation.inspect"],
    scope: { mode: "generic", grants: [{ conversationId: "conversation-a", includeThreads: false }] },
    revision: 1, secretGeneration: 1, secretHash: "b".repeat(64), createdAt: timestamp, updatedAt: timestamp,
    expiresAt: "2026-12-26T00:00:00.000Z" };
  assert.equal(await store.agentCredentials.create(record), true);
  assert.equal(await store.agentCredentials.create({ ...record, id: "c".repeat(32) }), false, "request ID is unique per principal/workspace");
  assert.equal(await store.agentCredentials.create({ ...record, id: "d".repeat(32), workspaceId: "workspace-b" }), true);
  assert.deepEqual(await store.agentCredentials.list("workspace-a", "human-b"), []);
  assert.equal(await store.agentCredentials.replace({ ...record, workspaceId: "workspace-b", revision: 2 }, 1), false);
  assert.equal(await store.agentCredentials.replace({ ...record, principalIdentityId: "human-b", revision: 2 }, 1), false);
  assert.equal(await store.agentCredentials.replace({ ...record, requestId: "different_request", revision: 2 }, 1), false);
  const rotated = { ...record, revision: 2, secretGeneration: 2, secretHash: "c".repeat(64) };
  const writes = await Promise.all([store.agentCredentials.replace(rotated, 1), store.agentCredentials.replace(rotated, 1)]);
  assert.equal(writes.filter(Boolean).length, 1);
  await store.close();
  store = await DrizzleLibSqlRelayStorage.open({ url });
  assert.deepEqual(await store.agentCredentials.get(record.id), rotated);
  assert.deepEqual(await store.getWorkspaceConfig("workspace-a"), persistedConfiguration);
  await assert.rejects(store.agentCredentials.replace(rotated, 2), /Invalid credential revision/);
});
