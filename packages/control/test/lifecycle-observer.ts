import type { DiagnosticAction, DiagnosticCorrelations, DiagnosticOutcome, DiagnosticRequestDisposition, DiagnosticScope, DiagnosticBulkProgress, DiagnosticTargetResult } from "@minu/channels-relay";
import type { RecordedOperation } from "../src/diagnostics-recorder.ts";
import type { LifecycleDiagnostics } from "../src/lifecycle-diagnostics.ts";

export interface ObservedOperation {
  operationId: string;
  scope: DiagnosticScope;
  action: DiagnosticAction;
  relatedOperationId?: string;
  parentOperationId?: string;
  correlations: DiagnosticCorrelations;
  events: Array<Parameters<RecordedOperation["event"]>>;
  requestDisposition: DiagnosticRequestDisposition;
  outcome: DiagnosticOutcome;
  bulk?: DiagnosticBulkProgress;
  bulkTarget?: DiagnosticTargetResult;
}
export class LifecycleCollector implements LifecycleDiagnostics {
  readonly operations: ObservedOperation[] = [];
  throwObservations = false;
  begin(scope: DiagnosticScope, action: DiagnosticAction, relation?: { relatedOperationId?: string; parentOperationId?: string }): RecordedOperation {
    const record: ObservedOperation = { operationId: `operation_test_${this.operations.length + 1}`, scope, action, ...relation,
      correlations: {}, events: [], requestDisposition: "accepted", outcome: "pending" };
    this.operations.push(record);
    const check = () => { if (this.throwObservations) throw new Error("PRIVATE_OBSERVER_FAILURE"); };
    return {
      operationId: record.operationId, recorded: true,
      correlate(value) { check(); record.correlations = { ...record.correlations, ...structuredClone(value) }; },
      event(...args) { check(); record.events.push(structuredClone(args)); },
      bulkProgress(value) { check(); record.bulk = structuredClone(value); },
      targetResult(value) { check(); record.bulkTarget = { outcome: value.outcome, ...(value.reason === undefined ? {} : { reason: value.reason }) }; },
      finish(value) { check(); record.outcome = value; },
      requestFinished(value) { check(); record.requestDisposition = value; },
    };
  }
}
