-- Only reusable presets change; existing Conversation snapshots/settings remain immutable.
UPDATE conversation_presets
SET definition = json_set(
  json_remove(definition, '$.model', '$.reasoningLevel', '$.turnTimeoutMs', '$.idleSleepTimeoutMs'),
  '$.participants', json(COALESCE((
    SELECT json_group_array(json_object('identityId', json_extract(value, '$.identityId')))
    FROM json_each(conversation_presets.definition, '$.participants')
    WHERE json_extract(value, '$.identityId') IS NOT NULL
  ), '[]')),
  '$.revision', revision + 1
), revision = revision + 1
WHERE json_type(definition, '$.model') IS NOT NULL
   OR json_type(definition, '$.reasoningLevel') IS NOT NULL
   OR json_type(definition, '$.turnTimeoutMs') IS NOT NULL
   OR json_type(definition, '$.idleSleepTimeoutMs') IS NOT NULL
   OR EXISTS (
     SELECT 1 FROM json_each(conversation_presets.definition, '$.participants')
     WHERE json_type(value, '$.role') IS NOT NULL OR json_extract(value, '$.identityId') IS NULL
   );
