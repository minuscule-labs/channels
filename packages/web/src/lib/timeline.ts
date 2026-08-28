import type { ChannelMessage } from "@minu/channels-core/types";

export type TimelineRow =
  | { id: string; kind: "day-divider"; day: string; createdAt: string }
  | { id: string; kind: "message"; message: ChannelMessage; continuation: boolean };

const CONTINUATION_WINDOW_MS = 5 * 60 * 1_000;
export const TIMELINE_END_THRESHOLD_PX = 120;

export function isNearTimelineEnd(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = TIMELINE_END_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

function utcDay(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : createdAt;
}

function sameAudience(left: ChannelMessage, right: ChannelMessage): boolean {
  return left.to.length === right.to.length && left.to.every((target, index) => target === right.to[index]);
}

function isContinuation(previous: ChannelMessage | undefined, message: ChannelMessage): boolean {
  if (!previous || previous.participantId !== message.participantId || previous.replyTo || message.replyTo) return false;
  if (!sameAudience(previous, message)) return false;
  const elapsed = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= CONTINUATION_WINDOW_MS;
}

export function projectTimeline(messages: ChannelMessage[]): TimelineRow[] {
  const ordered = [...messages].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const rows: TimelineRow[] = [];
  let previous: ChannelMessage | undefined;
  let previousDay: string | undefined;

  for (const message of ordered) {
    const day = utcDay(message.createdAt);
    if (day !== previousDay) {
      rows.push({ id: `day:${day}`, kind: "day-divider", day, createdAt: message.createdAt });
      previousDay = day;
      previous = undefined;
    }
    rows.push({
      id: `message:${message.id}`,
      kind: "message",
      message,
      continuation: isContinuation(previous, message),
    });
    previous = message;
  }

  return rows;
}
