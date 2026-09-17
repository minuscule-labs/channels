import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const identities = sqliteTable("identities", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["human", "agent", "service"] }).notNull(),
  displayName: text("display_name"),
  publicProfile: text("public_profile"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("workspaces_slug_unique").on(table.slug)],
);

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    identityId: text("identity_id")
      .notNull()
      .references(() => identities.id),
    mentionHandle: text("mention_handle").notNull(),
    accessRole: text("access_role", { enum: ["owner", "admin", "member"] }).notNull(),
    roleLabel: text("role_label"),
    profileOverride: text("profile_override"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    joinedAt: text("joined_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.identityId] }),
    uniqueIndex("workspace_members_handle_unique").on(table.workspaceId, table.mentionHandle),
  ],
);

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  name: text("name").notNull().default("Untitled Channel"),
  createdAt: text("created_at").notNull(),
  nextSequence: integer("next_sequence").notNull().default(1),
  rosterRevision: integer("roster_revision").notNull().default(1),
});

export const participants = sqliteTable(
  "participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    handle: text("handle"),
    type: text("type", { enum: ["human", "agent", "service"] }).notNull(),
    displayName: text("display_name"),
    role: text("role"),
    profile: text("profile"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.id] })],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    participantId: text("participant_id").notNull(),
    targets: text("targets_json", { mode: "json" }).$type<string[]>().notNull(),
    body: text("body").notNull(),
    replyTo: text("reply_to"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("messages_conversation_sequence_unique").on(table.conversationId, table.sequence),
    index("messages_conversation_sequence").on(table.conversationId, table.sequence),
  ],
);

export const messageIdempotency = sqliteTable(
  "message_idempotency",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.participantId, table.idempotencyKey] }),
    uniqueIndex("message_idempotency_message_unique").on(table.messageId),
  ],
);

export const responseDeliveries = sqliteTable(
  "response_deliveries",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(),
    triggerMessageId: text("trigger_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    triggerSequence: integer("trigger_sequence").notNull(),
    responseMessageId: text("response_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.participantId, table.triggerMessageId] }),
    uniqueIndex("response_deliveries_response_unique").on(table.responseMessageId),
  ],
);

export const agentCursors = sqliteTable(
  "agent_cursors",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(),
    lastProcessedSequence: integer("last_processed_sequence").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.participantId] })],
);
