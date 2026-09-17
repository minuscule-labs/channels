import type { ConversationEvent, ConversationMessage } from "@minu/channels-core/types";
import { describe, expect, it } from "vitest";
import { runBackgroundConversationsConnection } from "../src/lib/background-conversation";
import { mergeMessages } from "../src/lib/messages";

const message = (sequence: number, conversationId = "conversation-a"): ConversationMessage => ({
  id: `${conversationId}-message-${sequence}`,
  conversationId,
  sequence,
  participantId: "agent-a",
  to: [],
  body: String(sequence),
  createdAt: new Date(sequence).toISOString(),
});

async function overtakingConnection(initial: ConversationMessage[], older: ConversationMessage[], liveSequence: number) {
  let cached = initial;
  const requested: number[] = [];
  const controller = new AbortController();
  const liveDelivered: number[] = [];
  const catchUpDelivered: number[] = [];
  let resolveLive!: () => void;
  const liveMerged = new Promise<void>((resolve) => { resolveLive = resolve; });
  await runBackgroundConversationsConnection({
    signal: controller.signal,
    conversations: [{
      conversationId: "conversation-a",
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
        conversationId: "conversation-a",
        message: message(liveSequence),
        createdAt: new Date().toISOString(),
      } satisfies ConversationEvent;
    },
  });
  return { cached, requested, liveDelivered, catchUpDelivered };
}

describe("inactive Conversation catch-up ordering", () => {
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

  it("routes one shared stream to independent Conversation state", async () => {
    const live: string[] = [];
    const caughtUp: string[] = [];
    await runBackgroundConversationsConnection({
      signal: new AbortController().signal,
      conversations: ["conversation-a", "conversation-b"].map((conversationId) => ({
        conversationId,
        currentMessages: () => [],
        listMessages: async () => [message(1, conversationId)],
        onLiveMessage: (next: ConversationMessage) => live.push(next.id),
        onCatchUpMessage: (next: ConversationMessage) => caughtUp.push(next.id),
        onRosterUpdated: () => undefined,
      })),
      events: async function* ({ onReady }) {
        onReady();
        yield {
          id: "live-b",
          type: "message.created",
          conversationId: "conversation-b",
          message: message(2, "conversation-b"),
          createdAt: new Date().toISOString(),
        } satisfies ConversationEvent;
      },
    });
    expect(live).toEqual(["conversation-b-message-2"]);
    expect(caughtUp).toEqual(["conversation-a-message-1", "conversation-b-message-1"]);
  });

  it("aborts the shared stream when catch-up fails", async () => {
    let streamAborted = false;
    await expect(runBackgroundConversationsConnection({
      signal: new AbortController().signal,
      conversations: [{
        conversationId: "conversation-a",
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
    await expect(runBackgroundConversationsConnection({
      signal: new AbortController().signal,
      conversations: [{
        conversationId: "conversation-a",
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
