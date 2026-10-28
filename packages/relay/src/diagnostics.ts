/** Diagnostic observations only. These records are never lifecycle authority. */
export const DIAGNOSTIC_ACTIONS = ["start", "resume", "stop", "runtime_stop", "runtime_restart", "reconnect", "cancel_current", "replace", "replace_fresh", "bulk_start", "bulk_stop", "cleanup"] as const;
export const DIAGNOSTIC_STAGES = ["accepted", "delivery_fenced", "interrupt_requested", "interrupt_acknowledged", "turn_settled", "pause_committed", "route_detached", "session_verified", "resume_requested", "runtime_verified", "route_attached", "handoff_prepared", "activation_boundary", "launch_requested", "binding_committed", "cleanup_requested", "cleanup_recorded", "bulk_progress", "completed", "observer_lost"] as const;
export const DIAGNOSTIC_REASONS = ["not_required", "fresh_context", "unavailable", "uncertain", "observer_lost", "recording_gap", "target_changed", "already_settled", "already_requested", "suspend", "destroy"] as const;
export type DiagnosticAction = typeof DIAGNOSTIC_ACTIONS[number];
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];
export type DiagnosticOutcome = "pending" | "succeeded" | "failed" | "unknown";
export type DiagnosticRequestDisposition = "accepted" | "handler_returned" | "handler_failed" | "not_applicable";
export interface DiagnosticEvent {
  sequence: number;
  observedAt: string;
  elapsedMs: number;
  source: "agent_host" | "relay";
  stage: DiagnosticStage;
  result: "started" | "confirmed" | "failed" | "unknown" | "skipped";
  reasonCode?: DiagnosticReason;
  triggerSequence?: number;
}
export interface DiagnosticBulkProgress {
  targets: number;
  completed: number;
  started: number;
  stopped: number;
  skipped: number;
  failed: number;
  /** Lifecycle uncertainty; may overlap failed/skipped handler results. */
  unknown: number;
  childrenUnrecorded: number;
}
export const DIAGNOSTIC_TARGET_REASONS = ["already_running", "already_idle", "offline", "uncertain", "unconfigured", "new_session_required", "unavailable"] as const;
export interface DiagnosticTargetResult {
  outcome: "started" | "stopped" | "skipped" | "failed";
  reason?: typeof DIAGNOSTIC_TARGET_REASONS[number];
}
export interface DiagnosticSummary {
  operationId: string;
  conversationId: string;
  /** Agent target for individual/child records; initiating human for bulk aggregates. */
  participantIdentityId: string;
  parentOperationId?: string;
  relatedOperationId?: string;
  action: DiagnosticAction;
  requestedAt: string;
  acceptedAt: string;
  finishedAt?: string;
  /** Observation closure, not proof that an unknown operation actually finished. */
  closedAt?: string;
  outcome: DiagnosticOutcome;
  requestDisposition: DiagnosticRequestDisposition;
  lastConfirmedStage?: DiagnosticStage;
  observedAt: string;
  elapsedMs: number;
  eventsDropped: number;
  recordingGap: boolean;
  triggerSequence?: number;
  bulk?: DiagnosticBulkProgress & { childrenUnavailable?: number };
  bulkTarget?: DiagnosticTargetResult;
}
export interface DiagnosticScope {
  workspaceId: string;
  conversationId: string;
  participantIdentityId: string;
}
export interface DiagnosticTurnReference {
  /** Optional exact selection avoids mistaking a bounded lookup page for absent evidence. */
  operationId?: string;
  bindingId: string;
  generation: number;
  triggerMessageId: string;
  triggerSequence: number;
}
export interface DiagnosticCorrelations {
  sourceBinding?: { id: string; generation: number };
  targetBinding?: { id: string; generation: number };
  trigger?: { messageId: string; sequence: number };
  cleanupHistoryId?: string;
}
export interface DiagnosticRecord extends DiagnosticSummary {
  workspaceId: string;
  recorderEpoch: string;
  revision: number;
  lastSequence: number;
  correlations?: DiagnosticCorrelations;
  events: DiagnosticEvent[];
}
export interface DiagnosticHistory {
  operations: DiagnosticSummary[];
  nextCursor?: string;
  coverage: "available" | "unavailable";
  recordingGap: boolean;
  retention: { days: number; terminalLimit: number; eventLimit: number };
}
export interface DiagnosticDetail {
  operation: DiagnosticSummary;
  events: DiagnosticEvent[];
  /** Installation-wide evidence loss can affect coverage beyond this operation. */
  recordingGap?: boolean;
}
export interface DiagnosticObservation {
  correlate(correlations: DiagnosticCorrelations): void;
  event(stage: DiagnosticStage, result: DiagnosticEvent["result"], options?: {
    source?: DiagnosticEvent["source"];
    reasonCode?: DiagnosticReason;
    triggerSequence?: number;
  }): void;
  finish(outcome: Exclude<DiagnosticOutcome, "pending">): void;
}
/** Observation adapters must never participate in lifecycle success or failure. */
export function safeDiagnosticObservation(observation: DiagnosticObservation | undefined): DiagnosticObservation | undefined {
  if (!observation) return undefined;
  let closed = false;
  return {
    event(...args) { if (!closed) { try { observation.event(...args); } catch { /* best effort */ } } },
    correlate(...args) { if (!closed) { try { observation.correlate(...args); } catch { /* best effort */ } } },
    finish(outcome) { if (!closed) { closed = true; try { observation.finish(outcome); } catch { /* best effort */ } } },
  };
}
export const DIAGNOSTIC_LIMITS = {
  days: 7, terminal: 1_000, events: 128, tracked: 128, page: 50,
  snapshotBytes: 128 * 1024, reportBytes: 64 * 1024,
} as const;

