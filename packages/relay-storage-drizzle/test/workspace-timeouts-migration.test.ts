import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { DrizzleLibSqlRelayStorage, defaultRelayMigrationsFolder, localRelayLibSqlUrl } from "../src/storage.ts";

test("Workspace-only timeout migration clears active overrides, fences stale writes and preserves history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-timeouts-"));
  const migrationsFolder = join(directory, "old-migrations");
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store: DrizzleLibSqlRelayStorage | undefined;
  try {
    await cp(defaultRelayMigrationsFolder(), migrationsFolder, { recursive: true });
    const journalPath = join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 23);
    await writeFile(journalPath, JSON.stringify(journal));
    store = await DrizzleLibSqlRelayStorage.open({ url, migrationsFolder });
    const workspace = { workspaceId: "workspace", rootUri: "file:///tmp", turnTimeoutMs: 600_000,
      idleSleepTimeoutMs: 900_000, createdAt: "original", updatedAt: "original" };
    await store.putWorkspaceConfig(workspace);
    const savedWorkspace = await store.getWorkspaceConfig("workspace");
    const cases = [{ turnTimeoutMs: 60_000 }, { idleSleepTimeoutMs: null }, { idleSleepTimeoutMs: 900_000 }, {}];
    const originals = cases.map((override, index) => ({ workspaceId: "workspace", conversationId: `conversation${index}`,
      participants: [{ identityId: "agent", role: "Reviewer" }], guidance: "Keep guidance",
      model: { provider: "test", id: "saved" }, revision: 3, ...override }));
    const raw = createClient({ url });
    try {
      for (const settings of originals) {
        await raw.execute({ sql: "INSERT INTO conversation_settings VALUES (?, ?, ?, ?)",
          args: [settings.workspaceId, settings.conversationId, settings.revision, JSON.stringify(settings)] });
        await store.putConversationCreationSetup({ ...settings, actorIdentityId: "owner", name: settings.conversationId });
      }
    } finally { raw.close(); }
    const snapshots = await Promise.all(originals.map(settings => store!.getConversationCreationSetup("workspace", settings.conversationId)));
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    for (const [index, original] of originals.entries()) {
      const { turnTimeoutMs: _turn, idleSleepTimeoutMs: _idle, ...rest } = original;
      const expected = { ...rest, revision: index < 3 ? 4 : 3 };
      assert.deepEqual(await store.getConversationSettings("workspace", original.conversationId), expected);
      assert.deepEqual(await store.getConversationCreationSetup("workspace", original.conversationId), snapshots[index]);
      if (index < 3) assert.equal(await store.putConversationSettings({ ...expected, revision: 4 }, 3), false);
    }
    assert.deepEqual(await store.getWorkspaceConfig("workspace"), savedWorkspace, "explicit saved Workspace policies are not silently changed");
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.equal((await store.getConversationSettings("workspace", "conversation0"))?.revision, 4, "reopen is idempotent");
    assert.equal(await store.putConversationSettings({ ...originals[3]!, revision: 4 }, 3), true, "unaffected settings keep their revision");
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
