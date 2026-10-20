import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  DIAGNOSTIC_LIMITS, DIAGNOSTIC_ACTIONS, DIAGNOSTIC_STAGES, DIAGNOSTIC_REASONS, diagnosticRecord, type DiagnosticCorrelations, type DiagnosticRequestDisposition, type DiagnosticAction, type DiagnosticRecord, type DiagnosticScope,
  type DiagnosticTurnReference, type DiagnosticObservation, type DiagnosticHistory, type DiagnosticDetail, type DiagnosticBulkProgress, type DiagnosticTargetResult,
} from "@minu/channels-relay";

export interface RecordedOperation extends DiagnosticObservation {
  readonly operationId: string;
  readonly recorded: boolean;
  requestFinished(disposition: Exclude<DiagnosticRequestDisposition, "accepted">): void;
  bulkProgress(progress: DiagnosticBulkProgress): void;
  targetResult(result: DiagnosticTargetResult): void;
}
export interface DiagnosticRecorderOptions {
  path: string;
  now?: () => Date;
  monotonicNow?: () => number;
  startupTimeoutMs?: number;
  ioTimeoutMs?: number;
  workerFactory?: (url: URL, options: { workerData: { path: string; epoch: string } }) => Worker;
}
interface Tracked { record: DiagnosticRecord; start: number }
interface ReadRequest { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** All I/O is off-thread. Neither begin(), event(), nor finish() waits or throws into lifecycle work. */
export class DiagnosticRecorder {
  readonly epoch = randomUUID();
  private worker?: Worker;
  private state: "starting" | "ready" | "unavailable" | "closed" = "starting";
  private tracked = new Map<string, Tracked>();
  private dirty = new Map<string, DiagnosticRecord>();
  private writing?: { id: string; revision: number; timer: ReturnType<typeof setTimeout> };
  private reads = new Map<number, ReadRequest>();
  private requestId = 0;
  private gap = false;
  private startup?: ReturnType<typeof setTimeout>;
  private stopped?: Promise<number>;
  private closing = false;
  private readonly now: () => Date;
  private readonly monotonic: () => number;

  constructor(private options: DiagnosticRecorderOptions) {
    this.now = options.now ?? (() => new Date());
    this.monotonic = options.monotonicNow ?? (() => performance.now());
    try {
      if (typeof options.path !== "string" || options.path.length > 4096) throw new Error("Invalid diagnostic path");
      this.worker = (options.workerFactory ?? ((url, config) => new Worker(url, config)))(
        new URL("./diagnostics-worker.js", import.meta.url), { workerData: { path: options.path, epoch: this.epoch } },
      );
      this.worker.on("message", (message) => { try { this.receive(message); } catch { this.disable(); } });
      this.worker.on("error", () => this.disable());
      this.worker.on("exit", () => { if (this.state !== "closed") this.disable(); });
      this.worker.unref();
      this.startup = setTimeout(() => this.disable(), options.startupTimeoutMs ?? 5_000);
    } catch { this.disable(); }
  }

  get available() { return this.state === "ready"; }
  get recordingGap() { return this.gap; }

