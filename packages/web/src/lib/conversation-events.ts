import type { ConversationEvent } from "@minu/channels-core/types";

export type ConversationCacheAction =
  | { type: "merge-message"; message: Extract<ConversationEvent, { type: "message.created" }>["message"] }
  | { type: "refresh-metadata"; rosterRevision?: number }
  | { type: "ignore" };

export function conversationCacheAction(
  event: ConversationEvent,
  currentRosterRevision: number | undefined,
): ConversationCacheAction {
  if (event.type === "message.created") {
    return { type: "merge-message", message: event.message };
  }
  if (event.type === "conversation.updated") return { type: "refresh-metadata" };
  if (currentRosterRevision === undefined || event.rosterRevision > currentRosterRevision) {
    return { type: "refresh-metadata", rosterRevision: event.rosterRevision };
  }
  return { type: "ignore" };
}
