CREATE TABLE `conversation_presets` (
  `workspace_id` text NOT NULL,
  `id` text NOT NULL,
  `revision` integer NOT NULL,
  `definition` text NOT NULL,
  PRIMARY KEY (`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_creation_setups` (
  `workspace_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `definition` text NOT NULL,
  PRIMARY KEY (`workspace_id`, `conversation_id`)
);
