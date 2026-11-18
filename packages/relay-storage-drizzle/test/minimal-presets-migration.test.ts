import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { DrizzleLibSqlRelayStorage, defaultRelayMigrationsFolder, localRelayLibSqlUrl } from "../src/storage.ts";

test("minimal preset migration removes obsolete data, invalidates stale editors and preserves Conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minimal-presets-"));
  const migrationsFolder = join(directory, "old-migrations");
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store: DrizzleLibSqlRelayStorage | undefined;
  try {
    await cp(defaultRelayMigrationsFolder(), migrationsFolder, { recursive: true });
    const journalPath = join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const allEntries = journal.entries;
    journal.entries = allEntries.filter((entry: { idx: number }) => entry.idx < 22);
    await writeFile(journalPath, JSON.stringify(journal));
    store = await DrizzleLibSqlRelayStorage.open({ url, migrationsFolder });
    const timestamp = new Date().toISOString();
    const legacy = { id: "legacy", workspaceId: "workspace", name: "Team", revision: 3,
      participants: [{ identityId: "agent", role: "Builder" }, { role: "Unassigned" }],
      model: { provider: "test", id: "old" }, reasoningLevel: "high" as const, turnTimeoutMs: 60_000, idleSleepTimeoutMs: null,
      guidance: "Keep instructions", createdAt: timestamp, updatedAt: timestamp };
    // Seed the historical JSON format rather than relying on today's narrowed write contract.
    const raw = createClient({ url });
    try {
      await raw.execute({ sql: "INSERT INTO conversation_presets VALUES (?, ?, ?, ?)",
        args: ["workspace", "legacy", 3, JSON.stringify(legacy)] });
    } finally { raw.close(); }
    const snapshot = { ...legacy, conversationId: "conversation", actorIdentityId: "owner" };
    await store.putConversationCreationSetup(snapshot);
    await store.putConversationSettings({ ...snapshot, revision: 1 }, 0);
    const settings = await store.getConversationSettings("workspace", "conversation");
    await store.close();
    // Isolate migration0022 from later migrations with their own settings contracts.
    journal.entries = allEntries.filter((entry: { idx: number }) => entry.idx <= 22);
    await writeFile(journalPath, JSON.stringify(journal));
    store = await DrizzleLibSqlRelayStorage.open({ url, migrationsFolder });
    const expected = { id: "legacy", workspaceId: "workspace", name: "Team", revision: 4,
      participants: [{ identityId: "agent" }], guidance: "Keep instructions", createdAt: timestamp, updatedAt: timestamp };
    assert.deepEqual(await store.listConversationPresets("workspace"), [expected]);
    assert.equal(await store.putConversationPreset({ ...expected, revision: 4 }, 3), false);
    assert.deepEqual(await store.getConversationCreationSetup("workspace", "conversation"), snapshot);
    assert.deepEqual(await store.getConversationSettings("workspace", "conversation"), settings);
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url, migrationsFolder });
    assert.deepEqual(await store.listConversationPresets("workspace"), [expected], "reopening does not migrate twice");
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
