CREATE TABLE workspace_compositions (
  owner_identity_id text NOT NULL,
  request_id text NOT NULL,
  state text NOT NULL,
  definition text NOT NULL,
  PRIMARY KEY (owner_identity_id, request_id)
);
