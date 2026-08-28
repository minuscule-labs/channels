CREATE TABLE `message_idempotency` (
	`channel_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `participant_id`, `idempotency_key`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_idempotency_message_unique` ON `message_idempotency` (`message_id`);