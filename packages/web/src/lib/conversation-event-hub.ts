import type { ConversationEvent } from "@minu/channels-core/types";

export const MAX_LIVE_CONVERSATIONS = 100;
export const RECENT_CONVERSATION_GRACE_MS = 5 * 60_000;

export type EventHubMessage =
  | { type: "connecting" | "ready" | "disconnected" | "polling" | "paused" }
  | { type: "event"; event: ConversationEvent };
export interface EventStreamOptions {
  signal: AbortSignal;
  onReady(): void;
}
export interface EventSubscriptionOptions {
  mode?: "active" | "recent" | "observe" | "suspended";
  parentId?: string;
  suspendedIds?: readonly string[];
}
interface Subscriber extends EventSubscriptionOptions {
  ids: Set<string>;
  send(message: EventHubMessage): void;
  state?: Exclude<EventHubMessage["type"], "event">;
}

/** One bounded physical stream across tabs. Only viewed/recent topics consume slots. */
export class ConversationEventHub {
  private subscribers = new Map<object, Subscriber>();
  private recent = new Map<string, { lastUsed: number; parentId?: string }>();
  private selected: string[] = [];
  private expiry?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private running = false;
  private ready = false;
  private permanentFailure = false;
  private revision = 0;
  private wake?: () => void;

  constructor(private events: (ids: string[], options: EventStreamOptions) => AsyncIterable<ConversationEvent>) {}

  subscribe(key: object, ids: readonly string[], send: (message: EventHubMessage) => void, options: EventSubscriptionOptions = {}) {
    this.subscribers.set(key, { ...options, ids: new Set(ids), send });
    if (!options.mode || options.mode === "active" || options.mode === "recent") {
      for (const id of ids) this.recent.set(id, { lastUsed: Date.now(), parentId: options.parentId });
    }
    this.update();
  }

  unsubscribe(key: object) {
    const subscriber = this.subscribers.get(key);
    if (subscriber && (!subscriber.mode || subscriber.mode === "active")) {
      for (const id of subscriber.ids) {
        const recent = this.recent.get(id);
        if (recent) recent.lastUsed = Date.now();
      }
    }
    this.subscribers.delete(key);
    this.update();
  }

  private suspended() {
    const ids = new Set<string>();
    for (const subscriber of this.subscribers.values()) {
      for (const id of subscriber.suspendedIds ?? []) ids.add(id);
      if (subscriber.mode === "suspended") {
        for (const id of subscriber.ids) ids.add(id);
        if (subscriber.parentId) ids.add(subscriber.parentId);
      }
    }
    return ids;
  }

  private update() {
    clearTimeout(this.expiry);
    this.expiry = undefined;
    const now = Date.now();
    const suspended = this.suspended();
    const active = new Set<string>();
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.mode && subscriber.mode !== "active") continue;
      for (const id of subscriber.ids) {
        if (suspended.has(id) || (subscriber.parentId && suspended.has(subscriber.parentId))) continue;
        active.add(id);
        if (!this.recent.has(id)) this.recent.set(id, { lastUsed: now, parentId: subscriber.parentId });
      }
    }
    for (const [id, recent] of this.recent) {
      if (!this.subscribers.size || suspended.has(id) || (recent.parentId && suspended.has(recent.parentId))
        || (!active.has(id) && now - recent.lastUsed >= RECENT_CONVERSATION_GRACE_MS)) this.recent.delete(id);
    }
    const candidates = [...this.recent.keys()].sort((a, b) =>
      Number(active.has(b)) - Number(active.has(a))
      || this.recent.get(b)!.lastUsed - this.recent.get(a)!.lastUsed
      || a.localeCompare(b));
    const selected = candidates.slice(0, MAX_LIVE_CONVERSATIONS).sort();
    // Capacity eviction is final for inactive topics; a view must activate them again.
    for (const id of candidates.slice(MAX_LIVE_CONVERSATIONS)) if (!active.has(id)) this.recent.delete(id);
    const nextExpiry = [...this.recent].filter(([id]) => !active.has(id))
      .map(([, recent]) => recent.lastUsed + RECENT_CONVERSATION_GRACE_MS);
    if (nextExpiry.length) this.expiry = setTimeout(() => this.update(), Math.max(1, Math.min(...nextExpiry) - now));
    if (selected.join("\0") !== this.selected.join("\0")) {
      this.selected = selected;
      this.revision++;
      this.ready = false;
      this.permanentFailure = false;
      this.controller?.abort();
      this.wake?.();
    }
    this.status();
    this.start();
  }

  private status(disconnected = false) {
    const suspended = this.suspended();
    for (const subscriber of this.subscribers.values()) {
      const blocked = subscriber.mode === "suspended" || [...subscriber.ids].some((id) => suspended.has(id))
        || Boolean(subscriber.parentId && suspended.has(subscriber.parentId));
      const selected = [...subscriber.ids].some((id) => this.selected.includes(id));
      const state: Subscriber["state"] = blocked && subscriber.mode !== "observe" ? "paused"
        : subscriber.mode !== "observe" && !selected ? subscriber.mode === "recent" ? "paused" : "polling"
        : this.permanentFailure ? "polling"
        : !this.selected.length || this.ready ? "ready"
        : disconnected ? "disconnected" : "connecting";
      if (subscriber.state !== state) {
        subscriber.state = state;
        subscriber.send({ type: state });
      }
    }
  }

  private start() {
    if (this.running || !this.selected.length || this.permanentFailure) return;
    this.running = true;
    // Coalesce subscriptions registered in the same turn.
    void Promise.resolve().then(() => this.run());
  }

  private async run() {
    let failures = 0;
    try {
      while (this.selected.length && !this.permanentFailure) {
        const revision = this.revision;
        const controller = new AbortController();
        this.controller = controller;
        const handshake = setTimeout(() => controller.abort(), 10_000);
        this.status();
        try {
          for await (const event of this.events([...this.selected], {
            signal: controller.signal,
            onReady: () => {
              if (controller.signal.aborted) return;
              clearTimeout(handshake);
              this.ready = true;
              failures = 0;
              this.status();
            },
          })) {
            if (controller.signal.aborted) break;
            for (const subscriber of this.subscribers.values()) {
              if (subscriber.state !== "paused" && subscriber.state !== "polling"
                && subscriber.ids.has(event.conversationId)) subscriber.send({ type: "event", event });
            }
          }
        } catch (error) {
          // An unchanged invalid/unauthorized request won't heal through backoff.
          // Keep private error details in the worker; use snapshot fallback instead.
          const status = (error as { status?: number } | null)?.status;
          if (!controller.signal.aborted && status !== undefined && [400, 401, 403, 404].includes(status)) this.permanentFailure = true;
        } finally {
          clearTimeout(handshake);
          this.ready = false;
          this.controller = undefined;
        }
        if (revision !== this.revision) continue;
        this.status(true);
        if (!this.selected.length || this.permanentFailure) break;
        const delay = Math.min(1_000 * 2 ** failures++, 10_000);
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
          const timer = setTimeout(finish, delay);
          this.wake = finish;
        });
      }
    } finally {
      this.running = false;
      // A subscriber can arrive while the final stream's cancellation settles.
      this.start();
    }
  }
}
