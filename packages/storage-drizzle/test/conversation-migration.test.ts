import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import test from "node:test";
import { DrizzleLibSqlChannelStorage } from "../src/storage.ts";
import { createV006ChannelsDatabase } from "./v006-fixture.ts";

test("production Conversation migration upgrades a populated v0.0.6 collaboration database", async () => {
  const fixture = await createV006ChannelsDatabase();
  const channelId = "channel_upgrade";
  try {
    let client = createClient({ url: fixture.url });
    try {
      await client.executeMultiple(`
        INSERT INTO identities (id, type, display_name, status, created_at, updated_at) VALUES
          ('identity_human', 'human', 'Human', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('identity_agent', 'agent', 'Agent', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES
          ('workspace_upgrade', 'upgrade', 'Upgrade', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO workspace_members (workspace_id, identity_id, mention_handle, access_role, status, joined_at, updated_at) VALUES
          ('workspace_upgrade', 'identity_human', 'human', 'owner', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('workspace_upgrade', 'identity_agent', 'agent', 'member', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO channels (id, workspace_id, name, created_at, next_sequence, roster_revision) VALUES
          ('${channelId}', 'workspace_upgrade', 'Preserved', '2026-01-01T00:00:00.000Z', 3, 1);
        INSERT INTO participants (channel_id, id, handle, type, status, position) VALUES
          ('${channelId}', 'identity_human', 'human', 'human', 'active', 0),
          ('${channelId}', 'identity_agent', 'agent', 'agent', 'active', 1);
        INSERT INTO messages (id, channel_id, sequence, participant_id, targets_json, body, created_at) VALUES
          ('message_trigger', '${channelId}', 1, 'identity_human', '[]', 'Keep me', '2026-01-01T00:00:00.000Z'),
          ('message_response', '${channelId}', 2, 'identity_agent', '[]', 'Still here', '2026-01-01T00:00:01.000Z');
        INSERT INTO message_idempotency (channel_id, participant_id, idempotency_key, request_fingerprint, message_id, created_at) VALUES
          ('${channelId}', 'identity_human', 'key', 'fingerprint', 'message_trigger', '2026-01-01T00:00:00.000Z');
        INSERT INTO response_deliveries (channel_id, participant_id, trigger_message_id, trigger_sequence, response_message_id, created_at) VALUES
          ('${channelId}', 'identity_agent', 'message_trigger', 1, 'message_response', '2026-01-01T00:00:01.000Z');
        INSERT INTO agent_cursors (channel_id, participant_id, last_processed_sequence, updated_at) VALUES
          ('${channelId}', 'identity_agent', 2, '2026-01-01T00:00:01.000Z');
      `);
    } finally { client.close(); }

    const storage = await DrizzleLibSqlChannelStorage.open({ url: fixture.url });
    try {
      const channel = await storage.getChannel(channelId);
      assert.equal(channel?.name, "Preserved");
      assert.deepEqual(channel?.messages.map(({ id }) => id), ["message_trigger", "message_response"]);
      assert.equal(await storage.getCursor(channelId, "identity_agent"), 2);
    } finally { await storage.close(); }

    client = createClient({ url: fixture.url });
    try {
      assert.deepEqual((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'conversations')")).rows, [{ name: "conversations" }]);
      assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, []);
      assert.equal((await client.execute("SELECT count(*) AS count FROM messages WHERE conversation_id = ?", [channelId])).rows[0]?.count, 2);
    } finally { client.close(); }
  } finally { await fixture.close(); }
});