  begin(scope: DiagnosticScope, action: DiagnosticAction, relation: { parentOperationId?: string; relatedOperationId?: string } = {}): RecordedOperation {
    const operationId = `operation_${randomUUID().replaceAll("-", "")}`;
    const ignored: RecordedOperation = { operationId, recorded: false, requestFinished() {}, bulkProgress() {}, targetResult() {}, correlate() {}, event() {}, finish() {} };
    const owner = this;
    try {
      const validId = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(id);
      if (![scope.workspaceId, scope.conversationId, scope.participantIdentityId].every(validId)
        || !DIAGNOSTIC_ACTIONS.includes(action)
        || (relation.parentOperationId !== undefined && !validId(relation.parentOperationId))
        || (relation.relatedOperationId !== undefined && !validId(relation.relatedOperationId))) {
        this.gap = true; return ignored;
      }
      if (this.closing || (this.state !== "ready" && this.state !== "starting") || this.tracked.size >= DIAGNOSTIC_LIMITS.tracked) {
        this.gap = true;
        return ignored;
      }
      const at = this.now().toISOString();
      const record: DiagnosticRecord = {
        operationId, workspaceId: scope.workspaceId, conversationId: scope.conversationId,
        participantIdentityId: scope.participantIdentityId,
        parentOperationId: relation.parentOperationId, relatedOperationId: relation.relatedOperationId,
        action, recorderEpoch: this.epoch,
        requestedAt: at, acceptedAt: at, observedAt: at, outcome: "pending", requestDisposition: "accepted", elapsedMs: 0,
        revision: 0, lastSequence: 0, eventsDropped: 0, recordingGap: false, events: [],
      };
      const tracked = { record, start: this.monotonic() };
      this.tracked.set(operationId, tracked);
      const event: RecordedOperation["event"] = (stage, result, extra = {}) => {
        try {
          if (!this.tracked.has(operationId) || record.outcome !== "pending") return;
          if (!DIAGNOSTIC_STAGES.includes(stage) || !["started", "confirmed", "failed", "unknown", "skipped"].includes(result)
            || (extra.source !== undefined && extra.source !== "agent_host" && extra.source !== "relay")
            || (extra.reasonCode !== undefined && !DIAGNOSTIC_REASONS.includes(extra.reasonCode))
            || (extra.triggerSequence !== undefined && (!Number.isSafeInteger(extra.triggerSequence) || extra.triggerSequence < 0))) {
            this.gap = true; record.recordingGap = true; return;
          }
          const observedAt = this.now().toISOString();
          const elapsedMs = Math.floor(this.monotonic() - tracked.start);
          if (!Number.isSafeInteger(elapsedMs)) throw new Error("Diagnostic duration unavailable");
          record.observedAt = observedAt;
          record.elapsedMs = Math.max(record.elapsedMs, elapsedMs, 0);
          record.lastSequence++;
          record.revision++;
          if (result === "confirmed" && stage !== "completed") record.lastConfirmedStage = stage;
          // Reserve one slot for the terminal observation, even during excessive progress.
          if (record.events.length < DIAGNOSTIC_LIMITS.events - 1 || (stage === "completed" && record.events.length < DIAGNOSTIC_LIMITS.events)) {
            record.events.push({ sequence: record.lastSequence, observedAt: record.observedAt,
              elapsedMs: record.elapsedMs, source: extra.source ?? "agent_host", stage, result,
              ...(extra.reasonCode === undefined ? {} : { reasonCode: extra.reasonCode }),
              ...(extra.triggerSequence === undefined ? {} : { triggerSequence: extra.triggerSequence }),
            });
          } else { record.eventsDropped++; record.recordingGap = true; }
          this.queue(record);
        } catch { this.disable(); }
      };
      event("accepted", "confirmed");
      return {
        operationId,
        // Admission to best-effort recording, not a durable-commit acknowledgment.
        get recorded() { return (owner.state === "ready" || owner.state === "starting") && tracked.record.revision > 0; },
        event,
        bulkProgress: (progress) => {
          try {
            if (!this.tracked.has(operationId) || record.outcome !== "pending") return;
            const candidate = diagnosticRecord({ ...record, bulk: progress }).bulk!;
            if (record.bulk && (candidate.targets !== record.bulk.targets ||
              (["completed", "started", "stopped", "skipped", "failed", "unknown", "childrenUnrecorded"] as const).some((key) => candidate[key] < record.bulk![key]))) throw new Error("Diagnostic totals cannot regress");
            record.bulk = candidate;
            if (candidate.childrenUnrecorded) record.recordingGap = true;
            event("bulk_progress", "confirmed");
          } catch {
            this.gap = true;
            record.recordingGap = true;
            record.revision++;
            this.queue(record);
          }
        },
        targetResult: (result) => {
          try {
            if (record.bulkTarget || (this.state !== "ready" && this.state !== "starting")) return;
            const candidate = diagnosticRecord({ ...record, bulkTarget: result }).bulkTarget!;
            // The host action can already be terminal (and acknowledged by the worker).
            if (!this.tracked.has(operationId)) {
              if (this.tracked.size >= DIAGNOSTIC_LIMITS.tracked) { this.gap = true; return; }
              this.tracked.set(operationId, tracked);
            }
            record.bulkTarget = candidate;
            record.revision++;
            this.queue(record);
          } catch { this.gap = true; }
        },
        requestFinished: (disposition) => {
          try {
            if (record.requestDisposition !== "accepted" || (this.state !== "ready" && this.state !== "starting")) return;
            if (!["handler_returned", "handler_failed", "not_applicable"].includes(disposition)) return;
            // A fast Relay settlement can be persisted before its host handler returns.
            // Re-admit only the bounded final request-status snapshot; never regress outcome.
            if (!this.tracked.has(operationId)) {
              if (this.tracked.size >= DIAGNOSTIC_LIMITS.tracked) { this.gap = true; return; }
              this.tracked.set(operationId, tracked);
            }
            record.requestDisposition = disposition;
            record.revision++;
            this.queue(record);
          } catch { this.gap = true; }
        },
        correlate: (input) => {
          try {
            if (!this.tracked.has(operationId) || record.outcome !== "pending") return;
            const patch: DiagnosticCorrelations = {
              ...(input.sourceBinding === undefined ? {} : { sourceBinding: { id: input.sourceBinding.id, generation: input.sourceBinding.generation } }),
              ...(input.targetBinding === undefined ? {} : { targetBinding: { id: input.targetBinding.id, generation: input.targetBinding.generation } }),
              ...(input.trigger === undefined ? {} : { trigger: { messageId: input.trigger.messageId, sequence: input.trigger.sequence } }),
              ...(input.cleanupHistoryId === undefined ? {} : { cleanupHistoryId: input.cleanupHistoryId }),
            };
            const previous = record.correlations ?? {};
            const candidate = diagnosticRecord({ ...record, correlations: { ...previous, ...patch } }).correlations!;
            for (const key of Object.keys(previous) as (keyof DiagnosticCorrelations)[]) {
              if (JSON.stringify(previous[key]) !== JSON.stringify(candidate[key])) throw new Error("Diagnostic scope cannot change");
            }
            record.correlations = candidate;
            record.revision++;
            this.queue(record);
          } catch { this.gap = true; record.recordingGap = true; record.revision++; this.queue(record); }
        },
        finish: (outcome) => {
          try {
            if (!this.tracked.has(operationId) || record.outcome !== "pending") return;
            if (record.events.length >= DIAGNOSTIC_LIMITS.events) { record.events.pop(); record.eventsDropped++; record.recordingGap = true; }
            event("completed", outcome === "succeeded" ? "confirmed" : outcome === "failed" ? "failed" : "unknown");
            record.outcome = outcome;
            record.closedAt = record.observedAt;
            if (outcome !== "unknown") record.finishedAt = record.observedAt;
            record.revision++;
            this.queue(record);
          } catch { this.gap = true; }
        },
      };
    } catch { this.gap = true; return ignored; }
  }

