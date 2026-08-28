import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelService } from "@minu/channels-core";
import { DrizzleLibSqlChannelStorage, localLibSqlUrl } from "../src/storage.js";

test("initial migration adopts the previous raw SQLite schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-legacy-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  try {
    const legacy = createClient({ url });
    await legacy.executeMultiple(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO channels (id, created_at, next_sequence)
      VALUES ('legacy-channel', '2026-01-01T00:00:00.000Z', 1);
    `);
    legacy.close();

    const storage = await DrizzleLibSqlChannelStorage.open({ url });
    const channel = await storage.getChannel("legacy-channel");
    assert.equal(channel?.id, "legacy-channel");
    assert.deepEqual(channel?.participants, []);
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Drizzle/libSQL keeps response commits idempotent across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-delivery-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  try {
    const firstStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const first = new ChannelService(firstStorage);
    const channel = await first.createChannel({
      participants: [
        { id: "user", type: "human" },
        { id: "agent-a", type: "agent" },
      ],
    });
    const trigger = await first.createMessage(channel.id, {
      participantId: "user",
      body: "@agent-a implement this",
    });
    const input = {
      participantId: "agent-a",
      body: "Implemented",
      triggerMessageId: trigger.id,
      triggerSequence: trigger.sequence,
    };
    const committed = await first.createResponse(channel.id, input);
    assert.equal(committed.created, true);
    await first.close();

    const secondStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const second = new ChannelService(secondStorage);
    const duplicate = await second.createResponse(channel.id, input);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.message.id, committed.message.id);
    assert.equal((await second.listMessages(channel.id)).length, 2);
    assert.equal(await secondStorage.getCursor(channel.id, "agent-a"), trigger.sequence);
    assert.equal(
      (await second.createMessage(channel.id, { participantId: "user", body: "next" })).sequence,
      3,
    );
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Drizzle/libSQL preserves channels, sequences, messages, and cursors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-libsql-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  let channelId!: string;
  try {
    const firstStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const first = new ChannelService(firstStorage);
    const channel = await first.createChannel({
      participants: [
        { id: "user", type: "human" },
        {
          id: "agent-a",
          type: "agent",
          displayName: "Builder",
          role: "implementation",
          profile: "Builds and tests requested changes.",
        },
      ],
    });
    channelId = channel.id;
    assert.equal(
      (await first.createMessage(channel.id, { participantId: "user", body: "@agent-a first" }))
        .sequence,
      1,
    );
    assert.equal(
      (await first.createMessage(channel.id, { participantId: "agent-a", body: "done" })).sequence,
      2,
    );
    await firstStorage.setCursor(channel.id, "agent-a", 1);
    await first.close();

    const secondStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const second = new ChannelService(secondStorage);
    assert.deepEqual((await second.getChannel(channelId)).participants[1], {
      id: "agent-a",
      type: "agent",
      displayName: "Builder",
      role: "implementation",
      profile: "Builds and tests requested changes.",
    });
    assert.deepEqual(
      (await second.listMessages(channelId)).map((message) => [message.sequence, message.body]),
      [[1, "@agent-a first"], [2, "done"]],
    );
    assert.equal(await secondStorage.getCursor(channelId, "agent-a"), 1);
    assert.equal(
      (await second.createMessage(channelId, { participantId: "user", body: "third" })).sequence,
      3,
    );
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
