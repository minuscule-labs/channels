CREATE TABLE `channel_agent_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_agent_config_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`agent_identity_id` text NOT NULL,
	`execution_environment_id` text,
	`runtime_adapter` text NOT NULL,
	`runtime_session_id` text NOT NULL,
	`generation` integer NOT NULL,
	`state` text NOT NULL,
	`wake_policy` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`last_verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_agent_config_id`) REFERENCES `workspace_agent_configs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_agent_bindings_route_unique` ON `channel_agent_bindings` (`workspace_id`,`channel_id`,`agent_identity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_agent_bindings_runtime_session_unique` ON `channel_agent_bindings` (`runtime_adapter`,`runtime_session_id`);--> statement-breakpoint
CREATE INDEX `channel_agent_bindings_channel_idx` ON `channel_agent_bindings` (`channel_id`);--> statement-breakpoint
CREATE TABLE `local_workspace_config` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`root_uri` text NOT NULL,
	`notes_folder_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_agent_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_identity_id` text NOT NULL,
	`persona_ref` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_agent_configs_assignment_unique` ON `workspace_agent_configs` (`workspace_id`,`agent_identity_id`);