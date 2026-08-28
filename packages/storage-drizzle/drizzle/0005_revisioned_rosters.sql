ALTER TABLE `channels` ADD `roster_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `participants` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE TRIGGER `workspace_members_retain_active_owner_update`
BEFORE UPDATE OF `access_role`, `status` ON `workspace_members`
WHEN OLD.`access_role` = 'owner'
  AND OLD.`status` = 'active'
  AND (NEW.`access_role` <> 'owner' OR NEW.`status` <> 'active')
  AND NOT EXISTS (
    SELECT 1 FROM `workspace_members`
    WHERE `workspace_id` = OLD.`workspace_id`
      AND `identity_id` <> OLD.`identity_id`
      AND `access_role` = 'owner'
      AND `status` = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'Workspace must retain an active owner');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_members_retain_active_owner_delete`
BEFORE DELETE ON `workspace_members`
WHEN OLD.`access_role` = 'owner'
  AND OLD.`status` = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM `workspace_members`
    WHERE `workspace_id` = OLD.`workspace_id`
      AND `identity_id` <> OLD.`identity_id`
      AND `access_role` = 'owner'
      AND `status` = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'Workspace must retain an active owner');
END;