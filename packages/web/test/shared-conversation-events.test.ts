import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedConversationEvents } from "../src/lib/shared-conversation-events";

class WorkerMock {
  static instances: WorkerMock[] = [];
  onerror?: (event: Event) => void;
  sent: unknown[] = [];
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage: (data: unknown) => this.sent.push(data),
    start: vi.fn(), close: vi.fn(),
  };
  constructor(readonly url: URL, readonly options: { name: string }) { WorkerMock.instances.push(this); }
  emit(data: unknown) { this.port.onmessage?.({ data }); }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); WorkerMock.instances = []; });

describe("browser shared event subscription", () => {
  it("downgrades a hidden view to recent interest and restores foreground priority on visibility", async () => {
    vi.stubGlobal("window", new EventTarget());
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", document);
    vi.stubGlobal("SharedWorker", WorkerMock);
    const controller = new AbortController();
    const pending = sharedConversationEvents("owner", ["thread"], {
      signal: controller.signal, onReady: vi.fn(), parentId: "parent",
    })[Symbol.asyncIterator]().next();
    const worker = WorkerMock.instances[0]!;
    expect(worker.sent.at(-1)).toMatchObject({ mode: "active", parentId: "parent" });
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(worker.sent.at(-1)).toMatchObject({ mode: "recent" });
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(worker.sent.at(-1)).toMatchObject({ mode: "active" });
    controller.abort();
    await pending;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(worker.sent.at(-1)).toEqual({ type: "close" });
  });

  it("polls an overflow view, stops on pause, and reconciles when promoted back to live", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("SharedWorker", WorkerMock);
    const controller = new AbortController();
    const ready = vi.fn(), polling = vi.fn(), paused = vi.fn(), live = vi.fn(), connecting = vi.fn();
    const pending = sharedConversationEvents("owner", ["a"], {
      signal: controller.signal, onReady: ready, onPolling: polling, onPaused: paused, onLive: live, onConnecting: connecting,
    })[Symbol.asyncIterator]().next();
    const worker = WorkerMock.instances[0]!;
    worker.emit({ type: "polling" });
    expect(polling).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ready).toHaveBeenCalledTimes(2);
    // Initial connection plus a fresh catch-up fence for each polling snapshot.
    expect(connecting).toHaveBeenCalledTimes(3);
    worker.emit({ type: "paused" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paused).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledTimes(2);
    worker.emit({ type: "ready" });
    expect(live).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledTimes(3);
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scopes the worker by principal, handles repeated readiness, and releases its port on abort", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("SharedWorker", WorkerMock);
    const controller = new AbortController();
    const ready = vi.fn();
    const stream = sharedConversationEvents("owner-a", ["conversation-a"], { signal: controller.signal, onReady: ready });
    const pending = stream[Symbol.asyncIterator]().next();
    const worker = WorkerMock.instances[0]!;
    expect(worker.options.name).toBe("channels-events-v1:owner-a");
    expect(worker.sent).toContainEqual(expect.objectContaining({ type: "subscribe", ids: ["conversation-a"], mode: "active" }));
    worker.emit({ type: "ready" });
    worker.emit({ type: "connecting" });
    worker.emit({ type: "ready" });
    expect(ready).toHaveBeenCalledTimes(2);
    controller.abort();
    expect((await pending).done).toBe(true);
    expect(worker.sent).toContainEqual({ type: "close" });
    expect(worker.port.close).toHaveBeenCalledOnce();
  });

  it("releases a page-hidden subscription so navigation does not retain old topics", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    vi.stubGlobal("SharedWorker", WorkerMock);
    const stream = sharedConversationEvents("owner-a", ["a"], { signal: new AbortController().signal, onReady: vi.fn() });
    const pending = stream[Symbol.asyncIterator]().next();
    target.dispatchEvent(new Event("pagehide"));
    expect((await pending).done).toBe(true);
    expect(WorkerMock.instances[0]!.sent).toContainEqual({ type: "close" });
  });

  it("retries an expired suspended-tab subscription instead of permanently degrading to polling", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("SharedWorker", WorkerMock);
    const polling = vi.fn();
    const stream = sharedConversationEvents("owner", ["a"], {
      signal: new AbortController().signal, onReady: vi.fn(), onPolling: polling,
    });
    const pending = stream[Symbol.asyncIterator]().next();
    WorkerMock.instances[0]!.emit({ type: "expired" });
    await expect(pending).rejects.toThrow("reconnect required");
    expect(polling).not.toHaveBeenCalled();
    expect(WorkerMock.instances[0]!.port.close).toHaveBeenCalledOnce();
  });

  it.each(["unsupported", "error"])("falls back to abortable polling when the worker is %s", async (mode) => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("SharedWorker", mode === "unsupported" ? undefined : WorkerMock);
    const controller = new AbortController();
    const polling = vi.fn();
    const ready = vi.fn(() => controller.abort());
    const stream = sharedConversationEvents("owner", ["a"], { signal: controller.signal, onPolling: polling, onReady: ready });
    const pending = stream[Symbol.asyncIterator]().next();
    if (mode === "error") WorkerMock.instances[0]!.onerror?.(new Event("error", { cancelable: true }));
    expect((await pending).done).toBe(true);
    expect(polling).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
  });
});
