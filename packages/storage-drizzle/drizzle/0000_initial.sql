CREATE TABLE IF NOT EXISTS `agent_cursors` (
	`channel_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`last_processed_sequence` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `participant_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`participant_id` text NOT NULL,
	`targets_json` text NOT NULL,
	`body` text NOT NULL,
	`reply_to` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `messages_channel_sequence_unique` ON `messages` (`channel_id`,`sequence`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_channel_sequence` ON `messages` (`channel_id`,`sequence`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `participants` (
	`channel_id` text NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`display_name` text,
	`position` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
