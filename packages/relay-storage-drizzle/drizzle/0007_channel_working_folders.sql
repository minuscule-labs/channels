CREATE TABLE `channel_working_folders` (
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`position` integer NOT NULL CHECK (`position` >= 0),
	`is_primary` integer NOT NULL CHECK (`is_primary` IN (0, 1)),
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `relative_path`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_working_folders_position_unique` ON `channel_working_folders` (`channel_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_working_folders_primary_unique` ON `channel_working_folders` (`channel_id`) WHERE `is_primary` = 1;
--> statement-breakpoint
CREATE INDEX `channel_working_folders_workspace_channel_idx` ON `channel_working_folders` (`workspace_id`,`channel_id`);
