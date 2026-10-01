ALTER TABLE `conversation_agent_bindings` ADD `last_active_at` text;
--> statement-breakpoint
ALTER TABLE `conversation_agent_bindings` ADD `slept_at` text;
--> statement-breakpoint
ALTER TABLE `conversation_agent_bindings` ADD `wake_requested_at` text;
--> statement-breakpoint
ALTER TABLE `conversation_agent_bindings` ADD `managed_session_missing_at` text;
--> statement-breakpoint
UPDATE `conversation_agent_bindings`
SET `last_active_at` = COALESCE(`last_verified_at`, `updated_at`)
WHERE `last_active_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `conversation_agent_bindings_idle_idx`
  ON `conversation_agent_bindings` (`state`, `last_active_at`);
