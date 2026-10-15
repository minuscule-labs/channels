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

afterEach(() => { vi.unstubAllGlobals(); WorkerMock.instances = []; });

describe("browser shared event subscription", () => {
  it("scopes the worker by principal, handles repeated readiness, and releases its port on abort", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("SharedWorker", WorkerMock);
    const controller = new AbortController();
    const ready = vi.fn();
    const stream = sharedConversationEvents("owner-a", ["conversation-a"], { signal: controller.signal, onReady: ready });
    const pending = stream[Symbol.asyncIterator]().next();
    const worker = WorkerMock.instances[0]!;
    expect(worker.options.name).toBe("channels-events-v1:owner-a");
    expect(worker.sent).toContainEqual({ type: "subscribe", ids: ["conversation-a"] });
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
