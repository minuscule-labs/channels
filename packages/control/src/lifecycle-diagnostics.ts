import { safeDiagnosticObservation, type DiagnosticAction, type DiagnosticScope } from "@minu/channels-relay";
import type { DiagnosticRecorder, RecordedOperation } from "./diagnostics-recorder.ts";

export type LifecycleDiagnostics = Pick<DiagnosticRecorder, "begin">;

/** A synchronous, optional observer boundary; never await a recorder from lifecycle code. */
export function beginLifecycleObservation(
  recorder: LifecycleDiagnostics | undefined,
  scope: DiagnosticScope,
  action: DiagnosticAction,
  relation?: { parentOperationId?: string; relatedOperationId?: string },
): RecordedOperation | undefined {
  try {
    const operation = recorder?.begin(scope, action, relation);
    if (!operation) return undefined;
    const observation = safeDiagnosticObservation(operation)!;
    return {
      ...observation,
      get operationId() { try { return operation.operationId; } catch { return "operation_unrecorded"; } },
      get recorded() { try { return operation.recorded; } catch { return false; } },
      requestFinished(disposition) { try { operation.requestFinished(disposition); } catch { /* best effort */ } },
      bulkProgress(progress) { try { operation.bulkProgress(progress); } catch { /* best effort */ } },
      targetResult(result) { try { operation.targetResult(result); } catch { /* best effort */ } },
    };
  } catch { return undefined; }
}
