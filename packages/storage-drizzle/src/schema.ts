import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  nextSequence: integer("next_sequence").notNull().default(1),
});

export const participants = sqliteTable(
  "participants",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    type: text("type", { enum: ["human", "agent", "service"] }).notNull(),
    displayName: text("display_name"),
    role: text("role"),
    profile: text("profile"),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.id] })],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    participantId: text("participant_id").notNull(),
    targets: text("targets_json", { mode: "json" }).$type<string[]>().notNull(),
    body: text("body").notNull(),
    replyTo: text("reply_to"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("messages_channel_sequence_unique").on(table.channelId, table.sequence),
    index("messages_channel_sequence").on(table.channelId, table.sequence),
  ],
);

export const responseDeliveries = sqliteTable(
  "response_deliveries",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
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
    primaryKey({ columns: [table.channelId, table.participantId, table.triggerMessageId] }),
    uniqueIndex("response_deliveries_response_unique").on(table.responseMessageId),
  ],
);

export const agentCursors = sqliteTable(
  "agent_cursors",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(),
    lastProcessedSequence: integer("last_processed_sequence").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.participantId] })],
);
