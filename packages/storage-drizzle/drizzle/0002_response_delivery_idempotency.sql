CREATE TABLE `response_deliveries` (
	`channel_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`trigger_sequence` integer NOT NULL,
	`response_message_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `participant_id`, `trigger_message_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`response_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `response_deliveries_response_unique` ON `response_deliveries` (`response_message_id`);