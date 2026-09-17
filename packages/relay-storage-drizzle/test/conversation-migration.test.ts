import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import test from "node:test";
import { DrizzleLibSqlRelayStorage } from "../src/storage.ts";
import { createV006RelayDatabase } from "./v006-fixture.ts";

test("production Conversation migration upgrades populated v0.0.6 Relay state", async () => {
  const fixture = await createV006RelayDatabase();
  const channelId = "channel_upgrade";
  try {
    let client = createClient({ url: fixture.url });
    try {
      await client.executeMultiple(`
        INSERT INTO workspace_agent_configs (id, workspace_id, agent_identity_id, runtime_adapter, status, created_at, updated_at)
        VALUES ('config_upgrade', 'workspace_upgrade', 'agent_upgrade', 'pi', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO channel_agent_bindings (id, workspace_agent_config_id, workspace_id, channel_id, agent_identity_id, runtime_adapter, runtime_session_id, generation, state, wake_policy, created_at, updated_at)
        VALUES ('binding_upgrade', 'config_upgrade', 'workspace_upgrade', '${channelId}', 'agent_upgrade', 'pi', 'session_upgrade', 3, 'connected', 'mentions', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO channel_working_folders (workspace_id, channel_id, relative_path, position, is_primary, created_at, updated_at)
        VALUES ('workspace_upgrade', '${channelId}', 'apps/web', 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO agent_host_cursors (channel_id, participant_id, last_processed_sequence, updated_at)
        VALUES ('${channelId}', 'agent_upgrade', 7, '2026-01-01T00:00:00.000Z');
        INSERT INTO delivery_dead_letters (channel_id, participant_id, trigger_message_id, trigger_sequence, reason, created_at, updated_at)
        VALUES ('${channelId}', 'agent_upgrade', 'message_upgrade', 7, 'delivery_rejected', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
    } finally { client.close(); }

    const storage = await DrizzleLibSqlRelayStorage.open({ url: fixture.url });
    try {
      assert.equal((await storage.getBinding("binding_upgrade"))?.channelId, channelId);
      assert.deepEqual(await storage.getChannelWorkingFolders("workspace_upgrade", channelId), [{
        workspaceId: "workspace_upgrade", channelId, relativePath: "apps/web", position: 0, primary: true,
      }]);
      assert.equal(await storage.getCursor(channelId, "agent_upgrade"), 7);
      assert.equal((await storage.listDeliveryDeadLetters(channelId, "agent_upgrade"))[0]?.reason, "delivery_rejected");
    } finally { await storage.close(); }

    client = createClient({ url: fixture.url });
    try {
      const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channel_agent_bindings', 'conversation_agent_bindings', 'channel_working_folders', 'conversation_working_folders') ORDER BY name");
      assert.deepEqual(tables.rows.map(({ name }) => name), ["conversation_agent_bindings", "conversation_working_folders"]);
      assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, []);
    } finally { client.close(); }
  } finally { await fixture.close(); }
});
