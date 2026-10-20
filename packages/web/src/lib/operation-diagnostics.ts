import { LocalControlClientError } from "@minu/channels-control/client";
import type { LocalAgentDiagnosticReport, LocalAgentOperationDetail, LocalAgentOperationHistory } from "@minu/channels-control/contracts";

export interface DiagnosticBrowserScope {
  humanIdentityId: string;
  workspaceId: string;
  conversationId: string;
}
export interface DiagnosticTargetScope extends DiagnosticBrowserScope { participantIdentityId: string }
export function diagnosticScopeKey(scope: DiagnosticTargetScope): string {
  return JSON.stringify([scope.humanIdentityId, scope.workspaceId, scope.conversationId, scope.participantIdentityId]);
}

interface DiagnosticReads {
  agentOperationHistory(conversation: string, identity: string, options: { cursor?: string; signal: AbortSignal }): Promise<LocalAgentOperationHistory>;
  agentOperationDetail(conversation: string, identity: string, operation: string, signal: AbortSignal): Promise<LocalAgentOperationDetail>;
  agentDiagnosticReport(conversation: string, identity: string, operation: string, signal: AbortSignal): Promise<LocalAgentDiagnosticReport>;
}
export interface DiagnosticSurfaceState {
  history?: LocalAgentOperationHistory;
  selectedId?: string;
  detail?: LocalAgentOperationDetail;
  preview?: string;
  historyBusy?: boolean;
  detailBusy?: boolean;
  reportBusy?: boolean;
  historyError?: string;
  detailError?: string;
  reportMessage?: string;
  revoked?: boolean;
}

type Lane = "history" | "detail" | "report";
/** Open-surface memory only: no QueryClient, browser storage, logs, or mutation endpoints.
 * Every lane is abortable AND fenced, including clients/clipboard implementations ignoring abort.
 * A new instance owns one human/resource scope; dispose destroys all retained projections.
 */
export class DiagnosticSurface {
  state: DiagnosticSurfaceState = {};
  private closed = false;
  private lanes = new Map<Lane, AbortController>();
  private cursor?: string;

  constructor(readonly scope: DiagnosticTargetScope, private reads: DiagnosticReads,
    private changed: (state: DiagnosticSurfaceState) => void) {}

  private update(patch: Partial<DiagnosticSurfaceState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private abort(lane: Lane) { this.lanes.get(lane)?.abort(); this.lanes.delete(lane); }
  private begin(lane: Lane): AbortController | undefined {
    if (this.closed || this.state.revoked) return;
    this.abort(lane);
    const controller = new AbortController();
    this.lanes.set(lane, controller);
    return controller;
  }
  private current(lane: Lane, controller: AbortController) {
    return !this.closed && !controller.signal.aborted && this.lanes.get(lane) === controller;
  }
  private failure(error: unknown): boolean {
    if (error instanceof LocalControlClientError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      this.revoke();
      return true;
    }
    return false;
  }
  revoke() {
    if (this.closed) return;
    for (const lane of this.lanes.keys()) this.abort(lane);
    this.state = { revoked: true };
    this.changed(this.state);
  }
  dispose() {
    this.closed = true;
    for (const lane of this.lanes.keys()) this.abort(lane);
    this.state = {};
  }

  latest() { this.cursor = undefined; return this.history(); }

  async history(cursor = this.cursor) {
    const controller = this.begin("history");
    if (!controller) return;
    this.cursor = cursor;
    this.update({ historyBusy: true, historyError: undefined });
    try {
      const history = await this.reads.agentOperationHistory(this.scope.conversationId, this.scope.participantIdentityId, { cursor, signal: controller.signal });
      if (!this.current("history", controller)) return;
      this.update({ history, historyBusy: false });
      if (!this.state.selectedId && history.operations[0]) void this.select(history.operations[0].operationId);
    } catch (error) {
      if (!this.current("history", controller) || this.failure(error)) return;
      this.update({ historyBusy: false, historyError: "History refresh failed. Previous observations may be stale; current progress is not verified." });
    }
  }
  async select(operationId: string) {
    const controller = this.begin("detail");
    if (!controller) return;
    this.abort("report");
    this.update({ selectedId: operationId, detail: undefined, preview: undefined, reportMessage: undefined, reportBusy: false, detailBusy: true, detailError: undefined });
    await this.readDetail(operationId, controller);
  }
  async refreshDetail() {
    const id = this.state.selectedId;
    if (!id) return;
    const controller = this.begin("detail");
    if (!controller) return;
    this.update({ detailBusy: true, detailError: undefined });
    await this.readDetail(id, controller);
  }
  private async readDetail(operationId: string, controller: AbortController) {
    try {
      const detail = await this.reads.agentOperationDetail(this.scope.conversationId, this.scope.participantIdentityId, operationId, controller.signal);
      if (this.current("detail", controller)) this.update({ detail, detailBusy: false });
    } catch (error) {
      if (!this.current("detail", controller) || this.failure(error)) return;
      this.update({ detailBusy: false, detailError: "Operation refresh failed. Any previous timeline may be stale; final outcome is not verified." });
    }
  }
  /** Each invocation, including Copy after Preview, performs a fresh authorized report read. */
  async report(copy?: (text: string) => Promise<void>) {
    const id = this.state.selectedId;
    if (!id) return;
    const controller = this.begin("report");
    if (!controller) return;
    this.update({ reportBusy: true, reportMessage: undefined, preview: undefined });
    try {
      const report = await this.reads.agentDiagnosticReport(this.scope.conversationId, this.scope.participantIdentityId, id, controller.signal);
      if (!this.current("report", controller)) return;
      const text = diagnosticReportText(report);
      if (copy) {
        try { await copy(text); }
        catch {
          if (this.current("report", controller)) this.update({ reportBusy: false, reportMessage: "Clipboard access failed. Nothing was published. Try Copy again to request a fresh report." });
          return;
        }
        if (this.current("report", controller)) this.update({ reportBusy: false, reportMessage: "Fresh report copied. Previously copied data cannot be revoked." });
      } else this.update({ reportBusy: false, preview: text });
    } catch (error) {
      if (!this.current("report", controller) || this.failure(error)) return;
      this.update({ reportBusy: false, reportMessage: "Report read failed. No report was copied; try again for a fresh authorized snapshot." });
    }
  }
}

/** Preserve the wire report budget after local formatting, including UTF-8 bytes. */
export function diagnosticReportText(report: LocalAgentDiagnosticReport): string {
  const maximum = 64 * 1024;
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  const compact = JSON.stringify(report);
  if (bytes(compact) > maximum) throw new Error("Diagnostic report exceeds its byte budget");
  const pretty = JSON.stringify(report, null, 2);
  return bytes(pretty) <= maximum ? pretty : compact;
}

/** Enum-only presentation labels; arbitrary transport errors never enter the surface. */
export function observationLabel(value: string): string { return value.replaceAll("_", " "); }
export function requestDispositionLabel(value: string): string {
  switch (value) {
    case "accepted": return "Accepted; handler return not observed";
    case "handler_returned": return "Handler returned (not proof of lifecycle completion)";
    case "handler_failed": return "Handler failed (confirmed effects may remain)";
    case "not_applicable": return "Not an independent HTTP request";
    default: return "Unavailable";
  }
}
