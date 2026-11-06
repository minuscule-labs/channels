CREATE TABLE conversation_folders (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT conversation_folders_name_length CHECK (length(name) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX conversation_folders_workspace_name_unique ON conversation_folders(workspace_id, name_key);
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN folder_id TEXT REFERENCES conversation_folders(id);
--> statement-breakpoint
CREATE INDEX conversations_workspace_folder_idx ON conversations(workspace_id, folder_id);
--> statement-breakpoint
CREATE TRIGGER conversations_folder_insert_guard
BEFORE INSERT ON conversations
WHEN NEW.folder_id IS NOT NULL AND (
  NEW.parent_conversation_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM conversation_folders WHERE id = NEW.folder_id AND workspace_id = NEW.workspace_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Folder must belong to a top-level Conversation in the same Workspace');
END;
--> statement-breakpoint
CREATE TRIGGER conversations_folder_update_guard
BEFORE UPDATE OF folder_id, workspace_id, parent_conversation_id ON conversations
WHEN NEW.folder_id IS NOT NULL AND (
  NEW.parent_conversation_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM conversation_folders WHERE id = NEW.folder_id AND workspace_id = NEW.workspace_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Folder must belong to a top-level Conversation in the same Workspace');
END;
