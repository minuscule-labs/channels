import type { ChannelMessage, Participant } from "@minu/channels-core/types";

export function mergeMessages(
  current: ChannelMessage[] | undefined,
  incoming: ChannelMessage[],
): ChannelMessage[] {
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
  const targets: string[] = [];
  for (const match of body.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)\b/g)) {
    const handle = match[1]!.toLowerCase();
    const target = handle === "channel" ? "@channel" : byHandle.get(handle);
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
