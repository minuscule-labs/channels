import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultRelayMigrationsFolder,
  DrizzleLibSqlRelayStorage,
  localRelayLibSqlUrl,
} from "../src/storage.ts";

async function v006MigrationsFolder(directory: string): Promise<string> {
  const migrationsFolder = join(directory, "v0.0.6-migrations");
  await cp(defaultRelayMigrationsFolder(), migrationsFolder, { recursive: true });
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter(({ idx }) => idx <= 7);
  await writeFile(journalPath, JSON.stringify(journal));
  return migrationsFolder;
}

/**
 * Upgrade fixture for private Relay state produced by the current Channel schema.
 * Keep this data shape when promoting the proven SQL into the versioned migration.
 */
test("private Relay upgrade preserves Channel state under Conversation names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-relay-conversation-upgrade-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  const migrationsFolder = await v006MigrationsFolder(directory);
  const timestamp = "2026-09-17T00:00:00.000Z";
  try {
    const storage = await DrizzleLibSqlRelayStorage.open({ url, migrationsFolder });
    await storage.close();
    const client = createClient({ url });
    try {
      await client.executeMultiple(`
        INSERT INTO workspace_agent_configs (id, workspace_id, agent_identity_id, runtime_adapter, status, created_at, updated_at)
        VALUES ('config-a', 'workspace-a', 'agent-a', 'pi', 'active', '${timestamp}', '${timestamp}');
        INSERT INTO channel_agent_bindings (id, workspace_agent_config_id, workspace_id, channel_id, agent_identity_id, runtime_adapter, runtime_session_id, generation, state, wake_policy, created_at, updated_at)
        VALUES ('binding-a', 'config-a', 'workspace-a', 'channel-a', 'agent-a', 'pi', 'session-a', 2, 'connected', 'mentions', '${timestamp}', '${timestamp}');
        INSERT INTO channel_working_folders (workspace_id, channel_id, relative_path, position, is_primary, created_at, updated_at)
        VALUES ('workspace-a', 'channel-a', 'apps/web', 0, 1, '${timestamp}', '${timestamp}');
        INSERT INTO agent_host_cursors (channel_id, participant_id, last_processed_sequence, updated_at)
        VALUES ('channel-a', 'agent-a', 7, '${timestamp}');
        INSERT INTO delivery_dead_letters (channel_id, participant_id, trigger_message_id, trigger_sequence, reason, created_at, updated_at)
        VALUES ('channel-a', 'agent-a', 'message-a', 7, 'delivery_rejected', '${timestamp}', '${timestamp}');
      `);

      // This is the exact private-database SQL shape proposed for the versioned migration.
      await client.executeMultiple(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        ALTER TABLE channel_agent_bindings RENAME TO conversation_agent_bindings;
        ALTER TABLE channel_working_folders RENAME TO conversation_working_folders;
        ALTER TABLE conversation_agent_bindings RENAME COLUMN channel_id TO conversation_id;
        ALTER TABLE conversation_working_folders RENAME COLUMN channel_id TO conversation_id;
        ALTER TABLE agent_host_cursors RENAME COLUMN channel_id TO conversation_id;
        ALTER TABLE delivery_dead_letters RENAME COLUMN channel_id TO conversation_id;
        DROP INDEX channel_agent_bindings_route_unique;
        DROP INDEX channel_agent_bindings_runtime_session_unique;
        DROP INDEX channel_agent_bindings_channel_idx;
        CREATE UNIQUE INDEX conversation_agent_bindings_route_unique ON conversation_agent_bindings (workspace_id, conversation_id, agent_identity_id);
        CREATE UNIQUE INDEX conversation_agent_bindings_runtime_session_unique ON conversation_agent_bindings (runtime_adapter, runtime_session_id);
        CREATE INDEX conversation_agent_bindings_conversation_idx ON conversation_agent_bindings (conversation_id);
        DROP INDEX channel_working_folders_position_unique;
        DROP INDEX channel_working_folders_primary_unique;
        DROP INDEX channel_working_folders_workspace_channel_idx;
        CREATE UNIQUE INDEX conversation_working_folders_position_unique ON conversation_working_folders (conversation_id, position);
        CREATE UNIQUE INDEX conversation_working_folders_primary_unique ON conversation_working_folders (conversation_id) WHERE is_primary = 1;
        CREATE INDEX conversation_working_folders_workspace_conversation_idx ON conversation_working_folders (workspace_id, conversation_id);
        DROP INDEX agent_host_cursors_route_unique;
        CREATE UNIQUE INDEX agent_host_cursors_conversation_route_unique ON agent_host_cursors (conversation_id, participant_id);
        DROP INDEX delivery_dead_letters_trigger_unique;
        DROP INDEX delivery_dead_letters_route_sequence_idx;
        CREATE UNIQUE INDEX delivery_dead_letters_conversation_trigger_unique ON delivery_dead_letters (conversation_id, participant_id, trigger_message_id);
        CREATE INDEX delivery_dead_letters_conversation_route_sequence_idx ON delivery_dead_letters (conversation_id, participant_id, trigger_sequence);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);

      const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channel_agent_bindings', 'conversation_agent_bindings', 'channel_working_folders', 'conversation_working_folders') ORDER BY name");
      assert.deepEqual(tables.rows.map(({ name }) => name), ["conversation_agent_bindings", "conversation_working_folders"]);
      assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, []);
      assert.deepEqual((await client.execute("SELECT runtime_session_id, generation FROM conversation_agent_bindings WHERE conversation_id = 'channel-a'")).rows, [{ runtime_session_id: "session-a", generation: 2 }]);
      assert.deepEqual((await client.execute("SELECT relative_path, is_primary FROM conversation_working_folders WHERE conversation_id = 'channel-a'")).rows, [{ relative_path: "apps/web", is_primary: 1 }]);
      assert.deepEqual((await client.execute("SELECT last_processed_sequence FROM agent_host_cursors WHERE conversation_id = 'channel-a'")).rows, [{ last_processed_sequence: 7 }]);
      assert.deepEqual((await client.execute("SELECT reason FROM delivery_dead_letters WHERE conversation_id = 'channel-a'")).rows, [{ reason: "delivery_rejected" }]);
      const staleIndexes = await client.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'channel_%'");
      assert.deepEqual(staleIndexes.rows, []);
    } finally {
      client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
