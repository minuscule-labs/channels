CREATE TABLE `agent_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `principal_identity_id` text NOT NULL,
  `request_id` text NOT NULL,
  `revision` integer NOT NULL,
  `definition` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_credentials_request_idx` ON `agent_credentials` (`workspace_id`,`principal_identity_id`,`request_id`);
