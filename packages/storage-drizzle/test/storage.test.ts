import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationService } from "@minu/channels-core";
import {
  backupLocalLibSqlDatabase,
  defaultConversationMigrationsFolder,
  DrizzleLibSqlConversationStorage,
  hasPendingLocalLibSqlMigrations,
  localLibSqlUrl,
} from "../src/storage.ts";

test("local migration backups snapshot existing data only when a migration is pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-backup-"));
  const databasePath = join(directory, "channels.db");
  const url = localLibSqlUrl(databasePath);
  const migrationsFolder = join(directory, "future-migrations");
  const backupPath = join(directory, "backups", "conversations-before-migration.db");
  try {
    const storage = await DrizzleLibSqlConversationStorage.open({ url });
    const service = new ConversationService(storage);
    const identity = await service.createIdentity({ type: "human", displayName: "Before backup" });
    await storage.close();

    assert.equal(await hasPendingLocalLibSqlMigrations(url, defaultConversationMigrationsFolder()), false);
    await mkdir(join(migrationsFolder, "meta"), { recursive: true });
    await writeFile(join(migrationsFolder, "meta", "_journal.json"), JSON.stringify({
      entries: [{ idx: 0, version: "6", when: 4_102_444_800_000, tag: "0000_future", breakpoints: true }],
    }));
    await writeFile(join(migrationsFolder, "0000_future.sql"), "SELECT 1;");
    assert.equal(await hasPendingLocalLibSqlMigrations(url, migrationsFolder), true);

    await backupLocalLibSqlDatabase(url, backupPath);
    const backup = createClient({ url: localLibSqlUrl(backupPath) });
    try {
      const result = await backup.execute({
        sql: "SELECT display_name FROM identities WHERE id = ?",
        args: [identity.id],
      });
      assert.equal(result.rows[0]?.display_name, "Before backup");
    } finally {
      backup.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

    const storage = await DrizzleLibSqlConversationStorage.open({ url });
    const conversation = await storage.getConversation("legacy-channel");
    assert.equal(conversation?.id, "legacy-channel");
    assert.equal(conversation?.workspaceId, "legacy-default-workspace");
    assert.equal(conversation?.name, "Channel legacy-c");
    assert.equal(conversation?.participants[0]?.id, "legacy-agent");
    assert.equal(conversation?.participants[0]?.handle, "legacy-agent");
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

test("Drizzle/libSQL preserves identities, Workspace memberships, aliases, and Conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-workspaces-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  try {
    const firstStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const first = new ConversationService(firstStorage);
    const human = await first.createIdentity({ type: "human", displayName: "David" });
    const agent = await first.createIdentity({ type: "agent", displayName: "Builder" });
    const workspace = await first.createWorkspace({ slug: "conversations", name: "Conversations" });
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
    const conversation = await first.createConversation({
      workspaceId: workspace.id,
      name: "durable-work",
      participantIds: [human.id, agent.id],
    });
    await first.createMessage(conversation.id, {
      participantId: human.id,
      body: "@builder implement this",
    });
    await first.updateWorkspaceMember(workspace.id, agent.id, {
      actorIdentityId: human.id,
      mentionHandle: "implementer",
      roleLabel: "builder",
    });
    await first.updateWorkspace(workspace.id, {
      actorIdentityId: human.id,
      name: "Renamed Conversations",
    });
    await first.updateIdentity(agent.id, {
      workspaceId: workspace.id,
      actorIdentityId: human.id,
      displayName: "Lead Builder",
    });
    await first.close();

    const secondStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const second = new ConversationService(secondStorage);
    assert.equal((await second.listIdentities()).length, 2);
    assert.equal((await second.getIdentity(agent.id)).displayName, "Lead Builder");
    assert.equal((await second.getWorkspace(workspace.id)).name, "Renamed Conversations");
    assert.equal((await second.listWorkspaceMembers(workspace.id))[1]?.mentionHandle, "implementer");
    const restored = await second.getConversation(conversation.id);
    assert.equal(restored.workspaceId, workspace.id);
    assert.equal(restored.name, "durable-work");
    assert.equal(restored.participants[1]?.id, agent.id);
    assert.equal(restored.participants[1]?.displayName, "Lead Builder");
    assert.equal(restored.rosterRevision, 3);
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
  const firstStorage = await DrizzleLibSqlConversationStorage.open({ url });
  const first = new ConversationService(firstStorage);
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
    const secondStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const second = new ConversationService(secondStorage);
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

test("Drizzle/libSQL atomically replaces revisioned Conversation rosters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-roster-race-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  const firstStorage = await DrizzleLibSqlConversationStorage.open({ url });
  const first = new ConversationService(firstStorage);
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
    const conversation = await first.createConversation({
      workspaceId: workspace.id,
      participantIds: [owner.id, builder.id, reviewer.id],
    });
    await first.createMessage(conversation.id, { participantId: builder.id, body: "Builder history" });
    const secondStorage = await DrizzleLibSqlConversationStorage.open({
      url: url.replace("file:", "file://"),
    });
    const second = new ConversationService(secondStorage);
    try {
      const updates = await Promise.allSettled([
        first.updateConversationParticipants(conversation.id, {
          actorIdentityId: owner.id,
          participantIds: [owner.id, builder.id],
          expectedRosterRevision: 1,
        }),
        second.updateConversationParticipants(conversation.id, {
          actorIdentityId: owner.id,
          participantIds: [owner.id, reviewer.id],
          expectedRosterRevision: 1,
        }),
      ]);
      assert.deepEqual(updates.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
      const restored = await first.getConversation(conversation.id);
      assert.equal(restored.rosterRevision, 2);
      assert.equal(restored.participants.length, 2);
      assert.equal(restored.messages[0]?.participantId, builder.id);
      const removedId = restored.participants.some(({ id }) => id === builder.id)
        ? reviewer.id
        : builder.id;
      assert.equal(await firstStorage.getCursor(conversation.id, removedId), 1);
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
    const firstStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const first = new ConversationService(firstStorage);
    const conversation = await first.createConversation({
      participants: [
        { id: "user", type: "human" },
        { id: "agent-a", type: "agent" },
      ],
    });
    // Use an equivalent URL with a distinct storage key so this exercises the
    // database transaction race rather than the in-process pending map.
    const competingStorage = await DrizzleLibSqlConversationStorage.open({
      url: url.replace("file:", "file://"),
    });
    const competing = new ConversationService(competingStorage);
    const input = { participantId: "user", body: "@agent-a once" };
    const [left, right] = await Promise.all([
      first.createMessage(conversation.id, input, "durable-key"),
      competing.createMessage(conversation.id, input, "durable-key"),
    ]);
    assert.equal(left.id, right.id);
    assert.equal((await first.listMessages(conversation.id)).length, 1);
    await competing.close();
    await first.close();

    const reopenedStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const reopened = new ConversationService(reopenedStorage);
    const replay = await reopened.createMessage(conversation.id, input, "durable-key");
    assert.equal(replay.id, left.id);
    const [conflictingPending, matchingPending] = await Promise.allSettled([
      reopened.createMessage(
        conversation.id,
        { participantId: "user", body: "@agent-a changed" },
        "durable-key",
      ),
      reopened.createMessage(conversation.id, input, "durable-key"),
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
        conversation.id,
        { participantId: "user", body: "@agent-a changed" },
        "durable-key",
      ),
      /different payload/,
    );
    assert.equal((await reopened.listMessages(conversation.id)).length, 1);
    assert.equal(
      (await reopened.createMessage(conversation.id, { participantId: "user", body: "next" })).sequence,
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
    const firstStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const first = new ConversationService(firstStorage);
    const conversation = await first.createConversation({
      participants: [
        { id: "user", type: "human" },
        { id: "agent-a", type: "agent" },
      ],
    });
    const trigger = await first.createMessage(conversation.id, {
      participantId: "user",
      body: "@agent-a implement this",
    });
    const input = {
      participantId: "agent-a",
      body: "Implemented",
      triggerMessageId: trigger.id,
      triggerSequence: trigger.sequence,
    };
    const competingStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const competing = new ConversationService(competingStorage);
    const commits = await Promise.all([
      first.createResponse(conversation.id, input),
      competing.createResponse(conversation.id, input),
    ]);
    assert.deepEqual(commits.map((result) => result.created).sort(), [false, true]);
    assert.equal(commits[0]!.message.id, commits[1]!.message.id);
    const committed = commits.find((result) => result.created)!;
    await competing.close();
    await first.close();

    const secondStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const second = new ConversationService(secondStorage);
    const duplicate = await second.createResponse(conversation.id, input);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.message.id, committed.message.id);
    assert.equal((await second.listMessages(conversation.id)).length, 2);
    assert.equal(await secondStorage.getCursor(conversation.id, "agent-a"), trigger.sequence);
    assert.equal(
      (await second.createMessage(conversation.id, { participantId: "user", body: "next" })).sequence,
      3,
    );
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Drizzle/libSQL preserves conversations, sequences, messages, and cursors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-libsql-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  let conversationId!: string;
  try {
    const firstStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const first = new ConversationService(firstStorage);
    const conversation = await first.createConversation({
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
    conversationId = conversation.id;
    assert.equal(
      (await first.createMessage(conversation.id, { participantId: "user", body: "@agent-a first" }))
        .sequence,
      1,
    );
    assert.equal(
      (await first.createMessage(conversation.id, { participantId: "agent-a", body: "done" })).sequence,
      2,
    );
    await firstStorage.setCursor(conversation.id, "agent-a", 1);
    await first.close();

    const secondStorage = await DrizzleLibSqlConversationStorage.open({ url });
    const second = new ConversationService(secondStorage);
    assert.deepEqual((await second.getConversation(conversationId)).participants[1], {
      id: "agent-a",
      handle: "agent-a",
      type: "agent",
      displayName: "Builder",
      role: "implementation",
      profile: "Builds and tests requested changes.",
      status: "active",
    });
    assert.deepEqual(
      (await second.listMessages(conversationId)).map((message) => [message.sequence, message.body]),
      [[1, "@agent-a first"], [2, "done"]],
    );
    assert.equal(await secondStorage.getCursor(conversationId, "agent-a"), 1);
    assert.equal(
      (await second.createMessage(conversationId, { participantId: "user", body: "third" })).sequence,
      3,
    );
    assert.deepEqual(
      (await second.listMessages(conversationId, { afterSequence: 1, limit: 1 })).map(({ sequence }) => sequence),
      [2],
    );
    assert.deepEqual(
      (await second.listMessages(conversationId, { beforeSequence: 3, limit: 1 })).map(({ sequence }) => sequence),
      [2],
    );
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