/** Strict allowlist reconstruction at the worker/storage boundary, including persisted reads. */
export function diagnosticRecord(input: unknown): DiagnosticRecord {
  if (!input || typeof input !== "object") throw new Error("Invalid diagnostic record");
  const value = input as Record<string, unknown>;
  const id = (v: unknown): string => {
    if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(v)) throw new Error("Invalid diagnostic scope");
    return v;
  };
  const time = (v: unknown): string => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new Error("Invalid diagnostic time");
    return v;
  };
  const number = (v: unknown, minimum = 0): number => {
    if (!Number.isSafeInteger(v) || (v as number) < minimum) throw new Error("Invalid diagnostic counter");
    return v as number;
  };
  const member = <T extends string>(v: unknown, allowed: readonly T[]): T => {
    if (!allowed.includes(v as T)) throw new Error("Invalid diagnostic enum");
    return v as T;
  };
  if (typeof value.recordingGap !== "boolean" || !Array.isArray(value.events) || value.events.length > DIAGNOSTIC_LIMITS.events) throw new Error("Invalid diagnostic coverage");
  const events: DiagnosticEvent[] = value.events.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid diagnostic event");
    const event = raw as Record<string, unknown>;
    return {
      sequence: number(event.sequence, 1), observedAt: time(event.observedAt), elapsedMs: number(event.elapsedMs),
      source: member(event.source, ["agent_host", "relay"]), stage: member(event.stage, DIAGNOSTIC_STAGES),
      result: member(event.result, ["started", "confirmed", "failed", "unknown", "skipped"]),
      ...(event.reasonCode === undefined ? {} : { reasonCode: member(event.reasonCode, DIAGNOSTIC_REASONS) }),
      ...(event.triggerSequence === undefined ? {} : { triggerSequence: number(event.triggerSequence) }),
    };
  });
  const lastSequence = number(value.lastSequence, 1);
  if (events.some((event, index) => event.sequence > lastSequence || (index > 0 && event.sequence <= events[index - 1]!.sequence))) throw new Error("Invalid diagnostic sequence");
  let correlations: DiagnosticCorrelations | undefined;
  if (value.correlations !== undefined) {
    if (!value.correlations || typeof value.correlations !== "object") throw new Error("Invalid diagnostic correlations");
    const privateValue = value.correlations as Record<string, unknown>;
    const binding = (raw: unknown) => {
      if (!raw || typeof raw !== "object") throw new Error("Invalid diagnostic binding");
      const ref = raw as Record<string, unknown>;
      return { id: id(ref.id), generation: number(ref.generation, 1) };
    };
    let trigger: DiagnosticCorrelations["trigger"];
    if (privateValue.trigger !== undefined) {
      if (!privateValue.trigger || typeof privateValue.trigger !== "object") throw new Error("Invalid diagnostic trigger");
      const ref = privateValue.trigger as Record<string, unknown>;
      trigger = { messageId: id(ref.messageId), sequence: number(ref.sequence, 1) };
    }
    correlations = {
      ...(privateValue.sourceBinding === undefined ? {} : { sourceBinding: binding(privateValue.sourceBinding) }),
      ...(privateValue.targetBinding === undefined ? {} : { targetBinding: binding(privateValue.targetBinding) }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(privateValue.cleanupHistoryId === undefined ? {} : { cleanupHistoryId: id(privateValue.cleanupHistoryId) }),
    };
  }
  const outcome = member(value.outcome, ["pending", "succeeded", "failed", "unknown"]);
  if (outcome === "pending" && (value.closedAt !== undefined || value.finishedAt !== undefined)) throw new Error("Invalid pending diagnostic");
  if (outcome !== "pending" && value.closedAt === undefined) throw new Error("Invalid closed diagnostic");
  if ((outcome === "succeeded" || outcome === "failed") && value.finishedAt === undefined) throw new Error("Confirmed terminal diagnostic requires a finish observation");
  if (outcome === "unknown" && value.finishedAt !== undefined) throw new Error("Unknown diagnostic cannot assert a finish time");
  let bulk: DiagnosticBulkProgress | undefined;
  if (value.bulk !== undefined) {
    if (!value.bulk || typeof value.bulk !== "object" || !["bulk_start", "bulk_stop"].includes(String(value.action))) throw new Error("Invalid diagnostic bulk");
    const raw = value.bulk as Record<string, unknown>;
    bulk = { targets: number(raw.targets), completed: number(raw.completed), started: number(raw.started), stopped: number(raw.stopped),
      skipped: number(raw.skipped), failed: number(raw.failed), unknown: number(raw.unknown), childrenUnrecorded: number(raw.childrenUnrecorded) };
    if (bulk.completed > bulk.targets || bulk.started + bulk.stopped + bulk.skipped + bulk.failed !== bulk.completed
      || bulk.unknown > bulk.completed || bulk.childrenUnrecorded > bulk.completed
      || (value.action === "bulk_start" && bulk.stopped !== 0) || (value.action === "bulk_stop" && bulk.started !== 0)
      || ((outcome === "succeeded" || outcome === "failed") && bulk.completed !== bulk.targets)
      || (outcome === "succeeded" && (bulk.unknown !== 0 || bulk.failed !== 0))) throw new Error("Invalid diagnostic bulk totals");
  }
  let bulkTarget: DiagnosticTargetResult | undefined;
  if (value.bulkTarget !== undefined) {
    if (!value.bulkTarget || typeof value.bulkTarget !== "object" || value.parentOperationId === undefined || bulk !== undefined
      || !["start", "resume", "stop"].includes(String(value.action))) throw new Error("Invalid diagnostic bulk target");
    const raw = value.bulkTarget as Record<string, unknown>;
    bulkTarget = { outcome: member(raw.outcome, ["started", "stopped", "skipped", "failed"]),
      ...(raw.reason === undefined ? {} : { reason: member(raw.reason, DIAGNOSTIC_TARGET_REASONS) }) };
    if ((bulkTarget.outcome === "started" && value.action === "stop") || (bulkTarget.outcome === "stopped" && value.action !== "stop")) throw new Error("Invalid diagnostic target action");
  }
  return {
    operationId: id(value.operationId), workspaceId: id(value.workspaceId), conversationId: id(value.conversationId),
    participantIdentityId: id(value.participantIdentityId), recorderEpoch: id(value.recorderEpoch),
    ...(value.parentOperationId === undefined ? {} : { parentOperationId: id(value.parentOperationId) }),
    ...(value.relatedOperationId === undefined ? {} : { relatedOperationId: id(value.relatedOperationId) }),
    action: member(value.action, DIAGNOSTIC_ACTIONS), requestedAt: time(value.requestedAt), acceptedAt: time(value.acceptedAt),
    ...(value.finishedAt === undefined ? {} : { finishedAt: time(value.finishedAt) }),
    ...(value.closedAt === undefined ? {} : { closedAt: time(value.closedAt) }),
    outcome, requestDisposition: member(value.requestDisposition, ["accepted", "handler_returned", "handler_failed", "not_applicable"]),
    observedAt: time(value.observedAt), elapsedMs: number(value.elapsedMs),
    ...(value.lastConfirmedStage === undefined ? {} : { lastConfirmedStage: member(value.lastConfirmedStage, DIAGNOSTIC_STAGES) }),
    revision: number(value.revision, 1), lastSequence, eventsDropped: number(value.eventsDropped), recordingGap: value.recordingGap,
    ...(correlations === undefined ? {} : { correlations }), ...(bulk === undefined ? {} : { bulk }),
    ...(bulkTarget === undefined ? {} : { bulkTarget }), events,
  };
}

