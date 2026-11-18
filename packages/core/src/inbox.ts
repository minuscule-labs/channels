import type { Conversation, ConversationMessage } from "./types.ts";

export interface ConversationUnreadSummary {
  conversationId: string;
  workspaceId: string;
  parentConversationId?: string;
  /** Absent until this human has acknowledged messages; independent of agent processing. */
  readSequence?: number;
  latestSequence: number;
  count: number;
  mentionCount: number;
  firstUnreadSequence?: number;
}

export interface ActivityItem {
  id: string;
  conversationId: string;
  workspaceId: string;
  conversationName: string;
  channelName: string;
  threadPreview?: string;
  authorName: string;
  preview: string;
  sequence: number;
  createdAt: string;
  kind: "mention" | "thread-reply";
  unread: boolean;
  firstUnreadSequence?: number;
}
export interface ActivityPage { items: ActivityItem[]; nextCursor?: string; }

export function activityCursor(item: Pick<ActivityItem, "createdAt" | "id">): string {
  return JSON.stringify([item.createdAt, item.id]);
}
export function activityBoundary(cursor?: string): { createdAt: string; id: string } | undefined {
  if (cursor === undefined) return;
  const value: unknown = JSON.parse(cursor);
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !Number.isFinite(Date.parse(value[0]))
    || typeof value[1] !== "string" || !value[1] || value[1].length > 256) throw new Error("Invalid Activity cursor");
  return { createdAt: value[0], id: value[1] };
}

/** Activity is a projection of durable messages, not another delivery queue. */
export function activityKind(conversation: Conversation, message: ConversationMessage, identityId: string): ActivityItem["kind"] | undefined {
  if (message.participantId === identityId) return;
  if (message.to.includes(identityId) || message.to.includes("@conversation")) return "mention";
  if (conversation.thread && (
    conversation.thread.context.some(root => root.id === conversation.thread!.rootMessageId && root.participantId === identityId)
    || conversation.messages.some(previous => previous.participantId === identityId && previous.sequence < message.sequence)
  )) return "thread-reply";
}
