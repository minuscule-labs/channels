import type { ConversationEvent } from "@minu/channels-core/types";
import type { EventHubMessage } from "./conversation-event-hub";

export interface SharedEventOptions {
  signal: AbortSignal;
  onReady(): void;
  onConnecting?(): void;
  onDisconnected?(): void;
  onPolling?(): void;
}

/** All tabs for the same origin/principal share one SSE connection, without sharing caches. */
export async function* sharedConversationEvents(
  identityId: string,
  ids: readonly string[],
  options: SharedEventOptions,
): AsyncIterable<ConversationEvent> {
  if (options.signal.aborted) return;
  options.onConnecting?.();
  let worker: SharedWorker | undefined;
  let unavailable = typeof SharedWorker === "undefined";
  let wake: (() => void) | undefined;
  let detached = false;
  let expired = false;
  const detach = () => { detached = true; wake?.(); };
  window.addEventListener("pagehide", detach, { once: true });
  const queue: ConversationEvent[] = [];
  const abort = () => wake?.();
  options.signal.addEventListener("abort", abort, { once: true });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  const fallback = () => { unavailable = true; wake?.(); };
  try {
    if (!unavailable) {
      try {
        worker = new SharedWorker(new URL("./conversation-events.worker.ts", import.meta.url), {
          type: "module", name: `channels-events-v1:${identityId}`,
        });
        worker.onerror = (event) => { event.preventDefault(); fallback(); };
        worker.port.onmessageerror = fallback;
        worker.port.onmessage = ({ data }: MessageEvent<EventHubMessage | { type: "unavailable" | "expired" }>) => {
          clearTimeout(startup);
          if (data.type === "event") {
            // The worker also bounds outstanding deliveries to suspended tabs.
            if (queue.length >= 128) { fallback(); return; }
            queue.push(data.event);
            worker!.port.postMessage({ type: "ack" });
            wake?.();
          } else if (data.type === "ready") options.onReady();
          else if (data.type === "connecting") options.onConnecting?.();
          else if (data.type === "disconnected") options.onDisconnected?.();
          else if (data.type === "expired") { expired = true; wake?.(); }
          else fallback();
        };
        worker.port.start();
        worker.port.postMessage({ type: "subscribe", ids: [...ids] });
        heartbeat = setInterval(() => worker!.port.postMessage({ type: "ping" }), 30_000);
        startup = setTimeout(fallback, 10_000);
      } catch { fallback(); }
    }
    while (!unavailable && !detached && !expired && !options.signal.aborted) {
      while (queue.length && !detached && !expired && !options.signal.aborted) yield queue.shift()!;
      if (!unavailable && !detached && !expired && !options.signal.aborted) await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(startup);
    options.signal.removeEventListener("abort", abort);
    window.removeEventListener("pagehide", detach);
    if (worker) {
      worker.port.onmessage = null;
      worker.port.postMessage({ type: "close" });
      worker.port.close();
    }
  }
  // Unsupported/blocked workers must not reopen one long-lived stream per tab.
  // Consumers reconcile snapshots on each readiness notification; fallback catch-up is silent.
  if (options.signal.aborted || detached) return;
  if (expired) throw new Error("Live update subscription expired; reconnect required");
  options.onPolling?.();
  while (!options.signal.aborted) {
    options.onConnecting?.();
    options.onReady();
    if (options.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); options.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 5_000);
      options.signal.addEventListener("abort", done, { once: true });
    });
  }
}
