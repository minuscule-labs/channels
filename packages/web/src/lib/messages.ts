import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { hasChannelMentionCollision, mentionHandles } from "@minu/channels-core/mentions";

export function mergeMessages(
  current: ConversationMessage[] | undefined,
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map((current ?? []).map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

export function structuredTargets(body: string, participants: Participant[]): string[] {
  const byHandle = new Map(
    participants
      .filter((participant) => participant.status !== "disabled")
      .map((participant) => [(participant.handle ?? participant.id).toLowerCase(), participant.id]),
  );
  const channelMentionCollision = hasChannelMentionCollision(participants);
  const targets: string[] = [];
  for (const mention of mentionHandles(body)) {
    const handle = mention.toLowerCase();
    // Preserve direct routing for grandfathered channel handles. Disabled ones
    // must not silently turn into broadcast either; core rejects those mentions.
    const broadcast = handle === "conversation" || (handle === "channel" && !channelMentionCollision);
    const target = broadcast ? "@conversation" : byHandle.get(handle);
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

export function shortId(id: string): string {
  const typed = /^([a-z]+)_([0-9a-f]{32})$/.exec(id);
  if (typed) return `${typed[1]}_${typed[2]!.slice(0, 8)}…`;
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
