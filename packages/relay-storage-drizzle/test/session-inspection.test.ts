import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRelayBindingStore, type RelayBindingStore } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: inspection lookup selects only the exact current resource and activation from a long history`, async context => {
  const directory = await mkdtemp(join(tmpdir(), "channels-session-inspection-"));
  const store = backend === "memory" ? new InMemoryRelayBindingStore() : await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
  context.after(async () => { if ("close" in store) await store.close(); await rm(directory, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const seed = async (workspaceId: string, conversationId: string, agentIdentityId: string, suffix: string) => {
    await store.putWorkspaceConfig({ workspaceId, rootUri: `file://${directory}`, createdAt: now, updatedAt: now });
    const config = await store.getWorkspaceAgentConfig(workspaceId, agentIdentityId) ?? await store.putAgentConfig({ id: `config-${suffix}`, workspaceId, agentIdentityId, status: "active", createdAt: now, updatedAt: now });
    return store.putBinding({ id: `binding-${suffix}`, workspaceId, conversationId, agentIdentityId, workspaceAgentConfigId: config.id,
      runtimeAdapter: "pi", runtimeSessionId: `managed-${suffix}`, runtimeOwnerId: "private-owner", generation: 1,
      state: "paused", wakePolicy: "muted", createdAt: now, updatedAt: now }, { contextMode: "fresh", conversationSequence: 7 });
  };
  const binding = await seed("workspace-a", "conversation-a", "agent-a", "a");
  await seed("workspace-b", "conversation-b", "agent-b", "b");
  await seed("workspace-a", "conversation-a", "agent-c", "c");
  await seed("workspace-a", "conversation-c", "agent-a", "d");
  for (let generation = 1; generation <= 70; generation++) {
    assert.ok(await store.replaceBindingSession(binding.id, generation, "pi", `replacement-${generation}`, now, "private-owner",
      { contextMode: "fresh", conversationSequence: 7 + generation }));
  }
  const read = (workspace: string, conversation: string, agent: string) => (store as RelayBindingStore).getSessionInspectionRecords(workspace, conversation, agent);
  const before = await store.listSessionHistory("conversation-a", "agent-a");
  const result = await read("workspace-a", "conversation-a", "agent-a");
  assert.equal(result.bindings.length, 1); assert.equal(result.bindings[0]?.generation, 71);
  assert.equal(result.activation?.bindingGeneration, 71); assert.equal(result.activation?.managedSessionId, "replacement-70");
  assert.equal(result.activation?.conversationSequenceAtActivation, 77); assert.equal(result.activation?.state, "active");
  assert.equal((await read("workspace-a", "conversation-a", "agent-c")).activation?.managedSessionId, "managed-c");
  for (const scope of [["workspace-b", "conversation-a", "agent-a"], ["workspace-a", "conversation-b", "agent-a"], ["workspace-a", "conversation-a", "agent-b"], ["workspace-a", "missing", "agent-a"]]) {
    assert.deepEqual(await read(scope[0]!, scope[1]!, scope[2]!), { bindings: [] });
  }
  if (result.activation) result.activation.contextMode = "with_context";
  result.bindings[0]!.generation = 999;
  assert.equal((await read("workspace-a", "conversation-a", "agent-a")).activation?.contextMode, "fresh");
  assert.equal((await read("workspace-a", "conversation-a", "agent-a")).bindings[0]?.generation, 71);
  assert.deepEqual(await store.listSessionHistory("conversation-a", "agent-a"), before, "reads never change history");
});
