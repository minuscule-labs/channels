CREATE TABLE `delivery_dead_letters` (
	`channel_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`trigger_sequence` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_dead_letters_trigger_unique` ON `delivery_dead_letters` (`channel_id`,`participant_id`,`trigger_message_id`);
--> statement-breakpoint
CREATE INDEX `delivery_dead_letters_route_sequence_idx` ON `delivery_dead_letters` (`channel_id`,`participant_id`,`trigger_sequence`);
