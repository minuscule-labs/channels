CREATE TABLE account_library_items (
  id text PRIMARY KEY NOT NULL,
  owner_identity_id text NOT NULL,
  version integer NOT NULL,
  definition text NOT NULL
);
--> statement-breakpoint
CREATE INDEX account_library_owner_idx ON account_library_items (owner_identity_id);
--> statement-breakpoint
CREATE TABLE account_library_versions (
  item_id text NOT NULL REFERENCES account_library_items(id),
  owner_identity_id text NOT NULL,
  version integer NOT NULL,
  definition text NOT NULL,
  PRIMARY KEY (item_id, version)
);
