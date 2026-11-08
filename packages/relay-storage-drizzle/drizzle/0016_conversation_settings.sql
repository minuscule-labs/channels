CREATE TABLE `conversation_settings` (
  `workspace_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `revision` integer NOT NULL,
  `definition` text NOT NULL,
  PRIMARY KEY(`workspace_id`, `conversation_id`)
);
--> statement-breakpoint
ALTER TABLE `local_workspace_config` ADD `turn_timeout_ms` integer;
