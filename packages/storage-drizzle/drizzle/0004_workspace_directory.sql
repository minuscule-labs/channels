CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`display_name` text,
	`public_profile` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`mention_handle` text NOT NULL,
	`access_role` text NOT NULL,
	`role_label` text,
	`profile_override` text,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `identity_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_handle_unique` ON `workspace_members` (`workspace_id`,`mention_handle`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
ALTER TABLE `channels` ADD `workspace_id` text REFERENCES workspaces(id);--> statement-breakpoint
ALTER TABLE `participants` ADD `handle` text;--> statement-breakpoint
INSERT OR IGNORE INTO `workspaces`
  (`id`, `slug`, `name`, `status`, `created_at`, `updated_at`)
SELECT
  'legacy-default-workspace', 'legacy-default', 'Legacy Default Workspace', 'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM `channels`);--> statement-breakpoint
INSERT OR IGNORE INTO `identities`
  (`id`, `type`, `display_name`, `public_profile`, `status`, `created_at`, `updated_at`)
SELECT
  p.`id`, MIN(p.`type`), MAX(p.`display_name`), MAX(p.`profile`),
  CASE WHEN COUNT(DISTINCT p.`type`) = 1 THEN 'active' ELSE 'disabled' END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `participants` p
GROUP BY p.`id`;--> statement-breakpoint
INSERT OR IGNORE INTO `workspace_members`
  (`workspace_id`, `identity_id`, `mention_handle`, `access_role`, `role_label`,
   `profile_override`, `status`, `joined_at`, `updated_at`)
SELECT
  'legacy-default-workspace', p.`id`, lower(p.`id`), 'member', MAX(p.`role`), MAX(p.`profile`),
  i.`status`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `participants` p
JOIN `identities` i ON i.`id` = p.`id`
GROUP BY p.`id`;--> statement-breakpoint
UPDATE `channels` SET `workspace_id` = 'legacy-default-workspace' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `participants` SET `handle` = lower(`id`) WHERE `handle` IS NULL;