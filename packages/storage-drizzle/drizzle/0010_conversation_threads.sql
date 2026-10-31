ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id);
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN root_message_id TEXT REFERENCES messages(id);
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN thread_context_json TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX conversations_thread_root_unique ON conversations(parent_conversation_id, root_message_id);
