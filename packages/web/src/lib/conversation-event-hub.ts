import type { ConversationEvent } from "@minu/channels-core/types";

export type EventHubMessage =
  | { type: "connecting" | "ready" | "disconnected" }
  | { type: "event"; event: ConversationEvent };
export interface EventStreamOptions {
  signal: AbortSignal;
  onReady(): void;
}

/** One physical stream for all logical subscriptions in a browser worker. No cached history. */
export class ConversationEventHub {
  private subscribers = new Map<object, { ids: Set<string>; send(message: EventHubMessage): void }>();
  private controller?: AbortController;
  private running = false;
  private ready = false;
  private revision = 0;
  private wake?: () => void;

  constructor(private events: (ids: string[], options: EventStreamOptions) => AsyncIterable<ConversationEvent>) {}

  subscribe(key: object, ids: readonly string[], send: (message: EventHubMessage) => void) {
    const before = this.topics().join("\0");
    this.subscribers.set(key, { ids: new Set(ids), send });
    if (this.topics().join("\0") !== before) this.changed();
    else send({ type: this.ready ? "ready" : "connecting" });
    if (!this.running) {
      this.running = true;
      // Coalesce subscriptions registered in the same turn.
      void Promise.resolve().then(() => this.run());
    }
  }

  unsubscribe(key: object) {
    const before = this.topics().join("\0");
    this.subscribers.delete(key);
    if (this.topics().join("\0") !== before) this.changed();
  }

  private topics() {
    return [...new Set([...this.subscribers.values()].flatMap(({ ids }) => [...ids]))].sort();
  }

  private changed() {
    this.revision++;
    this.ready = false;
    this.controller?.abort();
    this.wake?.();
  }

  private broadcast(message: EventHubMessage) {
    for (const subscriber of this.subscribers.values()) subscriber.send(message);
  }

  private async run() {
    let failures = 0;
    try {
      while (this.subscribers.size) {
        const revision = this.revision;
        const controller = new AbortController();
        this.controller = controller;
        const handshake = setTimeout(() => controller.abort(), 10_000);
        this.broadcast({ type: "connecting" });
        try {
          for await (const event of this.events(this.topics(), {
            signal: controller.signal,
            onReady: () => {
              if (controller.signal.aborted) return;
              clearTimeout(handshake);
              this.ready = true;
              failures = 0;
              this.broadcast({ type: "ready" });
            },
          })) {
            if (controller.signal.aborted) break;
            for (const subscriber of this.subscribers.values()) {
              if (subscriber.ids.has(event.conversationId)) subscriber.send({ type: "event", event });
            }
          }
        } catch {
          // Transport errors stay inside the worker; never forward private errors to other tabs.
        } finally {
          clearTimeout(handshake);
          this.ready = false;
          this.controller = undefined;
        }
        if (revision !== this.revision) continue;
        if (!this.subscribers.size) break;
        this.broadcast({ type: "disconnected" });
        const delay = Math.min(1_000 * 2 ** failures++, 10_000);
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
          const timer = setTimeout(finish, delay);
          this.wake = finish;
        });
      }
    } finally {
      this.running = false;
    }
  }
}
