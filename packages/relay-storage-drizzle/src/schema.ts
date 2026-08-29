import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const localWorkspaceConfigs = sqliteTable("local_workspace_config", {
  workspaceId: text("workspace_id").primaryKey(),
  rootUri: text("root_uri").notNull(),
  notesFolderId: text("notes_folder_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaceAgentConfigs = sqliteTable("workspace_agent_configs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentIdentityId: text("agent_identity_id").notNull(),
  personaRef: text("persona_ref"),
  personaPrompt: text("persona_prompt"),
  runtimeAdapter: text("runtime_adapter"),
  status: text("status", { enum: ["active", "disabled"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("workspace_agent_configs_assignment_unique")
    .on(table.workspaceId, table.agentIdentityId),
]);

export const channelAgentBindings = sqliteTable("channel_agent_bindings", {
  id: text("id").primaryKey(),
  workspaceAgentConfigId: text("workspace_agent_config_id").notNull()
    .references(() => workspaceAgentConfigs.id),
  workspaceId: text("workspace_id").notNull(),
  channelId: text("channel_id").notNull(),
  agentIdentityId: text("agent_identity_id").notNull(),
  executionEnvironmentId: text("execution_environment_id"),
  runtimeAdapter: text("runtime_adapter").notNull(),
  runtimeSessionId: text("runtime_session_id").notNull(),
  generation: integer("generation").notNull(),
  state: text("state", { enum: ["connected", "offline", "replacing", "disabled"] }).notNull(),
  wakePolicy: text("wake_policy", {
    enum: ["mentions", "direct_mentions", "all_messages", "muted"],
  }).notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  lastVerifiedAt: text("last_verified_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("channel_agent_bindings_route_unique")
    .on(table.workspaceId, table.channelId, table.agentIdentityId),
  uniqueIndex("channel_agent_bindings_runtime_session_unique")
    .on(table.runtimeAdapter, table.runtimeSessionId),
  index("channel_agent_bindings_channel_idx").on(table.channelId),
]);
