import type { ConversationMessage } from "@minu/channels-core/types";

export type NotificationSound = "off" | "mentions" | "all";
export interface ConversationUnread { count: number; mentionCount: number; }

const key = (identityId: string, conversationId: string) => `minu-channels:last-read:${identityId}:${conversationId}`;
const soundKey = (identityId: string) => `minu-channels:sound:${identityId}`;

export function readSequence(storage: Pick<Storage, "getItem">, identityId: string, conversationId: string): number {
  const value = Number(storage.getItem(key(identityId, conversationId)) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function writeReadSequence(
  storage: Pick<Storage, "getItem" | "setItem">,
  identityId: string,
  conversationId: string,
  sequence: number,
) {
  storage.setItem(key(identityId, conversationId), String(Math.max(readSequence(storage, identityId, conversationId), sequence, 0)));
}

export function resetReadSequence(storage: Pick<Storage, "setItem">, identityId: string, conversationId: string) {
  storage.setItem(key(identityId, conversationId), "0");
}

export function unreadFor(messages: ConversationMessage[], identityId: string, lastRead: number): ConversationUnread {
  const latest = messages.at(-1)?.sequence ?? 0;
  const floor = lastRead > latest ? 0 : lastRead;
  const seenSequences = new Set<number>();
  const unread = messages.filter((message) => {
    if (seenSequences.has(message.sequence)) return false;
    seenSequences.add(message.sequence);
    return message.sequence > floor && message.participantId !== identityId;
  });
  return {
    count: unread.length,
    mentionCount: unread.filter((message) => message.to.includes(identityId)).length,
  };
}

export function readSound(storage: Pick<Storage, "getItem">, identityId: string): NotificationSound {
  const value = storage.getItem(soundKey(identityId));
  return value === "mentions" || value === "all" ? value : "off";
}

export function writeSound(storage: Pick<Storage, "setItem">, identityId: string, value: NotificationSound) {
  storage.setItem(soundKey(identityId), value);
}
