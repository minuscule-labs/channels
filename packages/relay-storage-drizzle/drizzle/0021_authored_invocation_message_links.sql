CREATE TABLE authored_invocation_message_links (
  invocation_id TEXT PRIMARY KEY NOT NULL REFERENCES authored_skill_invocations(id),
  message_id TEXT NOT NULL UNIQUE
);
