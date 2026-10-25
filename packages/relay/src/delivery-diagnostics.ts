/** Optional observations, never execution or delivery authority. No message/error payloads. */
export const DELIVERY_STAGES = ["eligible_observed", "processing_started", "wake_deferred", "runtime_waiting", "dispatch_requested", "runtime_reused", "runtime_accepted", "runtime_completed", "runtime_failed", "runtime_interrupted", "retrying", "delivery_requested", "delivery_retrying", "response_committed", "response_reused", "cursor_committed", "dead_letter", "observer_lost"] as const;
export type DeliveryStage = typeof DELIVERY_STAGES[number];
export const DELIVERY_OUTCOMES = ["pending", "delivered", "response_reused", "failed", "canceled", "unknown"] as const;
export type DeliveryOutcome = typeof DELIVERY_OUTCOMES[number];
export const DELIVERY_KINDS = ["reply", "failure_notice", "cancellation_notice"] as const;
export const DELIVERY_REASONS = ["delivery_rejected", "delivery_timed_out", "cursor_commit_failed"] as const;
export const DELIVERY_LIMITS = { days: 7, terminal: 1000, tracked: 128, events: 16, bytes: 8192, page: 50 } as const;
export interface DeliveryScope {
  workspaceId: string; conversationId: string; participantIdentityId: string;
  bindingId: string; generation: number; adapter: string; sessionId: string; ownerId: string;
}
export interface DeliveryEvent {
  sequence: number; stage: DeliveryStage; observedAt: string; elapsedMs: number;
  attempt?: number; kind?: typeof DELIVERY_KINDS[number]; reason?: typeof DELIVERY_REASONS[number]; responseSequence?: number;
}
export interface DeliverySummary {
  trailId: string; triggerSequence: number; startedAt: string; observedAt: string; closedAt?: string;
  outcome: DeliveryOutcome; eventsDropped: number; recordingGap: boolean;
}
export interface DeliveryDetail extends DeliverySummary { events: DeliveryEvent[] }
export interface DeliveryRecord extends DeliveryDetail, DeliveryScope {
  triggerId: string; epoch: string; revision: number; lastSequence: number;
}
export interface DeliveryHistory { trails: DeliverySummary[]; nextCursor?: string; recordingGap: boolean }
export interface DeliveryObservation {
  event(stage: DeliveryStage, extra?: Pick<DeliveryEvent, "attempt" | "kind" | "reason" | "responseSequence">): void;
  finish(outcome: Exclude<DeliveryOutcome, "pending">): void;
}
export function safeDeliveryObservation(input: DeliveryObservation | undefined): DeliveryObservation | undefined {
  if (!input) return undefined;
  let closed = false;
  return { event(stage, extra) { if (!closed) { try { input.event(stage, extra); } catch {} } },
    finish(outcome) { if (!closed) { closed = true; try { input.finish(outcome); } catch {} } } };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bad = () => new Error("Invalid delivery diagnostic");
const id = (value: unknown): string => { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw bad(); return value; };
const counter = (value: unknown, minimum = 0): number => { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw bad(); return value as number; };
const time = (value: unknown): string => { if (typeof value !== "string" || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw bad(); return value; };
const member = <T extends string>(value: unknown, choices: readonly T[]): T => { if (!choices.includes(value as T)) throw bad(); return value as T; };
export function deliveryScope(input: unknown): DeliveryScope {
  const raw = object(input);
  return { workspaceId: id(raw.workspaceId), conversationId: id(raw.conversationId), participantIdentityId: id(raw.participantIdentityId), bindingId: id(raw.bindingId), generation: counter(raw.generation), adapter: id(raw.adapter), sessionId: id(raw.sessionId), ownerId: id(raw.ownerId) };
}
export function deliveryEvent(stage: unknown, extra: unknown, sequence: number, observedAt: string, elapsedMs: number): DeliveryEvent {
  const raw = object(extra);
  return { stage: member(stage, DELIVERY_STAGES), sequence: counter(sequence, 1), observedAt: time(observedAt), elapsedMs: counter(elapsedMs),
    ...(raw.attempt === undefined ? {} : { attempt: counter(raw.attempt, 1) }),
    ...(raw.kind === undefined ? {} : { kind: member(raw.kind, DELIVERY_KINDS) }),
    ...(raw.reason === undefined ? {} : { reason: member(raw.reason, DELIVERY_REASONS) }),
    ...(raw.responseSequence === undefined ? {} : { responseSequence: counter(raw.responseSequence, 1) }) };
}
export function deliveryDetail(input: unknown): DeliveryDetail {
  const raw = object(input);
  if (typeof raw.recordingGap !== "boolean" || !Array.isArray(raw.events) || raw.events.length > DELIVERY_LIMITS.events) throw bad();
  const events = raw.events.map(value => { const event = object(value); return deliveryEvent(event.stage, event, event.sequence as number, event.observedAt as string, event.elapsedMs as number); });
  if (events.some((event, i) => i > 0 && (event.sequence <= events[i - 1]!.sequence || event.elapsedMs < events[i - 1]!.elapsedMs))) throw bad();
  const outcome = member(raw.outcome, DELIVERY_OUTCOMES);
  if ((outcome === "pending") !== (raw.closedAt === undefined)) throw bad();
  const result: DeliveryDetail = { trailId: id(raw.trailId), triggerSequence: counter(raw.triggerSequence, 1), startedAt: time(raw.startedAt), observedAt: time(raw.observedAt),
    ...(raw.closedAt === undefined ? {} : { closedAt: time(raw.closedAt) }), outcome, eventsDropped: counter(raw.eventsDropped), recordingGap: raw.recordingGap, events };
  if (JSON.stringify(result).length > DELIVERY_LIMITS.bytes || new TextEncoder().encode(JSON.stringify(result)).byteLength > DELIVERY_LIMITS.bytes) throw bad();
  return result;
}
export function deliveryRecord(input: unknown): DeliveryRecord {
  const raw = object(input), detail = deliveryDetail(input);
  const result = { ...detail, ...deliveryScope(input), triggerId: id(raw.triggerId), epoch: id(raw.epoch), revision: counter(raw.revision, 1), lastSequence: counter(raw.lastSequence) };
  if (detail.events.some(event => event.sequence > result.lastSequence) || new TextEncoder().encode(JSON.stringify(result)).byteLength > DELIVERY_LIMITS.bytes) throw bad();
  return result;
}
export function deliverySummary(input: unknown): DeliverySummary {
  const { events: _events, ...summary } = deliveryDetail(input);
  return summary;
}
