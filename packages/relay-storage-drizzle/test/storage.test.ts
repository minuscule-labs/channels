import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChannelAgentBindingRecord, WorkspaceAgentConfig } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

test("private relay storage rejects remote database URLs", async () => {
  await assert.rejects(
    DrizzleLibSqlRelayStorage.open({ url: "https://example.turso.io" }),
    /requires a local file: URL/,
  );
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
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const record: ChannelAgentBindingRecord = {
    id: "binding-a",
    workspaceAgentConfigId: config.id,
    workspaceId: config.workspaceId,
    channelId: "channel-a",
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
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await first.putAgentConfig(config);
    await first.putBinding(record);
    await first.setCursor(record.channelId, record.agentIdentityId, 3);
    await second.setCursor(record.channelId, record.agentIdentityId, 2);

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
  } finally {
    await Promise.all([first.close(), second.close()]);
  }

  const reopened = await DrizzleLibSqlRelayStorage.open({ url });
  try {
    assert.equal((await reopened.getWorkspaceConfig(config.workspaceId))?.rootUri, "file:///private/workspace");
    const reopenedConfig = await reopened.getAgentConfig(config.id);
    assert.equal(reopenedConfig?.personaRef, "persona:builder:v1");
    assert.equal(reopenedConfig?.personaPrompt, "Build carefully and verify every change.");
    assert.equal(reopenedConfig?.runtimeAdapter, "pi");
    assert.equal(reopenedConfig?.modelProvider, "openai");
    assert.equal(reopenedConfig?.modelId, "gpt-test");
    assert.equal(reopenedConfig?.reasoningLevel, "high");
    assert.equal((await reopened.listWorkspaceAgentConfigs(config.workspaceId)).length, 1);
    assert.equal((await reopened.listWorkspaceBindings(config.workspaceId)).length, 1);
    const persisted = await reopened.getBinding(record.id);
    assert.equal(persisted?.runtimeSessionId, "runtime-session-b");
    assert.equal(persisted?.generation, 2);
    assert.equal(persisted?.leaseOwner, undefined);
    assert.equal(await reopened.getCursor(record.channelId, record.agentIdentityId), 3);
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
