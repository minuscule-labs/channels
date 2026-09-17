import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ConversationAgentBindingRecord,
  ConversationWorkingFolder,
  WorkspaceAgentConfig,
} from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

test("private relay storage rejects remote database URLs", async () => {
  await assert.rejects(
    DrizzleLibSqlRelayStorage.open({ url: "https://example.turso.io" }),
    /requires a local file: URL/,
  );
});

test("private Conversation working folders are ordered, isolated, atomic, and survive reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-relay-folders-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  const first = await DrizzleLibSqlRelayStorage.open({ url });
  const folders: ConversationWorkingFolder[] = [
    {
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      relativePath: "apps/web",
      position: 0,
      primary: true,
    },
    {
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      relativePath: "packages/shared",
      position: 1,
      primary: false,
    },
  ];
  try {
    assert.deepEqual(
      await first.replaceConversationWorkingFolders("workspace-a", "conversation-a", folders),
      folders,
    );
    assert.deepEqual(await first.getConversationWorkingFolders("workspace-a", "conversation-a"), folders);
    await first.replaceConversationWorkingFolders("workspace-a", "conversation-b", [{
      workspaceId: "workspace-a",
      conversationId: "conversation-b",
      relativePath: "apps/api",
      position: 0,
      primary: true,
    }]);
    assert.deepEqual(await first.getConversationWorkingFolders("workspace-a", "conversation-b"), [{
      workspaceId: "workspace-a",
      conversationId: "conversation-b",
      relativePath: "apps/api",
      position: 0,
      primary: true,
    }]);
    await assert.rejects(first.replaceConversationWorkingFolders("workspace-a", "conversation-a", [
      folders[0]!,
      { ...folders[1]!, relativePath: "apps/api", position: 0 },
    ]), /unique paths and positions/);
    assert.deepEqual(await first.getConversationWorkingFolders("workspace-a", "conversation-a"), folders);
    await assert.rejects(first.replaceConversationWorkingFolders("workspace-a", "conversation-a", [
      { ...folders[0]!, primary: false },
    ]), /exactly one primary/);
    assert.deepEqual(await first.getConversationWorkingFolders("workspace-a", "conversation-a"), folders);
  } finally {
    await first.close();
  }

  const reopened = await DrizzleLibSqlRelayStorage.open({ url });
  try {
    assert.deepEqual(await reopened.getConversationWorkingFolders("workspace-a", "conversation-a"), folders);
    assert.deepEqual(await reopened.replaceConversationWorkingFolders("workspace-a", "conversation-a", []), []);
    assert.deepEqual(await reopened.getConversationWorkingFolders("workspace-a", "conversation-a"), []);
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("private relay storage preserves configs and arbitrates binding leases across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-relay-storage-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  const first = await DrizzleLibSqlRelayStorage.open({ url });
  const second = await DrizzleLibSqlRelayStorage.open({ url });
  const timestamp = "2026-01-01T00:00:00.000Z";
  const config: WorkspaceAgentConfig = {
    id: "agent-config",
    workspaceId: "workspace-a",
    agentIdentityId: "agent-a",
    personaRef: "persona:builder:v1",
    personaPrompt: "Build carefully and verify every change.",
    runtimeAdapter: "pi",
    modelProvider: "openai",
    modelId: "gpt-test",
    reasoningLevel: "high",
    skillIds: ["skill:review"],
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const record: ConversationAgentBindingRecord = {
    id: "binding-a",
    workspaceAgentConfigId: config.id,
    workspaceId: config.workspaceId,
    conversationId: "conversation-a",
    agentIdentityId: config.agentIdentityId,
    runtimeAdapter: "pi",
    runtimeSessionId: "runtime-session-a",
    generation: 1,
    state: "connected",
    wakePolicy: "mentions",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await first.putWorkspaceConfig({
      workspaceId: config.workspaceId,
      rootUri: "file:///private/workspace",
      notesFolderId: "folder-private",
      runtimeModelPolicies: {
        pi: [{ provider: "openai", id: "gpt-test" }],
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await first.putAgentConfig(config);
    await first.putBinding(record);
    await first.setCursor(record.conversationId, record.agentIdentityId, 3);
    await second.setCursor(record.conversationId, record.agentIdentityId, 2);

    const [leaseA, leaseB] = await Promise.all([
      first.acquireBindingLease(
        record.id,
        "relay-a",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:31.000Z",
      ),
      second.acquireBindingLease(
        record.id,
        "relay-b",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:31.000Z",
      ),
    ]);
    assert.equal(Number(Boolean(leaseA)) + Number(Boolean(leaseB)), 1);
    const winner = leaseA ? "relay-a" : "relay-b";
    const winnerStore = leaseA ? first : second;
    assert.equal(
      await winnerStore.renewBindingLease(
        record.id,
        1,
        winner,
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:32.000Z",
      ),
      true,
    );
    assert.equal(
      await winnerStore.renewBindingLease(
        record.id,
        0,
        winner,
        "2026-01-01T00:00:03.000Z",
        "2026-01-01T00:00:33.000Z",
      ),
      false,
    );
    await winnerStore.releaseBindingLease(record.id, 1, winner);

    const replaced = await second.replaceBindingSession(
      record.id,
      1,
      "pi",
      "runtime-session-b",
      "2026-01-01T00:00:04.000Z",
    );
    assert.equal(replaced?.generation, 2);
    assert.equal(
      await first.replaceBindingSession(
        record.id,
        1,
        "pi",
        "runtime-session-stale",
        "2026-01-01T00:00:05.000Z",
      ),
      undefined,
    );
    const deadLetter = {
      conversationId: record.conversationId,
      participantId: record.agentIdentityId,
      triggerMessageId: "message-poison",
      triggerSequence: 7,
      reason: "delivery_rejected" as const,
      recordedAt: "2026-01-01T00:00:05.500Z",
    };
    await first.commitDeliveryDeadLetter(deadLetter);
    // Replaying after an acknowledgement loss remains exactly-once and monotonic.
    await second.commitDeliveryDeadLetter(deadLetter);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }

  const reopened = await DrizzleLibSqlRelayStorage.open({ url });
  try {
    const reopenedWorkspace = await reopened.getWorkspaceConfig(config.workspaceId);
    assert.equal(reopenedWorkspace?.rootUri, "file:///private/workspace");
    assert.deepEqual(reopenedWorkspace?.runtimeModelPolicies, {
      pi: [{ provider: "openai", id: "gpt-test" }],
    });
    const reopenedConfig = await reopened.getAgentConfig(config.id);
    assert.equal(reopenedConfig?.personaRef, "persona:builder:v1");
    assert.equal(reopenedConfig?.personaPrompt, "Build carefully and verify every change.");
    assert.equal(reopenedConfig?.runtimeAdapter, "pi");
    assert.equal(reopenedConfig?.modelProvider, "openai");
    assert.equal(reopenedConfig?.modelId, "gpt-test");
    assert.equal(reopenedConfig?.reasoningLevel, "high");
    assert.deepEqual(reopenedConfig?.skillIds, ["skill:review"]);
    assert.equal((await reopened.listWorkspaceAgentConfigs(config.workspaceId)).length, 1);
    assert.equal((await reopened.listWorkspaceBindings(config.workspaceId)).length, 1);
    const persisted = await reopened.getBinding(record.id);
    assert.equal(persisted?.runtimeSessionId, "runtime-session-b");
    assert.equal(persisted?.generation, 2);
    assert.equal(persisted?.leaseOwner, undefined);
    assert.equal(await reopened.getCursor(record.conversationId, record.agentIdentityId), 7);
    assert.deepEqual(await reopened.listDeliveryDeadLetters(
      record.conversationId,
      record.agentIdentityId,
    ), [{
      conversationId: record.conversationId,
      participantId: record.agentIdentityId,
      triggerMessageId: "message-poison",
      triggerSequence: 7,
      reason: "delivery_rejected",
      createdAt: "2026-01-01T00:00:05.500Z",
      updatedAt: "2026-01-01T00:00:05.500Z",
    }]);
    const disabled = await reopened.disableBinding(
      record.id,
      2,
      "2026-01-01T00:00:06.000Z",
    );
    assert.equal(disabled?.state, "disabled");
    assert.equal(disabled?.generation, 3);
    assert.equal(await reopened.disableBinding(
      record.id,
      2,
      "2026-01-01T00:00:07.000Z",
    ), undefined);
    await reopened.deleteBinding(record.id);
    assert.equal(await reopened.getBinding(record.id), undefined);
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});
