CREATE TABLE `conversation_attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE cascade,
  `message_id` text REFERENCES `messages`(`id`) ON DELETE cascade,
  `uploader_identity_id` text NOT NULL,
  `filename` text NOT NULL,
  `mime_type` text NOT NULL CHECK (`mime_type` IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  `size` integer NOT NULL,
  `content_hash` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('staged', 'attached', 'deleting')),
  `position` integer,
  `created_at` text NOT NULL,
  CONSTRAINT `conversation_attachments_size_check` CHECK (`size` BETWEEN 1 AND 10485760),
  CONSTRAINT `conversation_attachments_state_check` CHECK (
    (`status` = 'staged' AND `message_id` IS NULL AND `position` IS NULL)
    OR (`status` = 'attached' AND `message_id` IS NOT NULL AND `position` IS NOT NULL AND `position` >= 0)
    OR `status` = 'deleting'
  )
);
--> statement-breakpoint
CREATE INDEX `conversation_attachments_conversation_status_created_idx` ON `conversation_attachments` (`conversation_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `conversation_attachments_status_created_idx` ON `conversation_attachments` (`status`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_attachments_message_position_unique` ON `conversation_attachments` (`message_id`, `position`);
