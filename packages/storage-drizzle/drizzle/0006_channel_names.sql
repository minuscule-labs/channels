ALTER TABLE `channels` ADD `name` text DEFAULT 'Untitled Channel' NOT NULL;
--> statement-breakpoint
UPDATE `channels` SET `name` = 'Channel ' || substr(`id`, 1, 8) WHERE `name` = 'Untitled Channel';