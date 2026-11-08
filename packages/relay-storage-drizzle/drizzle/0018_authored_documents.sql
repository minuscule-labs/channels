CREATE TABLE `authored_documents` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `conversation_id` text,
  `kind` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `content` text NOT NULL,
  `version` integer NOT NULL,
  `published_revision` integer,
  `state` text NOT NULL,
  `created_by` text NOT NULL,
  `updated_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `authored_documents_scope_idx` ON `authored_documents` (`workspace_id`, `conversation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `authored_workspace_instructions_unique` ON `authored_documents` (`workspace_id`) WHERE `kind` = 'instructions' AND `conversation_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `authored_channel_instructions_unique` ON `authored_documents` (`workspace_id`, `conversation_id`) WHERE `kind` = 'instructions' AND `conversation_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `authored_document_revisions` (
  `document_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `revision` integer NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `content` text NOT NULL,
  `content_hash` text NOT NULL,
  `published_by` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`document_id`, `revision`),
  FOREIGN KEY (`document_id`) REFERENCES `authored_documents` (`id`) ON UPDATE no action ON DELETE no action
);
