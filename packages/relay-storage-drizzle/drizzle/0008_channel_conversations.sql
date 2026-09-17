ALTER TABLE `channel_agent_bindings` RENAME TO `conversation_agent_bindings`;
--> statement-breakpoint
ALTER TABLE `channel_working_folders` RENAME TO `conversation_working_folders`;
--> statement-breakpoint
ALTER TABLE `conversation_agent_bindings` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `conversation_working_folders` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `agent_host_cursors` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `delivery_dead_letters` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
DROP INDEX `channel_agent_bindings_route_unique`;
--> statement-breakpoint
DROP INDEX `channel_agent_bindings_runtime_session_unique`;
--> statement-breakpoint
DROP INDEX `channel_agent_bindings_channel_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_agent_bindings_route_unique` ON `conversation_agent_bindings` (`workspace_id`, `conversation_id`, `agent_identity_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_agent_bindings_runtime_session_unique` ON `conversation_agent_bindings` (`runtime_adapter`, `runtime_session_id`);
--> statement-breakpoint
CREATE INDEX `conversation_agent_bindings_conversation_idx` ON `conversation_agent_bindings` (`conversation_id`);
--> statement-breakpoint
DROP INDEX `channel_working_folders_position_unique`;
--> statement-breakpoint
DROP INDEX `channel_working_folders_primary_unique`;
--> statement-breakpoint
DROP INDEX `channel_working_folders_workspace_channel_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_working_folders_position_unique` ON `conversation_working_folders` (`conversation_id`, `position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_working_folders_primary_unique` ON `conversation_working_folders` (`conversation_id`) WHERE `is_primary` = 1;
--> statement-breakpoint
CREATE INDEX `conversation_working_folders_workspace_conversation_idx` ON `conversation_working_folders` (`workspace_id`, `conversation_id`);
--> statement-breakpoint
DROP INDEX `agent_host_cursors_route_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_host_cursors_conversation_route_unique` ON `agent_host_cursors` (`conversation_id`, `participant_id`);
--> statement-breakpoint
DROP INDEX `delivery_dead_letters_trigger_unique`;
--> statement-breakpoint
DROP INDEX `delivery_dead_letters_route_sequence_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_dead_letters_conversation_trigger_unique` ON `delivery_dead_letters` (`conversation_id`, `participant_id`, `trigger_message_id`);
--> statement-breakpoint
CREATE INDEX `delivery_dead_letters_conversation_route_sequence_idx` ON `delivery_dead_letters` (`conversation_id`, `participant_id`, `trigger_sequence`);
