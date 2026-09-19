CREATE TABLE `turn_failure_diagnostics` (
	`conversation_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`trigger_sequence` integer NOT NULL,
	`binding_id` text,
	`binding_generation` integer,
	`started_at` text NOT NULL,
	`failed_at` text NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`attempt_count` integer NOT NULL,
	`cause_category` text NOT NULL,
	`delivery_outcome` text NOT NULL,
	`remediation_code` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_failure_diagnostics_trigger_unique` ON `turn_failure_diagnostics` (`conversation_id`,`participant_id`,`trigger_message_id`);
--> statement-breakpoint
CREATE INDEX `turn_failure_diagnostics_retention_idx` ON `turn_failure_diagnostics` (`conversation_id`,`failed_at`,`trigger_sequence`,`participant_id`);
--> statement-breakpoint
CREATE TABLE `turn_failure_finalization_tombstones` (
	`conversation_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_failure_finalization_tombstones_trigger_unique` ON `turn_failure_finalization_tombstones` (`conversation_id`,`participant_id`,`trigger_message_id`);
