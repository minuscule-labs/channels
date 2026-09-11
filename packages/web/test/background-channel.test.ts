import type { ChannelEvent, ChannelMessage } from "@minu/channels-core/types";
import { describe, expect, it } from "vitest";
import { runBackgroundChannelsConnection } from "../src/lib/background-channel";
import { mergeMessages } from "../src/lib/messages";

const message = (sequence: number, channelId = "channel-a"): ChannelMessage => ({
  id: `${channelId}-message-${sequence}`,
  channelId,
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
  await runBackgroundChannelsConnection({
    signal: controller.signal,
    channels: [{
      channelId: "channel-a",
      currentMessages: () => cached,
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
    }],
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

  it("routes one shared stream to independent Channel state", async () => {
    const live: string[] = [];
    const caughtUp: string[] = [];
    await runBackgroundChannelsConnection({
      signal: new AbortController().signal,
      channels: ["channel-a", "channel-b"].map((channelId) => ({
        channelId,
        currentMessages: () => [],
        listMessages: async () => [message(1, channelId)],
        onLiveMessage: (next: ChannelMessage) => live.push(next.id),
        onCatchUpMessage: (next: ChannelMessage) => caughtUp.push(next.id),
        onRosterUpdated: () => undefined,
      })),
      events: async function* ({ onReady }) {
        onReady();
        yield {
          id: "live-b",
          type: "message.created",
          channelId: "channel-b",
          message: message(2, "channel-b"),
          createdAt: new Date().toISOString(),
        } satisfies ChannelEvent;
      },
    });
    expect(live).toEqual(["channel-b-message-2"]);
    expect(caughtUp).toEqual(["channel-a-message-1", "channel-b-message-1"]);
  });

  it("aborts the shared stream when catch-up fails", async () => {
    let streamAborted = false;
    await expect(runBackgroundChannelsConnection({
      signal: new AbortController().signal,
      channels: [{
        channelId: "channel-a",
        currentMessages: () => [],
        listMessages: async () => { throw new Error("catch-up failed"); },
        onLiveMessage: () => undefined,
        onCatchUpMessage: () => undefined,
        onRosterUpdated: () => undefined,
      }],
      events: async function* ({ signal, onReady }) {
        onReady();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          streamAborted = true;
          resolve();
        }, { once: true }));
      },
    })).rejects.toThrow("catch-up failed");
    expect(streamAborted).toBe(true);
  });

  it("rejects a stream that closes before readiness", async () => {
    await expect(runBackgroundChannelsConnection({
      signal: new AbortController().signal,
      channels: [{
        channelId: "channel-a",
        currentMessages: () => [],
        listMessages: async () => [],
        onLiveMessage: () => undefined,
        onCatchUpMessage: () => undefined,
        onRosterUpdated: () => undefined,
      }],
      events: async function* () { return; },
    })).rejects.toThrow("before readiness");
  });
});