  private queue(record: DiagnosticRecord) {
    if (this.state !== "ready" && this.state !== "starting") return;
    this.dirty.set(record.operationId, record);
    this.flush();
  }

  private flush() {
    if (this.state !== "ready" || this.writing || !this.dirty.size) return;
    const [id, record] = this.dirty.entries().next().value!;
    this.dirty.delete(id);
    this.writing = { id, revision: record.revision, timer: setTimeout(() => this.disable(), this.options.ioTimeoutMs ?? 2_000) };
    try { this.worker!.postMessage({ type: "put", epoch: this.epoch, record, gap: this.gap }); }
    catch { this.disable(); }
  }

  private receive(message: { type?: string; epoch?: string; id?: string; revision?: number; requestId?: number; value?: unknown; gap?: boolean }) {
    if (message.epoch !== this.epoch || this.state === "unavailable" || this.state === "closed") return;
    if (message.type === "ready") {
      clearTimeout(this.startup);
      this.state = "ready";
      this.gap ||= message.gap === true;
      this.flush();
    } else if (message.type === "written") {
      if (!this.writing || this.writing.id !== message.id || this.writing.revision !== message.revision) return;
      clearTimeout(this.writing.timer);
      this.writing = undefined;
      const tracked = this.tracked.get(message.id!);
      if (tracked && tracked.record.outcome !== "pending" && tracked.record.revision === message.revision) this.tracked.delete(message.id!);
      this.flush();
    } else if (message.type === "read" && message.requestId !== undefined) {
      const read = this.reads.get(message.requestId);
      if (read) { clearTimeout(read.timer); this.reads.delete(message.requestId); read.resolve(message.value); }
    } else if (message.type === "read_failed" && message.requestId !== undefined) {
      const read = this.reads.get(message.requestId);
      if (read) { clearTimeout(read.timer); this.reads.delete(message.requestId); read.reject(new Error("Invalid diagnostic query")); }
    } else if (message.type === "closed") {
      this.state = "closed";
      this.tracked.clear();
      this.dirty.clear();
      this.rejectReads();
    } else if (message.type === "unavailable") this.disable();
  }

