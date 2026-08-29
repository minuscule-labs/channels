CREATE TABLE `agent_host_cursors` (
	`channel_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`last_processed_sequence` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_host_cursors_route_unique` ON `agent_host_cursors` (`channel_id`,`participant_id`);