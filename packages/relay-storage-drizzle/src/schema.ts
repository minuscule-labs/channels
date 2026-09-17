import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const localWorkspaceConfigs = sqliteTable("local_workspace_config", {
  workspaceId: text("workspace_id").primaryKey(),
  rootUri: text("root_uri").notNull(),
  notesFolderId: text("notes_folder_id"),
  runtimeModelPolicies: text("runtime_model_policies"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversationWorkingFolders = sqliteTable("conversation_working_folders", {
  workspaceId: text("workspace_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  relativePath: text("relative_path").notNull(),
  position: integer("position").notNull(),
  isPrimary: integer("is_primary").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.relativePath] }),
  uniqueIndex("conversation_working_folders_position_unique").on(table.conversationId, table.position),
  uniqueIndex("conversation_working_folders_primary_unique")
    .on(table.conversationId)
    .where(sql`${table.isPrimary} = 1`),
  index("conversation_working_folders_workspace_conversation_idx").on(table.workspaceId, table.conversationId),
]);

export const workspaceAgentConfigs = sqliteTable("workspace_agent_configs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentIdentityId: text("agent_identity_id").notNull(),
  personaRef: text("persona_ref"),
  personaPrompt: text("persona_prompt"),
  runtimeAdapter: text("runtime_adapter"),
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  reasoningLevel: text("reasoning_level", {
    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }),
  skillIds: text("skill_ids"),
  status: text("status", { enum: ["active", "disabled"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("workspace_agent_configs_assignment_unique")
    .on(table.workspaceId, table.agentIdentityId),
]);

export const agentHostCursors = sqliteTable("agent_host_cursors", {
  conversationId: text("conversation_id").notNull(),
  participantId: text("participant_id").notNull(),
  lastProcessedSequence: integer("last_processed_sequence").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("agent_host_cursors_conversation_route_unique").on(table.conversationId, table.participantId),
]);

export const deliveryDeadLetters = sqliteTable("delivery_dead_letters", {
  conversationId: text("conversation_id").notNull(),
  participantId: text("participant_id").notNull(),
  triggerMessageId: text("trigger_message_id").notNull(),
  triggerSequence: integer("trigger_sequence").notNull(),
  reason: text("reason", {
    enum: ["delivery_rejected", "delivery_timed_out", "cursor_commit_failed"],
  }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("delivery_dead_letters_conversation_trigger_unique")
    .on(table.conversationId, table.participantId, table.triggerMessageId),
  index("delivery_dead_letters_conversation_route_sequence_idx")
    .on(table.conversationId, table.participantId, table.triggerSequence),
]);

export const conversationAgentBindings = sqliteTable("conversation_agent_bindings", {
  id: text("id").primaryKey(),
  workspaceAgentConfigId: text("workspace_agent_config_id").notNull()
    .references(() => workspaceAgentConfigs.id),
  workspaceId: text("workspace_id").notNull(),
  conversationId: text("conversation_id").notNull(),
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
  uniqueIndex("conversation_agent_bindings_route_unique")
    .on(table.workspaceId, table.conversationId, table.agentIdentityId),
  uniqueIndex("conversation_agent_bindings_runtime_session_unique")
    .on(table.runtimeAdapter, table.runtimeSessionId),
  index("conversation_agent_bindings_conversation_idx").on(table.conversationId),
]);
