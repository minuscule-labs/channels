import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelService } from "@minu/channels-core";
import { DrizzleLibSqlChannelStorage, localLibSqlUrl } from "../src/storage.ts";

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
      CREATE TABLE participants (
        channel_id TEXT NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        display_name TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY(channel_id, id)
      );
      INSERT INTO participants (channel_id, id, type, display_name, position)
      VALUES ('legacy-channel', 'legacy-agent', 'agent', 'Legacy Agent', 0);
    `);
    legacy.close();

    const storage = await DrizzleLibSqlChannelStorage.open({ url });
    const channel = await storage.getChannel("legacy-channel");
    assert.equal(channel?.id, "legacy-channel");
    assert.equal(channel?.workspaceId, "legacy-default-workspace");
    assert.equal(channel?.name, "Channel legacy-c");
    assert.equal(channel?.participants[0]?.id, "legacy-agent");
    assert.equal(channel?.participants[0]?.handle, "legacy-agent");
    assert.equal((await storage.listWorkspaces())[0]?.id, "legacy-default-workspace");
    assert.equal((await storage.listIdentities())[0]?.id, "legacy-agent");
    assert.equal(
      (await storage.listWorkspaceMembers("legacy-default-workspace"))[0]?.identityId,
      "legacy-agent",
    );
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Drizzle/libSQL preserves identities, Workspace memberships, aliases, and Channels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-workspaces-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  try {
    const firstStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const first = new ChannelService(firstStorage);
    const human = await first.createIdentity({ type: "human", displayName: "David" });
    const agent = await first.createIdentity({ type: "agent", displayName: "Builder" });
    const workspace = await first.createWorkspace({ slug: "channels", name: "Channels" });
    await first.addWorkspaceMember(workspace.id, {
      identityId: human.id,
      mentionHandle: "david",
      accessRole: "owner",
    });
    await first.addWorkspaceMember(workspace.id, {
      identityId: agent.id,
      mentionHandle: "builder",
      roleLabel: "implementation",
    });
    const channel = await first.createChannel({
      workspaceId: workspace.id,
      name: "durable-work",
      participantIds: [human.id, agent.id],
    });
    await first.createMessage(channel.id, {
      participantId: human.id,
      body: "@builder implement this",
    });
    await first.updateWorkspaceMember(workspace.id, agent.id, {
      actorIdentityId: human.id,
      mentionHandle: "implementer",
      roleLabel: "builder",
    });
    await first.close();

    const secondStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const second = new ChannelService(secondStorage);
    assert.equal((await second.listIdentities()).length, 2);
    assert.equal((await second.listWorkspaceMembers(workspace.id))[1]?.mentionHandle, "implementer");
    const restored = await second.getChannel(channel.id);
    assert.equal(restored.workspaceId, workspace.id);
    assert.equal(restored.name, "durable-work");
    assert.equal(restored.participants[1]?.id, agent.id);
    assert.equal(restored.rosterRevision, 2);
    assert.equal(restored.participants[1]?.handle, "implementer");
    assert.equal(restored.participants[1]?.role, "builder");
    assert.deepEqual(restored.messages[0]?.to, [agent.id]);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Drizzle/libSQL prevents concurrent removal of the last active Workspace owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-owners-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  const firstStorage = await DrizzleLibSqlChannelStorage.open({ url });
  const first = new ChannelService(firstStorage);
  try {
    const [ownerA, ownerB] = await Promise.all([
      first.createIdentity({ type: "human", displayName: "Owner A" }),
      first.createIdentity({ type: "human", displayName: "Owner B" }),
    ]);
    const workspace = await first.createWorkspace({ slug: "owner-race", name: "Owners" });
    await first.addWorkspaceMember(workspace.id, {
      identityId: ownerA.id,
      mentionHandle: "owner-a",
      accessRole: "owner",
    });
    await first.addWorkspaceMember(workspace.id, {
      identityId: ownerB.id,
      mentionHandle: "owner-b",
      accessRole: "owner",
    });
    const secondStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const second = new ChannelService(secondStorage);
    try {
      const updates = await Promise.allSettled([
        first.updateWorkspaceMember(workspace.id, ownerA.id, {
          actorIdentityId: ownerA.id,
          accessRole: "member",
        }),
        second.updateWorkspaceMember(workspace.id, ownerB.id, {
          actorIdentityId: ownerB.id,
          accessRole: "member",
        }),
      ]);
      assert.deepEqual(updates.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
      assert.equal(
        (await first.listWorkspaceMembers(workspace.id)).filter(
          ({ accessRole, status }) => accessRole === "owner" && status === "active",
        ).length,
        1,
      );
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Drizzle/libSQL atomically replaces revisioned Channel rosters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-roster-race-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  const firstStorage = await DrizzleLibSqlChannelStorage.open({ url });
  const first = new ChannelService(firstStorage);
  try {
    const [owner, builder, reviewer] = await Promise.all([
      first.createIdentity({ type: "human", displayName: "Owner" }),
      first.createIdentity({ type: "agent", displayName: "Builder" }),
      first.createIdentity({ type: "agent", displayName: "Reviewer" }),
    ]);
    const workspace = await first.createWorkspace({ slug: "roster-race", name: "Roster race" });
    await Promise.all([
      first.addWorkspaceMember(workspace.id, {
        identityId: owner.id,
        mentionHandle: "owner",
        accessRole: "owner",
      }),
      first.addWorkspaceMember(workspace.id, {
        identityId: builder.id,
        mentionHandle: "builder",
      }),
      first.addWorkspaceMember(workspace.id, {
        identityId: reviewer.id,
        mentionHandle: "reviewer",
      }),
    ]);
    const channel = await first.createChannel({
      workspaceId: workspace.id,
      participantIds: [owner.id, builder.id, reviewer.id],
    });
    await first.createMessage(channel.id, { participantId: builder.id, body: "Builder history" });
    const secondStorage = await DrizzleLibSqlChannelStorage.open({
      url: url.replace("file:", "file://"),
    });
    const second = new ChannelService(secondStorage);
    try {
      const updates = await Promise.allSettled([
        first.updateChannelParticipants(channel.id, {
          actorIdentityId: owner.id,
          participantIds: [owner.id, builder.id],
          expectedRosterRevision: 1,
        }),
        second.updateChannelParticipants(channel.id, {
          actorIdentityId: owner.id,
          participantIds: [owner.id, reviewer.id],
          expectedRosterRevision: 1,
        }),
      ]);
      assert.deepEqual(updates.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
      const restored = await first.getChannel(channel.id);
      assert.equal(restored.rosterRevision, 2);
      assert.equal(restored.participants.length, 2);
      assert.equal(restored.messages[0]?.participantId, builder.id);
      const removedId = restored.participants.some(({ id }) => id === builder.id)
        ? reviewer.id
        : builder.id;
      assert.equal(await firstStorage.getCursor(channel.id, removedId), 1);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Drizzle/libSQL keeps message idempotency atomic and durable across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-message-idempotency-"));
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
    // Use an equivalent URL with a distinct storage key so this exercises the
    // database transaction race rather than the in-process pending map.
    const competingStorage = await DrizzleLibSqlChannelStorage.open({
      url: url.replace("file:", "file://"),
    });
    const competing = new ChannelService(competingStorage);
    const input = { participantId: "user", body: "@agent-a once" };
    const [left, right] = await Promise.all([
      first.createMessage(channel.id, input, "durable-key"),
      competing.createMessage(channel.id, input, "durable-key"),
    ]);
    assert.equal(left.id, right.id);
    assert.equal((await first.listMessages(channel.id)).length, 1);
    await competing.close();
    await first.close();

    const reopenedStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const reopened = new ChannelService(reopenedStorage);
    const replay = await reopened.createMessage(channel.id, input, "durable-key");
    assert.equal(replay.id, left.id);
    const [conflictingPending, matchingPending] = await Promise.allSettled([
      reopened.createMessage(
        channel.id,
        { participantId: "user", body: "@agent-a changed" },
        "durable-key",
      ),
      reopened.createMessage(channel.id, input, "durable-key"),
    ]);
    assert.equal(conflictingPending.status, "rejected");
    assert.match(String((conflictingPending as PromiseRejectedResult).reason), /different payload/);
    assert.equal(matchingPending.status, "fulfilled");
    assert.equal(
      (matchingPending as PromiseFulfilledResult<{ id: string }>).value.id,
      left.id,
    );
    await assert.rejects(
      reopened.createMessage(
        channel.id,
        { participantId: "user", body: "@agent-a changed" },
        "durable-key",
      ),
      /different payload/,
    );
    assert.equal((await reopened.listMessages(channel.id)).length, 1);
    assert.equal(
      (await reopened.createMessage(channel.id, { participantId: "user", body: "next" })).sequence,
      2,
    );
    await reopened.close();
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
    const competingStorage = await DrizzleLibSqlChannelStorage.open({ url });
    const competing = new ChannelService(competingStorage);
    const commits = await Promise.all([
      first.createResponse(channel.id, input),
      competing.createResponse(channel.id, input),
    ]);
    assert.deepEqual(commits.map((result) => result.created).sort(), [false, true]);
    assert.equal(commits[0]!.message.id, commits[1]!.message.id);
    const committed = commits.find((result) => result.created)!;
    await competing.close();
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
      handle: "agent-a",
      type: "agent",
      displayName: "Builder",
      role: "implementation",
      profile: "Builds and tests requested changes.",
      status: "active",
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