/** Explicit allowlist projection: never spread a private record into a response. */
export function diagnosticSummary(record: DiagnosticRecord): DiagnosticSummary {
  return {
    operationId: record.operationId, conversationId: record.conversationId,
    participantIdentityId: record.participantIdentityId, parentOperationId: record.parentOperationId,
    relatedOperationId: record.relatedOperationId, action: record.action,
    requestedAt: record.requestedAt, acceptedAt: record.acceptedAt, finishedAt: record.finishedAt,
    closedAt: record.closedAt, outcome: record.outcome, requestDisposition: record.requestDisposition,
    lastConfirmedStage: record.lastConfirmedStage,
    observedAt: record.observedAt, elapsedMs: record.elapsedMs,
    eventsDropped: record.eventsDropped, recordingGap: record.recordingGap,
    triggerSequence: record.correlations?.trigger?.sequence,
    ...(record.bulk === undefined ? {} : { bulk: {
      targets: record.bulk.targets, completed: record.bulk.completed, started: record.bulk.started, stopped: record.bulk.stopped,
      skipped: record.bulk.skipped, failed: record.bulk.failed, unknown: record.bulk.unknown, childrenUnrecorded: record.bulk.childrenUnrecorded,
    } }),
    ...(record.bulkTarget === undefined ? {} : { bulkTarget: { outcome: record.bulkTarget.outcome,
      ...(record.bulkTarget.reason === undefined ? {} : { reason: record.bulkTarget.reason }) } }),
  };
}
