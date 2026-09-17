CREATE TABLE `conversation_lifecycles` (
  `conversation_id` text PRIMARY KEY NOT NULL REFERENCES `conversations`(`id`) ON DELETE cascade,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE cascade,
  `state` text NOT NULL CHECK (`state` IN ('active', 'snoozed', 'settled')),
  `snoozed_until` text,
  `settled_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CHECK (
    (`state` = 'active' AND `snoozed_until` IS NULL AND `settled_at` IS NULL)
    OR (`state` = 'snoozed' AND `snoozed_until` IS NOT NULL AND `settled_at` IS NULL)
    OR (`state` = 'settled' AND `snoozed_until` IS NULL AND `settled_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX `conversation_lifecycles_workspace_state_idx` ON `conversation_lifecycles` (`workspace_id`, `state`);
