import { randomUUID } from "node:crypto";
import { DELIVERY_LIMITS, DELIVERY_OUTCOMES, deliveryEvent, deliveryRecord, deliveryScope, type DeliveryScope, type DeliveryRecord, type DeliveryObservation } from "@minu/channels-relay";

/** Independent bounded capture/dirty pools. The existing worker transport gives lifecycle writes priority. */
export class DeliveryRecorder {
  readonly dirty = new Map<string, DeliveryRecord>();
  private tracked = new Map<string, { record: DeliveryRecord; key: string; start: number; observer: DeliveryObservation }>();
  private keys = new Map<string, string>();
  recordingGap = false;
  private disabled = false;
  constructor(private epoch: string, private enabled: () => boolean, private changed: () => void,
    private now: () => Date, private monotonic: () => number) {}
  begin(input: DeliveryScope, triggerId: string, triggerSequence: number): DeliveryObservation | undefined {
    try {
      const scope = deliveryScope(input), key = JSON.stringify([scope, triggerId, triggerSequence]);
      const existing = this.tracked.get(this.keys.get(key) ?? "");
      if (existing) return existing.record.outcome === "pending" ? existing.observer : undefined;
      if (this.disabled || !this.enabled() || this.tracked.size >= DELIVERY_LIMITS.tracked) { this.recordingGap = true; return undefined; }
      const at = this.now().toISOString();
      const record = deliveryRecord({ ...scope, trailId: `trail_${randomUUID().replaceAll("-", "")}`, triggerId, triggerSequence,
        epoch: this.epoch, revision: 1, lastSequence: 0, startedAt: at, observedAt: at, outcome: "pending", eventsDropped: 0, recordingGap: false, events: [] });
      const start = this.monotonic();
      const observer: DeliveryObservation = {
        event: (stage, extra = {}) => {
          if (record.outcome !== "pending" || this.disabled || !this.enabled()) return;
          try {
            const at = this.now().toISOString(), elapsed = Math.max(record.events.at(-1)?.elapsedMs ?? 0, Math.floor(this.monotonic() - start), 0);
            const event = deliveryEvent(stage, extra, record.lastSequence + 1, at, elapsed);
            if (record.events.some(previous => previous.stage === stage && previous.kind === event.kind && previous.reason === event.reason
              && previous.attempt === event.attempt && previous.responseSequence === event.responseSequence)) return;
            const last = record.events.at(-1);
            const wasClipped = record.eventsDropped > 0;
            // Repeated waits/retries update bounded counters, not an unbounded poll/error log.
            if (last?.stage === stage && last.kind === event.kind && last.reason === event.reason) {
              if (event.attempt === undefined || event.attempt <= (last.attempt ?? 0)) return;
              last.observedAt = at; last.elapsedMs = elapsed;
              last.attempt = event.attempt;
            } else {
              record.lastSequence++;
              const final = ["response_committed", "response_reused", "cursor_committed", "dead_letter", "observer_lost"].includes(stage);
              if (record.events.length < DELIVERY_LIMITS.events - 2 || (final && record.events.length < DELIVERY_LIMITS.events)) record.events.push(event);
              else if (final) { record.events.splice(DELIVERY_LIMITS.events - 2, 1); record.events.push(event); record.eventsDropped++; record.recordingGap = true; }
              else {
                record.eventsDropped++; record.recordingGap = true;
                record.observedAt = at; record.revision++;
                // Persist the first clipping marker, then only the reserved final observations/outcome.
                if (!wasClipped) this.queue(record);
                return;
              }
            }
            record.observedAt = at; record.revision++;
            this.queue(record);
          } catch { this.recordingGap = true; record.recordingGap = true; }
        },
        finish: outcome => {
          if (record.outcome !== "pending" || this.disabled || !this.enabled()) return;
          try {
            if (outcome === ("pending" as string) || !DELIVERY_OUTCOMES.includes(outcome)) throw new Error("Invalid outcome");
            record.outcome = outcome; record.observedAt = this.now().toISOString(); record.closedAt = record.observedAt; record.revision++;
            if (outcome === "unknown") record.recordingGap = true;
            this.queue(record);
          } catch { this.recordingGap = true; }
        },
      };
      this.tracked.set(record.trailId, { record, key, start, observer }); this.keys.set(key, record.trailId);
      observer.event("eligible_observed");
      return observer;
    } catch { this.recordingGap = true; return undefined; }
  }
  private queue(record: DeliveryRecord) {
    try { deliveryRecord(record); this.dirty.set(record.trailId, record); this.changed(); }
    catch { this.recordingGap = true; }
  }
  acknowledged(id: string, revision: number) {
    const tracked = this.tracked.get(id);
    if (tracked && tracked.record.outcome !== "pending" && tracked.record.revision === revision) {
      this.tracked.delete(id); this.keys.delete(tracked.key);
    }
  }
  abandon(scope: DeliveryScope) {
    try {
      const key = JSON.stringify(deliveryScope(scope));
      for (const tracked of this.tracked.values()) if (JSON.stringify(deliveryScope(tracked.record)) === key) tracked.observer.finish("unknown");
    } catch { this.recordingGap = true; }
  }
  finishPending() { for (const tracked of this.tracked.values()) tracked.observer.finish("unknown"); }
  disable() { this.disabled = true; this.recordingGap = true; this.dirty.clear(); this.tracked.clear(); this.keys.clear(); }
}
