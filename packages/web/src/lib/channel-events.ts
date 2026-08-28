import type { ChannelEvent } from "@minu/channels-core/types";

export type ChannelCacheAction =
  | { type: "merge-message"; message: Extract<ChannelEvent, { type: "message.created" }>["message"] }
  | { type: "refresh-metadata"; rosterRevision: number }
  | { type: "ignore" };

export function channelCacheAction(
  event: ChannelEvent,
  currentRosterRevision: number | undefined,
): ChannelCacheAction {
  if (event.type === "message.created") {
    return { type: "merge-message", message: event.message };
  }
  if (currentRosterRevision === undefined || event.rosterRevision > currentRosterRevision) {
    return { type: "refresh-metadata", rosterRevision: event.rosterRevision };
  }
  return { type: "ignore" };
}
