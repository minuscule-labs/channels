import type { ChannelEvent, ChannelMessage } from "@minu/channels-core/types";
import { describe, expect, it } from "vitest";
import { runBackgroundChannelConnection } from "../src/lib/background-channel";
import { mergeMessages } from "../src/lib/messages";

const message = (sequence: number): ChannelMessage => ({
  id: `message-${sequence}`,
  channelId: "channel-a",
  sequence,
  participantId: "agent-a",
  to: [],
  body: String(sequence),
  createdAt: new Date(sequence).toISOString(),
});

async function overtakingConnection(initial: ChannelMessage[], older: ChannelMessage[], liveSequence: number) {
  let cached = initial;
  const requested: number[] = [];
  const controller = new AbortController();
  const liveDelivered: number[] = [];
  const catchUpDelivered: number[] = [];
  let resolveLive!: () => void;
  const liveMerged = new Promise<void>((resolve) => { resolveLive = resolve; });
  await runBackgroundChannelConnection({
    signal: controller.signal,
    currentMessages: () => cached,
    events: async function* ({ onReady }) {
      onReady();
      yield {
        id: "live-event",
        type: "message.created",
        channelId: "channel-a",
        message: message(liveSequence),
        createdAt: new Date().toISOString(),
      } satisfies ChannelEvent;
    },
    listMessages: async ({ afterSequence }) => {
      requested.push(afterSequence);
      // Hold older history until the higher live event has overtaken it.
      await liveMerged;
      expect(cached.at(-1)?.sequence).toBe(liveSequence);
      return older;
    },
    onLiveMessage: (next) => {
      liveDelivered.push(next.sequence);
      cached = mergeMessages(cached, [next]);
      if (next.sequence === liveSequence) resolveLive();
    },
    onCatchUpMessage: (next) => {
      catchUpDelivered.push(next.sequence);
      cached = mergeMessages(cached, [next]);
    },
    onRosterUpdated: () => undefined,
  });
  return { cached, requested, liveDelivered, catchUpDelivered };
}

describe("inactive Channel catch-up ordering", () => {
  it("fences initialization before a higher live event overtakes delayed history", async () => {
    const result = await overtakingConnection([], [message(1), message(2)], 50);
    expect(result.requested).toEqual([0]);
    expect(result.cached.map(({ sequence }) => sequence)).toEqual([1, 2, 50]);
    expect(result.liveDelivered).toEqual([50]);
    expect(result.catchUpDelivered).toEqual([1, 2]);
  });

  it("fences reconnect catch-up at the pre-stream cursor", async () => {
    const result = await overtakingConnection([message(100)], [message(101), message(149)], 150);
    expect(result.requested).toEqual([100]);
    expect(result.cached.map(({ sequence }) => sequence)).toEqual([100, 101, 149, 150]);
    expect(result.liveDelivered).toEqual([150]);
    expect(result.catchUpDelivered).toEqual([101, 149]);
  });

  it("rejects a stream that closes before readiness", async () => {
    await expect(runBackgroundChannelConnection({
      signal: new AbortController().signal,
      currentMessages: () => [],
      events: async function* () { return; },
      listMessages: async () => [],
      onLiveMessage: () => undefined,
      onCatchUpMessage: () => undefined,
      onRosterUpdated: () => undefined,
    })).rejects.toThrow("before readiness");
  });
});
