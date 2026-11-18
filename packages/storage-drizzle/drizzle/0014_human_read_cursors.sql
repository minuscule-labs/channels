CREATE TABLE `human_read_cursors` (
  `conversation_id` text NOT NULL REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  `identity_id` text NOT NULL REFERENCES `identities` (`id`),
  `sequence` integer NOT NULL CHECK (`sequence` >= 0),
  PRIMARY KEY (`conversation_id`, `identity_id`)
);
--> statement-breakpoint
CREATE INDEX `messages_activity_order` ON `messages` (`created_at`, `id`);
