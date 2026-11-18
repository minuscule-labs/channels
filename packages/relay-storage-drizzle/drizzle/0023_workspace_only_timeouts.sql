-- Editable Conversation settings no longer override the Workspace timeout policy.
-- Keep immutable creation snapshots and explicitly saved Workspace policies unchanged.
UPDATE conversation_settings
SET definition = json_set(
  json_remove(definition, '$.turnTimeoutMs', '$.idleSleepTimeoutMs'),
  '$.revision', revision + 1
), revision = revision + 1
WHERE json_type(definition, '$.turnTimeoutMs') IS NOT NULL
   OR json_type(definition, '$.idleSleepTimeoutMs') IS NOT NULL;
