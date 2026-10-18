import type { ConversationEvent } from "@minu/channels-core/types";
import { describe, expect, it, vi } from "vitest";
import { ConversationEventHub, type EventHubMessage, type EventStreamOptions } from "../src/lib/conversation-event-hub";

function harness() {
  let active = 0;
  let peak = 0;
  const streams: Array<{ ids: string[]; options: EventStreamOptions; emit(event?: ConversationEvent): void }> = [];
  const hub = new ConversationEventHub(async function* (ids, options) {
    active++;
    peak = Math.max(peak, active);
    const queued: Array<ConversationEvent | undefined> = [];
    let wake: (() => void) | undefined;
    const abort = () => wake?.();
    options.signal.addEventListener("abort", abort);
    streams.push({ ids, options, emit: (event) => { queued.push(event); wake?.(); } });
    options.onReady();
    try {
      while (!options.signal.aborted) {
        if (!queued.length) await new Promise<void>((resolve) => { wake = resolve; });
        if (options.signal.aborted) break;
        const event = queued.shift();
        if (!event) return;
        yield event;
      }
    } finally {
      options.signal.removeEventListener("abort", abort);
      active--;
    }
  });
  return { hub, streams, active: () => active, peak: () => peak };
}
const event = (conversationId: string): ConversationEvent => ({
  id: `event-${conversationId}`, type: "roster.updated", conversationId,
  rosterRevision: 2, createdAt: "2026-10-15T00:00:00.000Z",
});

describe("shared physical event connection", () => {
  it("unions topics, routes only subscribed events, and closes the old connection before replacement", async () => {
    const h = harness();
    const a = {}, b = {};
    const receivedA: EventHubMessage[] = [], receivedB: EventHubMessage[] = [];
    h.hub.subscribe(a, ["a"], (message) => receivedA.push(message));
    await vi.waitFor(() => expect(h.streams).toHaveLength(1));
    h.hub.subscribe(b, ["b", "a", "b"], (message) => receivedB.push(message));
    await vi.waitFor(() => expect(h.streams).toHaveLength(2));
    expect(h.streams[0]!.options.signal.aborted).toBe(true);
    expect(h.streams[1]!.ids).toEqual(["a", "b"]);
    expect(h.peak()).toBe(1);
    h.streams[1]!.emit(event("b"));
    await vi.waitFor(() => expect(receivedB).toContainEqual({ type: "event", event: event("b") }));
    expect(receivedA.filter(({ type }) => type === "event")).toEqual([]);
    h.hub.unsubscribe(a);
    expect(h.streams).toHaveLength(2);
    h.hub.unsubscribe(b);
    await vi.waitFor(() => expect(h.active()).toBe(0));
    expect(receivedA.filter(({ type }) => type === "ready")).toHaveLength(2);
  });

  it("joining an existing topic signals readiness without restarting other subscribers", async () => {
    const h = harness();
    const a = {}, b = {};
    const received: EventHubMessage[] = [];
    h.hub.subscribe(a, ["a"], () => undefined);
    await vi.waitFor(() => expect(h.streams).toHaveLength(1));
    h.hub.subscribe(b, ["a"], (message) => received.push(message));
    expect(received).toEqual([{ type: "ready" }]);
    expect(h.streams).toHaveLength(1);
    h.hub.unsubscribe(a);
    h.hub.unsubscribe(b);
    await vi.waitFor(() => expect(h.active()).toBe(0));
    h.streams[0]!.options.onReady();
    expect(received).toEqual([{ type: "ready" }]);
  });

  it("reconnects after stream closure and cancels retry when the last subscriber leaves", async () => {
    const h = harness();
    const a = {};
    const received: EventHubMessage[] = [];
    h.hub.subscribe(a, ["a"], (message) => received.push(message));
    await vi.waitFor(() => expect(h.streams).toHaveLength(1));
    h.streams[0]!.emit();
    await vi.waitFor(() => expect(received).toContainEqual({ type: "disconnected" }));
    h.hub.unsubscribe(a);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.streams).toHaveLength(1);
    expect(h.active()).toBe(0);
  });
});
