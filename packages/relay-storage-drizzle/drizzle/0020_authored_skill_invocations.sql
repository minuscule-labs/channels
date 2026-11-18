CREATE TABLE `authored_skill_invocations` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `actor_identity_id` text NOT NULL,
  `request_id` text NOT NULL,
  `request_hash` text NOT NULL,
  `document_id` text NOT NULL,
  `source` text NOT NULL,
  `revision` integer NOT NULL,
  `content_hash` text NOT NULL,
  `name` text NOT NULL,
  `arguments` text NOT NULL,
  `targets` text NOT NULL,
  `accepted_at` text NOT NULL,
  FOREIGN KEY (`document_id`) REFERENCES `authored_documents` (`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authored_skill_invocation_request_unique` ON `authored_skill_invocations` (`conversation_id`, `actor_identity_id`, `request_id`);
