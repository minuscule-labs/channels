import type { LocalChannelAgent } from "@minu/channels-control/contracts";
import type { Participant } from "@minu/channels-core/types";
import { describe, expect, it } from "vitest";
import { activitySummaryItems } from "../src/components/channel-activity-strip";

const participant = (id: string, handle: string): Participant => ({
  id,
  type: "agent",
  handle,
  status: "active",
});
const agent = (
  identityId: string,
  phase: "running" | "retrying" | "canceling",
  queuedTurns: number,
): LocalChannelAgent => ({
  workspaceId: "workspace-a",
  channelId: "channel-a",
  identityId,
  state: "running",
  activity: {
    phase,
    triggerMessageId: "message-private-trigger",
    triggerSequence: 42,
    startedAt: "2026-09-10T12:00:00.000Z",
    queuedTurns,
    ...(phase === "retrying" ? { retryAttempt: 3 } : {}),
  },
  capabilities: { start: false, replace: false, stop: true, steer: false, interrupt: true, reconnect: false },
});

describe("Channel activity summary", () => {
  it("summarizes every active agent using only coarse presentation-safe state", () => {
    const items = activitySummaryItems(
      [agent("builder", "running", 2), agent("reviewer", "retrying", 0), agent("writer", "canceling", 1)],
      [participant("builder", "builder"), participant("reviewer", "reviewer"), participant("writer", "writer")],
      Date.parse("2026-09-10T12:01:02.000Z"),
    );
    expect(items).toEqual([
      "@builder is working · 1m 2s · 2 turns queued",
      "@reviewer is retrying (attempt 3) · 1m 2s",
      "@writer is canceling · 1m 2s · 1 turn queued",
    ]);
    expect(items.join(" ")).not.toMatch(/message-private-trigger|42|tool|prompt|path|error/i);
  });

  it("omits idle agents", () => {
    expect(activitySummaryItems([{ ...agent("builder", "running", 0), activity: undefined }], [], Date.now())).toEqual([]);
  });
});
