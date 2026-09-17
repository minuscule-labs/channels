ALTER TABLE `channels` RENAME TO `conversations`;
--> statement-breakpoint
ALTER TABLE `participants` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `message_idempotency` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `response_deliveries` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `agent_cursors` RENAME COLUMN `channel_id` TO `conversation_id`;
--> statement-breakpoint
DROP INDEX `messages_channel_sequence_unique`;
--> statement-breakpoint
DROP INDEX `messages_channel_sequence`;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_sequence_unique` ON `messages` (`conversation_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `messages_conversation_sequence` ON `messages` (`conversation_id`, `sequence`);
