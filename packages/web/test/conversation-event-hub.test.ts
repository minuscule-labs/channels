import type { ConversationEvent } from "@minu/channels-core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationEventHub, RECENT_CONVERSATION_GRACE_MS, type EventHubMessage, type EventStreamOptions } from "../src/lib/conversation-event-hub";

afterEach(() => vi.useRealTimers());

function harness(autoReady = true) {
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
    if (autoReady) options.onReady();
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
  it("coalesces topic changes during a handshake without cancelling before headers arrive", async () => {
    const h = harness(false);
    const a = {}, b = {};
    const received: EventHubMessage[] = [];
    h.hub.subscribe(a, ["channel"], (message) => received.push(message));
    await vi.waitFor(() => expect(h.streams).toHaveLength(1));
    h.hub.subscribe(b, ["thread"], (message) => received.push(message), { parentId: "channel" });
    expect(h.streams[0]!.options.signal.aborted).toBe(false);
    expect(h.streams).toHaveLength(1);
    h.streams[0]!.options.onReady();
    await vi.waitFor(() => expect(h.streams).toHaveLength(2));
    expect(h.streams[0]!.options.signal.aborted).toBe(true);
    expect(received.some(({ type }) => type === "ready")).toBe(false);
    expect(h.streams[1]!.ids).toEqual(["channel", "thread"]);
    h.streams[1]!.options.onReady();
    expect(received.filter(({ type }) => type === "ready")).toHaveLength(2);
    h.hub.unsubscribe(a);
    h.hub.unsubscribe(b);
    await vi.waitFor(() => expect(h.active()).toBe(0));
    expect(h.peak()).toBe(1);
  });

  it("retires a pending handshake on readiness when its final consumer has left", async () => {
    const h = harness(false);
    const view = {};
    const received: EventHubMessage[] = [];
    h.hub.subscribe(view, ["channel"], (message) => received.push(message));
    await vi.waitFor(() => expect(h.streams).toHaveLength(1));
    h.hub.unsubscribe(view);
    expect(h.streams[0]!.options.signal.aborted).toBe(false);
    h.streams[0]!.options.onReady();
    await vi.waitFor(() => expect(h.active()).toBe(0));
    expect(h.streams).toHaveLength(1);
    expect(received.some(({ type }) => type === "ready")).toBe(false);
  });

  it("still bounds a pending handshake after its final consumer leaves", async () => {
    vi.useFakeTimers();
    const h = harness(false);
    const view = {};
    h.hub.subscribe(view, ["channel"], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.hub.unsubscribe(view);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.active()).toBe(0);
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.options.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not apply an obsolete handshake rejection to replacement topics", async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    let calls = 0;
    const hub = new ConversationEventHub(async function* (_ids, options) {
      if (++calls === 1) await first;
      options.onReady();
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const a = {}, b = {};
    const received: EventHubMessage[] = [];
    hub.subscribe(a, ["a"], () => undefined);
    await vi.waitFor(() => expect(calls).toBe(1));
    hub.subscribe(b, ["b"], (message) => received.push(message));
    rejectFirst(Object.assign(new Error("old request rejected"), { status: 400 }));
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(received.at(-1)).toEqual({ type: "ready" });
    hub.unsubscribe(a);
    hub.unsubscribe(b);
  });

  it("retains recent topics across a zero-port navigation handoff without an orphan stream", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = {}, next = {};
    h.hub.subscribe(first, ["previous"], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.hub.unsubscribe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.active()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.hub.subscribe(next, ["current"], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams.at(-1)!.ids).toEqual(["current", "previous"]);
    await vi.advanceTimersByTimeAsync(RECENT_CONVERSATION_GRACE_MS);
    expect(h.streams.at(-1)!.ids).toEqual(["current"]);
    h.hub.unsubscribe(next);
    await vi.advanceTimersByTimeAsync(RECENT_CONVERSATION_GRACE_MS);
    expect(h.active()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.hub.subscribe(next, ["new"], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams.at(-1)!.ids).toEqual(["new"]);
    h.hub.unsubscribe(next);
    await vi.advanceTimersByTimeAsync(0);
  });
  it("does not subscribe to remembered background conversations", async () => {
    const h = harness();
    const observer = {};
    const ids = Array.from({ length: 101 }, (_, i) => `conversation-${i}`);
    h.hub.subscribe(observer, ids, () => undefined, { mode: "observe" });
    await Promise.resolve();
    expect(h.streams).toHaveLength(0);
    const view = {};
    h.hub.subscribe(view, [ids[100]!], () => undefined);
    await vi.waitFor(() => expect(h.streams).toHaveLength(1));
    expect(h.streams[0]!.ids).toEqual([ids[100]]);
    h.hub.unsubscribe(view);
    h.hub.unsubscribe(observer);
    await vi.waitFor(() => expect(h.active()).toBe(0));
  });

  it("retains a departed view for five minutes, expires it, and catches readiness on reopening", async () => {
    vi.useFakeTimers();
    const h = harness();
    const observer = {}, view = {};
    const received: EventHubMessage[] = [];
    h.hub.subscribe(observer, ["a"], (message) => received.push(message), { mode: "observe" });
    h.hub.subscribe(view, ["a"], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.hub.unsubscribe(view);
    await vi.advanceTimersByTimeAsync(RECENT_CONVERSATION_GRACE_MS - 1);
    expect(h.active()).toBe(1);
    h.streams[0]!.emit(event("a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toContainEqual({ type: "event", event: event("a") });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.active()).toBe(0);
    const reopened: EventHubMessage[] = [];
    h.hub.subscribe(view, ["a"], (message) => reopened.push(message));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams).toHaveLength(2);
    expect(reopened).toContainEqual({ type: "ready" });
    h.hub.unsubscribe(view);
    h.hub.unsubscribe(observer);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("evicts the oldest inactive topic when an open thread would be number 101", async () => {
    vi.useFakeTimers();
    const h = harness();
    const observer = {}, recentViews = {}, channel = {}, thread = {};
    const recentIds = Array.from({ length: 99 }, (_, i) => `recent-${String(i).padStart(3, "0")}`);
    h.hub.subscribe(observer, recentIds, () => undefined, { mode: "observe" });
    h.hub.subscribe(recentViews, recentIds, () => undefined, { mode: "recent" });
    h.hub.subscribe(channel, ["channel"], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams.at(-1)!.ids).toHaveLength(100);
    await vi.advanceTimersByTimeAsync(1);
    h.hub.subscribe(thread, ["thread"], () => undefined, { parentId: "channel" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams.at(-1)!.ids).toHaveLength(100);
    expect(h.streams.at(-1)!.ids).toEqual(expect.arrayContaining(["channel", "thread"]));
    expect(h.peak()).toBe(1);
    expect(h.streams.every(({ ids }) => ids.length <= 100)).toBe(true);
    for (const key of [observer, recentViews, channel, thread]) h.hub.unsubscribe(key);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("falls back to polling instead of creating a second stream for 101 simultaneously active topics", async () => {
    const h = harness();
    const views = Array.from({ length: 101 }, () => ({}));
    const states: EventHubMessage[][] = views.map(() => []);
    views.forEach((view, i) => h.hub.subscribe(view, [`conversation-${i}`], (message) => states[i]!.push(message)));
    await vi.waitFor(() => expect(h.streams).toHaveLength(1));
    expect(h.streams[0]!.ids).toHaveLength(100);
    expect(states.filter((messages) => messages.at(-1)?.type === "polling")).toHaveLength(1);
    const overflow = states.findIndex((messages) => messages.at(-1)?.type === "polling");
    const removed = overflow === 0 ? 1 : 0;
    h.hub.unsubscribe(views[removed]!);
    await vi.waitFor(() => expect(h.streams).toHaveLength(2));
    expect(h.streams[1]!.ids).toContain(`conversation-${overflow}`);
    expect(states[overflow]!.at(-1)?.type).toBe("ready");
    expect(h.peak()).toBe(1);
    views.forEach((view) => h.hub.unsubscribe(view));
    await vi.waitFor(() => expect(h.active()).toBe(0));
  });

  it("immediately drops a suspended parent and its open/recent threads", async () => {
    const h = harness();
    const observer = {}, parent = {}, thread = {};
    h.hub.subscribe(observer, ["parent", "thread"], () => undefined, { mode: "observe" });
    h.hub.subscribe(parent, ["parent"], () => undefined);
    const received: EventHubMessage[] = [];
    h.hub.subscribe(thread, ["thread"], (message) => received.push(message), { parentId: "parent" });
    await vi.waitFor(() => expect(h.active()).toBe(1));
    h.hub.subscribe(observer, ["parent", "thread"], () => undefined, { mode: "observe", suspendedIds: ["parent"] });
    await vi.waitFor(() => expect(h.active()).toBe(0));
    expect(received.at(-1)?.type).toBe("paused");
    h.hub.subscribe(observer, ["parent", "thread"], () => undefined, { mode: "observe" });
    await vi.waitFor(() => expect(h.active()).toBe(1));
    expect(h.streams.at(-1)!.ids).toEqual(["parent", "thread"]);
    for (const key of [observer, parent, thread]) h.hub.unsubscribe(key);
    await vi.waitFor(() => expect(h.active()).toBe(0));
  });

  it("expires a hidden view without its heartbeat extending the inactivity period", async () => {
    vi.useFakeTimers();
    const h = harness();
    const view = {};
    const received: EventHubMessage[] = [];
    h.hub.subscribe(view, ["a"], (message) => received.push(message), { mode: "recent" });
    await vi.advanceTimersByTimeAsync(RECENT_CONVERSATION_GRACE_MS);
    expect(h.active()).toBe(0);
    expect(received.at(-1)?.type).toBe("paused");
    h.hub.subscribe(view, ["a"], (message) => received.push(message));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.active()).toBe(1);
    expect(received.at(-1)?.type).toBe("ready");
    h.hub.unsubscribe(view);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not endlessly retry an unchanged permanent HTTP rejection", async () => {
    vi.useFakeTimers();
    const events = vi.fn(async function* () { throw Object.assign(new Error("private error"), { status: 400 }); yield event("a"); });
    const hub = new ConversationEventHub(events);
    const view = {};
    const received: EventHubMessage[] = [];
    hub.subscribe(view, ["a"], (message) => received.push(message));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveBeenCalledOnce();
    expect(received.at(-1)).toEqual({ type: "polling" });
    hub.unsubscribe(view);
  });
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
