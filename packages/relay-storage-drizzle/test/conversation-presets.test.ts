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
    participants: [{ identityId: "agent", role: "Builder" }], model: { provider: "test", id: "model" },
    reasoningLevel: "high", guidance: "Check in after verification.", createdAt: timestamp, updatedAt: timestamp };
  assert.equal(await store.putConversationPreset(preset, null), true);
  assert.equal(await store.putConversationPreset(preset, null), false);
  assert.deepEqual(await store.listConversationPresets("workspace-b"), []);
  const snapshot = { workspaceId: preset.workspaceId, conversationId: "conversation-a", actorIdentityId: "owner", name: "Feature",
    participants: preset.participants, model: preset.model, reasoningLevel: preset.reasoningLevel, guidance: preset.guidance };
  assert.deepEqual(await store.putConversationCreationSetup(snapshot), snapshot);
  assert.deepEqual(await store.putConversationCreationSetup({ ...snapshot, guidance: "Overwrite" }), snapshot);
  assert.equal(await store.getConversationCreationSetup("workspace-b", snapshot.conversationId), undefined);
  const read = (await store.listConversationPresets(preset.workspaceId))[0]!;
  read.participants[0]!.role = "Corrupted";
  assert.equal((await store.listConversationPresets(preset.workspaceId))[0]!.participants[0]!.role, "Builder");
  const updated = { ...preset, revision: 2, guidance: "Changed" };
  assert.equal(await store.putConversationPreset(updated, 99), false);
  assert.equal(await store.putConversationPreset(updated, 1), true);
  assert.equal(await store.deleteConversationPreset("workspace-b", preset.id, 2), false);
  assert.equal(await store.deleteConversationPreset(preset.workspaceId, preset.id, 1), false);
  if (backend === "sqlite") {
    await (store as DrizzleLibSqlRelayStorage).close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
  }
  assert.deepEqual(await store.listConversationPresets(preset.workspaceId), [updated]);
  assert.deepEqual(await store.getConversationCreationSetup(preset.workspaceId, snapshot.conversationId), snapshot);
  assert.equal(await store.deleteConversationPreset(preset.workspaceId, preset.id, 2), true);
  assert.deepEqual(await store.listConversationPresets(preset.workspaceId), []);
  assert.deepEqual(await store.getConversationCreationSetup(preset.workspaceId, snapshot.conversationId), snapshot);
});
