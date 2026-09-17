import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelService } from "@minu/channels-core";
import { DrizzleLibSqlChannelStorage, localLibSqlUrl } from "../src/storage.ts";

/**
 * Upgrade fixture for the current on-disk Channel schema. Keep this data shape when
 * promoting the proven SQL below into the versioned Conversation migration.
 */
test("Channel database upgrade preserves collaboration data under Conversation names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-conversation-upgrade-"));
  const databasePath = join(directory, "channels.db");
  const url = localLibSqlUrl(databasePath);
  let storage: DrizzleLibSqlChannelStorage | undefined;
  try {
    storage = await DrizzleLibSqlChannelStorage.open({ url });
    const service = new ChannelService(storage);
    const human = await service.createIdentity({ type: "human", displayName: "Human" });
    const agent = await service.createIdentity({ type: "agent", displayName: "Agent" });
    const workspace = await service.createWorkspace({ slug: "upgrade", name: "Upgrade fixture" });
    await service.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "human", accessRole: "owner" });
    await service.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    const channel = await service.createChannel({
      workspaceId: workspace.id,
      name: "preserved-history",
      participantIds: [human.id, agent.id],
    });
    const trigger = await service.createMessage(channel.id, { participantId: human.id, body: "Preserve this request." });
    const response = await service.createMessage(channel.id, { participantId: agent.id, body: "Preserve this response." });
    await storage.close();
    storage = undefined;

    const client = createClient({ url });
    try {
      const createdAt = "2026-09-17T00:00:00.000Z";
      await client.execute({
        sql: "INSERT INTO message_idempotency (channel_id, participant_id, idempotency_key, request_fingerprint, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [channel.id, human.id, "upgrade-key", "upgrade-fingerprint", trigger.id, createdAt],
      });
      await client.execute({
        sql: "INSERT INTO response_deliveries (channel_id, participant_id, trigger_message_id, trigger_sequence, response_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [channel.id, agent.id, trigger.id, trigger.sequence, response.id, createdAt],
      });
      await client.execute({
        sql: "INSERT INTO agent_cursors (channel_id, participant_id, last_processed_sequence, updated_at) VALUES (?, ?, ?, ?)",
        args: [channel.id, agent.id, response.sequence, createdAt],
      });

      // This is the exact public-database SQL shape proposed for the versioned migration.
      await client.executeMultiple(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        ALTER TABLE channels RENAME TO conversations;
        ALTER TABLE participants RENAME COLUMN channel_id TO conversation_id;
        ALTER TABLE messages RENAME COLUMN channel_id TO conversation_id;
        ALTER TABLE message_idempotency RENAME COLUMN channel_id TO conversation_id;
        ALTER TABLE response_deliveries RENAME COLUMN channel_id TO conversation_id;
        ALTER TABLE agent_cursors RENAME COLUMN channel_id TO conversation_id;
        DROP INDEX messages_channel_sequence_unique;
        DROP INDEX messages_channel_sequence;
        CREATE UNIQUE INDEX messages_conversation_sequence_unique ON messages (conversation_id, sequence);
        CREATE INDEX messages_conversation_sequence ON messages (conversation_id, sequence);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);

      const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'conversations')");
      assert.deepEqual(tables.rows.map(({ name }) => name), ["conversations"]);
      assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, []);
      const messageColumns = await client.execute("PRAGMA table_info(messages)");
      assert.ok(messageColumns.rows.some(({ name }) => name === "conversation_id"));
      assert.ok(!messageColumns.rows.some(({ name }) => name === "channel_id"));
      const indexes = await client.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'messages_%sequence%'");
      assert.deepEqual(indexes.rows.map(({ name }) => name).sort(), [
        "messages_conversation_sequence",
        "messages_conversation_sequence_unique",
      ]);
      assert.deepEqual((await client.execute({
        sql: "SELECT name, next_sequence, roster_revision FROM conversations WHERE id = ?",
        args: [channel.id],
      })).rows, [{ name: "preserved-history", next_sequence: 3, roster_revision: 1 }]);
      assert.deepEqual((await client.execute({
        sql: "SELECT count(*) AS count FROM messages WHERE conversation_id = ?",
        args: [channel.id],
      })).rows, [{ count: 2 }]);
      assert.deepEqual((await client.execute({
        sql: "SELECT message_id FROM message_idempotency WHERE conversation_id = ?",
        args: [channel.id],
      })).rows, [{ message_id: trigger.id }]);
      assert.deepEqual((await client.execute({
        sql: "SELECT response_message_id FROM response_deliveries WHERE conversation_id = ?",
        args: [channel.id],
      })).rows, [{ response_message_id: response.id }]);
      assert.deepEqual((await client.execute({
        sql: "SELECT last_processed_sequence FROM agent_cursors WHERE conversation_id = ?",
        args: [channel.id],
      })).rows, [{ last_processed_sequence: response.sequence }]);
    } finally {
      client.close();
    }
  } finally {
    await storage?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
