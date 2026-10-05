import type { Participant } from "./types.ts";

/** Read the whole permitted handle; a word boundary would truncate trailing hyphens. */
export function mentionHandles(body: string): string[] {
  return [...body.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)].map((match) => match[1]!);
}

/** Both the visible broadcast name and its legacy spelling are protected. */
export function isReservedMentionHandle(handle: string): boolean {
  const normalized = handle.toLowerCase();
  return normalized === "channel" || normalized === "conversation";
}

/** Existing handles retain direct routing until an administrator renames them. */
export function hasChannelMentionCollision(participants: readonly Pick<Participant, "id" | "handle">[]): boolean {
  return participants.some((participant) => participant.id.toLowerCase() === "channel"
    || participant.handle?.toLowerCase() === "channel");
}