  private disable() {
    if (this.state === "closed" || this.state === "unavailable") return;
    this.state = "unavailable";
    this.gap = true;
    clearTimeout(this.startup);
    clearTimeout(this.writing?.timer);
    this.writing = undefined;
    this.dirty.clear();
    this.tracked.clear();
    this.rejectReads();
    // No replacement is started while an old worker might still be running.
    try { this.stopped = this.worker?.terminate().catch(() => -1); } catch { /* optional diagnostics only */ }
  }

  private rejectReads() {
    for (const read of this.reads.values()) { clearTimeout(read.timer); read.reject(new Error("Diagnostic journal unavailable")); }
    this.reads.clear();
  }

  private read(type: "history" | "detail" | "correlated", scope: DiagnosticScope, input?: string, reference?: DiagnosticTurnReference): Promise<unknown> {
    if (!this.available || this.closing || this.reads.size >= 16) return Promise.reject(new Error("Diagnostic journal unavailable"));
    if (![scope.workspaceId, scope.conversationId, scope.participantIdentityId].every((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(id))
      || (input !== undefined && (typeof input !== "string" || input.length > 512))) return Promise.reject(new Error("Invalid diagnostic query"));
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      const timer = setTimeout(() => this.disable(), this.options.ioTimeoutMs ?? 2_000);
      this.reads.set(requestId, { resolve, reject, timer });
      try { this.worker!.postMessage({ type, scope: { workspaceId: scope.workspaceId, conversationId: scope.conversationId,
        participantIdentityId: scope.participantIdentityId }, input, reference, requestId, epoch: this.epoch }); }
      catch { this.disable(); }
    });
  }

  async history(scope: DiagnosticScope, cursor?: string): Promise<DiagnosticHistory> {
    const value = await this.read("history", scope, cursor) as DiagnosticHistory;
    return { ...value, recordingGap: value.recordingGap || this.gap };
  }
  async detail(scope: DiagnosticScope, operationId: string): Promise<DiagnosticDetail | undefined> {
    const value = await this.read("detail", scope, operationId) as DiagnosticDetail | undefined;
    return value && { ...value, recordingGap: value.recordingGap || this.gap };
  }

  async correlated(scope: DiagnosticScope, reference: DiagnosticTurnReference): Promise<string[]> {
    return await this.read("correlated", scope, undefined, {
      operationId: reference.operationId, bindingId: reference.bindingId, generation: reference.generation,
      triggerMessageId: reference.triggerMessageId, triggerSequence: reference.triggerSequence,
    }) as string[];
  }

  async close(): Promise<void> {
    this.closing = true;
    const deadline = performance.now() + 500;
    while ((this.state === "starting" || this.writing || this.dirty.size) && this.state !== "unavailable" && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.state === "ready" && !this.writing && !this.dirty.size) {
      try { this.worker!.postMessage({ type: "close", epoch: this.epoch, gap: this.gap }); }
      catch { this.disable(); }
      while (this.state === "ready" && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.state !== "closed") this.disable();
    // terminate() is asynchronous. It never gates lifecycle work, and no restart races it.
    void this.stopped;
  }
}
