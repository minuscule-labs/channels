import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRelayBindingStore, type ConversationPreset } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: presets use scoped revisions and creation snapshots survive editing and deletion`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "channels-presets-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store = backend === "memory" ? new InMemoryRelayBindingStore() : await DrizzleLibSqlRelayStorage.open({ url });
  t.after(async () => { if ("close" in store) await store.close(); await rm(directory, { recursive: true, force: true }); });
  const timestamp = new Date().toISOString();
  const preset: ConversationPreset = { id: "preset-a", workspaceId: "workspace-a", name: "Delivery", revision: 1,
    participants: [{ identityId: "agent" }], guidance: "Check in after verification.", createdAt: timestamp, updatedAt: timestamp };
  assert.equal(await store.putConversationPreset(preset, null), true);
  assert.equal(await store.putConversationPreset(preset, null), false);
  assert.deepEqual(await store.listConversationPresets("workspace-b"), []);
  const snapshot = { workspaceId: preset.workspaceId, conversationId: "conversation-a", actorIdentityId: "owner", name: "Feature",
    participants: [{ identityId: "agent", role: "Builder" }], model: { provider: "test", id: "model" }, reasoningLevel: "high" as const, guidance: preset.guidance };
  assert.deepEqual(await store.putConversationCreationSetup(snapshot), snapshot);
  assert.deepEqual(await store.putConversationCreationSetup({ ...snapshot, guidance: "Overwrite" }), snapshot);
  assert.equal(await store.getConversationCreationSetup("workspace-b", snapshot.conversationId), undefined);
  const folderScope = { workspaceId: preset.workspaceId, conversationId: snapshot.conversationId };
  const initialFolders = [{ ...folderScope, relativePath: "initial", position: 0, primary: true }];
  await store.initializeConversationWorkingFolders(preset.workspaceId, snapshot.conversationId, initialFolders);
  await store.replaceConversationWorkingFolders(preset.workspaceId, snapshot.conversationId, [{ ...initialFolders[0]!, relativePath: "edited" }]);
  const read = (await store.listConversationPresets(preset.workspaceId))[0]!;
  read.participants[0]!.identityId = "Corrupted";
  assert.equal((await store.listConversationPresets(preset.workspaceId))[0]!.participants[0]!.identityId, "agent");
  const settings = { workspaceId: preset.workspaceId, conversationId: snapshot.conversationId,
    participants: preset.participants, guidance: "Editable", turnTimeoutMs: 60_000, idleSleepTimeoutMs: null, revision: 1 };
  assert.equal(await store.putConversationSettings(settings, 0), true);
  assert.equal(await store.putConversationSettings(settings, 0), false);
  assert.equal(await store.getConversationSettings("workspace-b", snapshot.conversationId), undefined);
  assert.equal(await store.putConversationSettings({ ...settings, revision: 2, guidance: "Stale" }, 9), false);
  assert.equal(await store.putConversationSettings({ ...settings, revision: 2 }, 1), true);
  const config = { workspaceId: preset.workspaceId, rootUri: "file:///tmp", turnTimeoutMs: 300_000, createdAt: timestamp, updatedAt: timestamp };
  await store.putWorkspaceConfig(config);
  const updated = { ...preset, revision: 2, guidance: "Changed" };
  assert.equal(await store.putConversationPreset(updated, 99), false);
  assert.equal(await store.putConversationPreset(updated, 1), true);
  assert.equal(await store.deleteConversationPreset("workspace-b", preset.id, 2), false);
  assert.equal(await store.deleteConversationPreset(preset.workspaceId, preset.id, 1), false);
  if (backend === "sqlite") {
    await (store as DrizzleLibSqlRelayStorage).close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
  }
  await store.initializeConversationWorkingFolders(preset.workspaceId, snapshot.conversationId, initialFolders);
  assert.equal((await store.getConversationWorkingFolders(preset.workspaceId, snapshot.conversationId))[0]?.relativePath, "edited", "creation retries never overwrite edits, including after reopening SQLite");
  assert.deepEqual(await store.getConversationSettings(preset.workspaceId, snapshot.conversationId), { ...settings, revision: 2 });
  assert.equal((await store.getWorkspaceConfig(preset.workspaceId))?.turnTimeoutMs, 300_000);
  assert.deepEqual(await store.listConversationPresets(preset.workspaceId), [updated]);
  assert.deepEqual(await store.getConversationCreationSetup(preset.workspaceId, snapshot.conversationId), snapshot);
  assert.equal(await store.deleteConversationPreset(preset.workspaceId, preset.id, 2), true);
  assert.deepEqual(await store.listConversationPresets(preset.workspaceId), []);
  assert.deepEqual(await store.getConversationCreationSetup(preset.workspaceId, snapshot.conversationId), snapshot);
});
