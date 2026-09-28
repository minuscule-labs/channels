ALTER TABLE `conversation_agent_bindings` ADD `runtime_owner_id` text;
--> statement-breakpoint
CREATE TABLE `local_runtime_owners` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_runtime_owners_owner_id_unique` ON `local_runtime_owners` (`owner_id`);
--> statement-breakpoint
CREATE TABLE `conversation_agent_session_history` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `agent_identity_id` text NOT NULL,
  `workspace_agent_config_id` text NOT NULL,
  `binding_id` text NOT NULL,
  `binding_generation` integer NOT NULL,
  `runtime_adapter` text NOT NULL,
  `managed_session_id` text,
  `runtime_owner_id` text,
  `legacy_runtime_session_ref` text,
  `mapping` text NOT NULL,
  `state` text NOT NULL,
  `origin` text NOT NULL,
  `conversation_sequence_at_activation` integer,
  `conversation_sequence_at_retirement` integer,
  `activated_at` text NOT NULL,
  `retired_at` text,
  `retirement_reason` text,
  `cleanup_action` text NOT NULL,
  `cleanup_status` text NOT NULL,
  `retention_status` text NOT NULL,
  `cleanup_attempt_count` integer NOT NULL,
  `last_cleanup_attempt_at` text,
  `last_observed_runtime_status` text,
  `last_verified_at` text,
  `last_cleanup_error_category` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_agent_session_history_binding_generation_unique`
  ON `conversation_agent_session_history` (`binding_id`, `binding_generation`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_agent_session_history_active_route_unique`
  ON `conversation_agent_session_history` (`workspace_id`, `conversation_id`, `agent_identity_id`)
  WHERE `state` = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_agent_session_history_active_managed_session_unique`
  ON `conversation_agent_session_history` (`runtime_adapter`, `runtime_owner_id`, `managed_session_id`)
  WHERE `mapping` = 'managed' AND `state` = 'active';
--> statement-breakpoint
CREATE INDEX `conversation_agent_session_history_route_idx`
  ON `conversation_agent_session_history` (`conversation_id`, `agent_identity_id`, `activated_at`);
--> statement-breakpoint
CREATE INDEX `conversation_agent_session_history_cleanup_idx`
  ON `conversation_agent_session_history` (`cleanup_status`, `updated_at`);
--> statement-breakpoint
INSERT INTO `conversation_agent_session_history` (
  `id`, `workspace_id`, `conversation_id`, `agent_identity_id`, `workspace_agent_config_id`,
  `binding_id`, `binding_generation`, `runtime_adapter`, `managed_session_id`, `runtime_owner_id`,
  `legacy_runtime_session_ref`, `mapping`, `state`, `origin`, `activated_at`, `retired_at`, `retirement_reason`,
  `cleanup_action`, `cleanup_status`, `retention_status`, `cleanup_attempt_count`, `created_at`, `updated_at`
)
SELECT
  lower(hex(randomblob(16))), `workspace_id`, `conversation_id`, `agent_identity_id`, `workspace_agent_config_id`,
  `id`, `generation`, `runtime_adapter`, NULL, NULL, `runtime_session_id`,
  'legacy_unmapped', CASE WHEN `state` = 'disabled' THEN 'retired' ELSE 'active' END,
  'migrated', `created_at`, NULL, NULL, 'none', 'unknown', 'retained', 0, `created_at`, `updated_at`
FROM `conversation_agent_bindings`;
