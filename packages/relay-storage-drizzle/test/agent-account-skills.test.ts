import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { InMemoryRelayBindingStore, type WorkspaceAgentConfig } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../src/storage.ts";

const config: WorkspaceAgentConfig = { id: "config-1", workspaceId: "workspace-1", agentIdentityId: "agent-1",
  personaPrompt: "Workspace instructions", runtimeAdapter: "pi", status: "active", createdAt: "now", updatedAt: "now" };

test("in-memory account skill references remain detached across config reads and writes", async () => {
  const store = new InMemoryRelayBindingStore();
  const input = { ...config, accountSkills: { ownerIdentityId: "owner", skillIds: ["skill-1"] } };
  const result = await store.putAgentConfig(input);
  input.accountSkills.skillIds.push("unpersisted-input");
  result.accountSkills!.skillIds.push("unpersisted-result");
  const fetched = (await store.getWorkspaceAgentConfig(config.workspaceId, config.agentIdentityId))!;
  assert.deepEqual(fetched.accountSkills, { ownerIdentityId: "owner", skillIds: ["skill-1"] });
  fetched.accountSkills!.skillIds.push("unpersisted-read");
  const list = await store.listWorkspaceAgentConfigs(config.workspaceId);
  list[0]!.accountSkills!.skillIds.push("unpersisted-list");
  assert.deepEqual((await store.getAgentConfig(config.id))?.accountSkills, { ownerIdentityId: "owner", skillIds: ["skill-1"] });
});

test("agent account reference migration preserves existing configs, defaults to none, and persists copied references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-account-agent-migration-"));
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store = await DrizzleLibSqlRelayStorage.open({ url });
  try {
    const before = await store.putAgentConfig(config);
    await store.close();
    const client = createClient({ url });
    await client.execute("DROP TABLE agent_credentials");
    await client.execute("DROP TABLE workspace_compositions");
    await client.execute("ALTER TABLE workspace_agent_configs DROP COLUMN workspace_skill_ids");
    await client.execute("ALTER TABLE workspace_agent_configs DROP COLUMN account_skills");
    await client.execute("DELETE FROM __drizzle_migrations WHERE created_at >= 1799539200013");
    client.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.deepEqual(await store.getAgentConfig(config.id), before);
    const updated = await store.putAgentConfig({ ...config, accountSkills: { ownerIdentityId: "owner", skillIds: ["skill-1"] }, workspaceSkillIds: ["workspace-copy"] });
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url });
    assert.deepEqual(await store.getAgentConfig(config.id), updated);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
