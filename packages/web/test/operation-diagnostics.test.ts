import { LocalControlClientError } from "@minu/channels-control/client";
import type { LocalAgentDiagnosticReport, LocalAgentOperationDetail, LocalAgentOperationHistory, LocalAgentSessionInspection, LocalAgentSessionEvents, LocalAgentDeliveryTrails } from "@minu/channels-control/contracts";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticSurface, diagnosticReportText, diagnosticScopeKey, requestDispositionLabel } from "../src/lib/operation-diagnostics";

const scope = { humanIdentityId: "owner", workspaceId: "workspace", conversationId: "conversation", participantIdentityId: "agent" };
const history: LocalAgentOperationHistory = { protocolVersion: 22, conversationId: "conversation", participantIdentityId: "agent", capturedAt: "now", operations: [], coverage: "available", recordingGap: false, retention: { days: 7, terminalLimit: 1_000, eventLimit: 128 } };
const detail: LocalAgentOperationDetail = { protocolVersion: 22, conversationId: "conversation", participantIdentityId: "agent", capturedAt: "now", coverage: "available", relations: [], failures: [], failuresUnavailable: false };
function report(capturedAt = "now"): LocalAgentDiagnosticReport {
  return { formatVersion: 1, protocolVersion: 22, capturedAt, conversationId: "conversation", participant: { identityId: "agent", displayLabel: "<script>not executable</script>", availability: "current" }, selected: detail, coverage: { snapshotUnavailable: true, truncated: false, notes: [] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const inspection: LocalAgentSessionInspection = { protocolVersion: 22, conversationId: "conversation", participantIdentityId: "agent", capturedAt: "now", availability: "unavailable",
  running: { status: "not_verified" }, saved: { status: "unavailable" }, latestStart: "not_verified", lastStopBoundary: "not_recorded" };
const events: LocalAgentSessionEvents = { protocolVersion: 22, conversationId: "conversation", participantIdentityId: "agent", capturedAt: "now", availability: "available",
  snapshot: { version: 1, source: "runtime_bridge", capturedAt: "now", recordingSince: "window", eventsDropped: 0, events: [{ sequence: 1, observedAt: "now", code: "turn_accepted" }] } };
const trails: LocalAgentDeliveryTrails = { protocolVersion: 22, conversationId: "conversation", participantIdentityId: "agent", capturedAt: "now", availability: "available",
  retention: { days: 7, terminalLimit: 1000, eventLimit: 16 }, history: { trails: [], recordingGap: false } };
function fixture() {
  const reads = {
    agentDeliveryTrails: vi.fn(async (_conversation: string, _identity: string, _options: { cursor?: string; trailId?: string; signal?: AbortSignal }) => trails),
    agentSessionEvents: vi.fn(async (_conversation: string, _identity: string, _signal: AbortSignal) => events),
    agentSessionInspection: vi.fn(async (_conversation: string, _identity: string, _signal: AbortSignal) => inspection),
    agentOperationHistory: vi.fn(async (_conversation: string, _identity: string, _options: { cursor?: string; signal: AbortSignal }) => history),
    agentOperationDetail: vi.fn(async (_conversation: string, _identity: string, _operation: string, _signal: AbortSignal) => detail),
    agentDiagnosticReport: vi.fn(async (_conversation: string, _identity: string, _operation: string, _signal: AbortSignal) => report()),
  };
  const changed = vi.fn();
  return { reads, changed, surface: new DiagnosticSurface(scope, reads, changed) };
}

describe("open-surface diagnostic ownership", () => {
  it("message trails read only on explicit open/refresh and are cleared on close", async () => {
    const { surface, reads } = fixture(); await surface.history(); await surface.inspectSession();
    expect(reads.agentDeliveryTrails).not.toHaveBeenCalled(); await surface.openTrails(); expect(surface.state.deliveryTrails).toEqual(trails);
    await surface.selectTrail("trail-one"); expect(reads.agentDeliveryTrails.mock.calls.at(-1)?.[2].trailId).toBe("trail-one");
    surface.closeTrails(); expect(surface.state.deliveryTrails).toBeUndefined(); await surface.refreshTrails(); expect(reads.agentDeliveryTrails).toHaveBeenCalledTimes(2);
  });
  it("closing or navigating fences late trails from clients ignoring abort", async () => {
    const { surface, reads } = fixture(); const pending = deferred<LocalAgentDeliveryTrails>(); reads.agentDeliveryTrails.mockReturnValueOnce(pending.promise);
    const opening = surface.openTrails(); surface.closeTrails(); expect(reads.agentDeliveryTrails.mock.calls[0]?.[2].signal?.aborted).toBe(true);
    pending.resolve(trails); await opening; expect(surface.state.deliveryTrails).toBeUndefined();
    await surface.openTrails(); surface.dispose(); expect(surface.state).toEqual({});
  });
  it("trail refresh clears old evidence and denial revokes every privileged lane", async () => {
    const { surface, reads } = fixture(); await surface.openTrails(); reads.agentDeliveryTrails.mockRejectedValueOnce(new Error("SECRET"));
    await surface.refreshTrails(); expect(surface.state.deliveryTrails).toBeUndefined(); expect(surface.state.trailsError).toBe("Unavailable");
    reads.agentDeliveryTrails.mockRejectedValueOnce(new LocalControlClientError("SECRET", 404)); await surface.refreshTrails(); expect(surface.state).toEqual({ revoked: true });
    await surface.openTrails(); expect(reads.agentDeliveryTrails).toHaveBeenCalledTimes(3);
  });
  it("changed trails discard old report/profile and changed session inspection clears trails", async () => {
    const { surface, reads } = fixture(); await surface.inspectSession(); await surface.select("operation"); await surface.report();
    reads.agentDeliveryTrails.mockResolvedValueOnce({ ...trails, availability: "changed", history: undefined }); await surface.openTrails();
    expect(surface.state.preview).toBeUndefined(); expect(surface.state.inspection).toBeUndefined();
    reads.agentSessionInspection.mockResolvedValueOnce({ ...inspection, availability: "changed" }); await surface.inspectSession(); expect(surface.state.trailsOpen).toBe(false); expect(surface.state.deliveryTrails).toBeUndefined();
  });

  it("loads events only on explicit open/refresh and clears them on close", async () => {
    const { surface, reads } = fixture();
    await surface.history(); await surface.inspectSession();
    expect(reads.agentSessionEvents).not.toHaveBeenCalled();
    await surface.openEvents(); expect(surface.state.runtimeEvents).toEqual(events);
    await surface.refreshEvents(); expect(reads.agentSessionEvents).toHaveBeenCalledTimes(2);
    surface.closeEvents(); expect(surface.state.runtimeEvents).toBeUndefined();
    await surface.refreshEvents(); expect(reads.agentSessionEvents).toHaveBeenCalledTimes(2);
    expect(surface.state.eventsOpen).toBe(false);
  });
  it("event refresh/close fence clients ignoring cancellation and never retain late projections", async () => {
    const { surface, reads } = fixture();
    const first = deferred<LocalAgentSessionEvents>(); reads.agentSessionEvents.mockReturnValueOnce(first.promise);
    const opening = surface.openEvents();
    await surface.refreshEvents();
    expect(reads.agentSessionEvents.mock.calls[0]?.[2].aborted).toBe(true);
    first.resolve({ ...events, capturedAt: "late-private" }); await opening;
    expect(surface.state.runtimeEvents?.capturedAt).toBe("now");
    const pending = deferred<LocalAgentSessionEvents>(); reads.agentSessionEvents.mockReturnValueOnce(pending.promise);
    const refreshing = surface.refreshEvents(); expect(surface.state.runtimeEvents).toBeUndefined();
    surface.closeEvents(); pending.resolve(events); await refreshing;
    expect(surface.state.runtimeEvents).toBeUndefined(); expect(surface.state.eventsOpen).toBe(false);
  });
  it("event denial revokes all projections; transient errors never show raw transport content", async () => {
    const { surface, reads } = fixture();
    await surface.openEvents(); reads.agentSessionEvents.mockRejectedValueOnce(new Error("SECRET_PATH"));
    await surface.refreshEvents(); expect(surface.state.runtimeEvents).toBeUndefined();
    expect(surface.state.eventsError).toBe("Unavailable");
    reads.agentSessionEvents.mockRejectedValueOnce(new LocalControlClientError("SECRET", 401));
    await surface.refreshEvents(); expect(surface.state).toEqual({ revoked: true });
    await surface.openEvents(); expect(reads.agentSessionEvents).toHaveBeenCalledTimes(3);
  });
  it("event ownership is disposed during navigation and never caches across humans/resources", async () => {
    const { surface, reads } = fixture();
    const pending = deferred<LocalAgentSessionEvents>(); reads.agentSessionEvents.mockReturnValueOnce(pending.promise);
    const opening = surface.openEvents(); surface.dispose();
    expect(reads.agentSessionEvents.mock.calls[0]?.[2].aborted).toBe(true);
    pending.resolve(events); await opening; expect(surface.state).toEqual({});
    const next = new DiagnosticSurface({ ...scope, humanIdentityId: "other" }, reads, () => {});
    expect(next.state.runtimeEvents).toBeUndefined(); expect(next.state.eventsOpen).toBeUndefined();
  });
  it("serializes optional Runtime reads without queuing profile/report work behind an event read", async () => {
    const { surface, reads } = fixture(); await surface.select("selected");
    const pending = deferred<LocalAgentSessionEvents>(); reads.agentSessionEvents.mockReturnValueOnce(pending.promise);
    const opening = surface.openEvents(); await surface.inspectSession(); await surface.report();
    expect(reads.agentSessionInspection).not.toHaveBeenCalled(); expect(reads.agentDiagnosticReport).not.toHaveBeenCalled();
    pending.resolve(events); await opening;
    const profile = deferred<LocalAgentSessionInspection>(); reads.agentSessionInspection.mockReturnValueOnce(profile.promise);
    const inspecting = surface.inspectSession(); surface.closeEvents(); await surface.openEvents();
    expect(reads.agentSessionEvents).toHaveBeenCalledTimes(1);
    profile.resolve(inspection); await inspecting;
  });
  it("observed session changes clear recent events and changed-event responses clear old profiles/reports", async () => {
    const { surface, reads } = fixture(); await surface.inspectSession(); await surface.openEvents();
    reads.agentSessionInspection.mockResolvedValueOnce({ ...inspection, availability: "changed" });
    await surface.inspectSession(); expect(surface.state.runtimeEvents).toBeUndefined(); expect(surface.state.eventsOpen).toBe(false);
    await surface.select("selected"); await surface.report(); expect(surface.state.preview).toBeDefined();
    reads.agentSessionEvents.mockResolvedValueOnce({ ...events, availability: "changed", snapshot: undefined });
    await surface.openEvents(); expect(surface.state.preview).toBeUndefined(); expect(surface.state.inspection).toBeUndefined();
    expect(surface.state.runtimeEvents?.availability).toBe("changed");
  });

  it("inspection supersession and disposal fence clients ignoring abort", async () => {
    const { surface, reads } = fixture();
    const late = deferred<LocalAgentSessionInspection>();
    reads.agentSessionInspection.mockReturnValueOnce(late.promise);
    const pending = surface.inspectSession();
    await surface.inspectSession();
    expect(reads.agentSessionInspection.mock.calls[0]?.[2].aborted).toBe(true);
    late.resolve({ ...inspection, capturedAt: "late-private" }); await pending;
    expect(surface.state.inspection?.capturedAt).toBe("now");
    const closed = deferred<LocalAgentSessionInspection>();
    reads.agentSessionInspection.mockReturnValueOnce(closed.promise);
    const second = surface.inspectSession(); surface.dispose(); closed.resolve(inspection); await second;
    expect(surface.state).toEqual({});
  });
  it("inspection denial revokes all lanes and clears other privileged projections", async () => {
    const { surface, reads } = fixture();
    await surface.history(); await surface.select("selected"); await surface.report();
    reads.agentSessionInspection.mockRejectedValueOnce(new LocalControlClientError("SECRET", 404));
    await surface.inspectSession();
    expect(surface.state).toEqual({ revoked: true });
    await surface.inspectSession(); expect(reads.agentSessionInspection).toHaveBeenCalledTimes(1);
  });
  it("failed session refresh drops the old profile and never shows transport error text", async () => {
    const { surface, reads } = fixture();
    await surface.inspectSession(); expect(surface.state.inspection).toBeDefined();
    reads.agentSessionInspection.mockRejectedValueOnce(new Error("SECRET"));
    await surface.inspectSession();
    expect(surface.state.inspection).toBeUndefined();
    expect(surface.state.inspectionError).toContain("not verified");
    expect(JSON.stringify(surface.state)).not.toContain("SECRET");
  });
  it("a changed activation aborts late report delivery and clears its preview", async () => {
    const { surface, reads } = fixture();
    await surface.select("selected"); await surface.report(); expect(surface.state.preview).toBeDefined();
    const late = deferred<LocalAgentDiagnosticReport>();
    reads.agentDiagnosticReport.mockReturnValueOnce(late.promise);
    const pending = surface.report();
    reads.agentSessionInspection.mockResolvedValueOnce({ ...inspection, availability: "changed" });
    await surface.inspectSession(); late.resolve(report("old-generation")); await pending;
    expect(surface.state.preview).toBeUndefined(); expect(surface.state.reportMessage).toContain("session changed");
    expect(surface.state.reportBusy).toBe(false);
  });

  it("keeps preview/clipboard JSON inside the UTF-8 wire budget after formatting", () => {
    const value = report();
    value.coverage.notes = Array.from({ length: 2_000 }, () => "é".repeat(12));
    const compact = JSON.stringify(value);
    expect(new TextEncoder().encode(compact).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength).toBeGreaterThan(64 * 1024);
    const text = diagnosticReportText(value);
    expect(text).toBe(compact);
    expect(JSON.parse(text)).toEqual(value);
  });
  it("rejects an oversized UTF-8 report without previewing or copying it", async () => {
    const { surface, reads } = fixture();
    await surface.select("selected");
    const value = report();
    value.coverage.notes = ["😀".repeat(20_000)];
    expect(JSON.stringify(value).length).toBeLessThan(64 * 1024);
    reads.agentDiagnosticReport.mockResolvedValueOnce(value);
    const copy = vi.fn(async () => undefined);
    await surface.report(copy);
    expect(copy).not.toHaveBeenCalled();
    expect(surface.state.preview).toBeUndefined();
    expect(surface.state.reportMessage).toContain("Report read failed");
  });
  it("scopes ownership to the human and every resource, even with separator-like IDs", () => {
    const key = diagnosticScopeKey(scope);
    for (const property of Object.keys(scope)) expect(diagnosticScopeKey({ ...scope, [property]: "other" })).not.toBe(key);
    expect(diagnosticScopeKey({ ...scope, humanIdentityId: "owner:workspace", workspaceId: "x" })).not.toBe(diagnosticScopeKey({ ...scope, humanIdentityId: "owner", workspaceId: "workspace:x" }));
  });
  it("does no reads until explicitly opened and never retains state after disposal", async () => {
    const { surface, reads, changed } = fixture();
    expect(reads.agentOperationHistory).not.toHaveBeenCalled();
    const late = deferred<LocalAgentOperationHistory>();
    reads.agentOperationHistory.mockReturnValueOnce(late.promise);
    const pending = surface.history();
    const signal = reads.agentOperationHistory.mock.calls[0]![2].signal;
    surface.dispose();
    const count = changed.mock.calls.length;
    expect(signal.aborted).toBe(true);
    late.resolve(history);
    await pending;
    await surface.history();
    expect(surface.state).toEqual({});
    expect(changed).toHaveBeenCalledTimes(count);
    expect(reads.agentOperationHistory).toHaveBeenCalledTimes(1);
  });
  it("fences superseded history pages and can reset to latest", async () => {
    const { surface, reads } = fixture();
    const late = deferred<LocalAgentOperationHistory>();
    reads.agentOperationHistory.mockReturnValueOnce(late.promise);
    const first = surface.history("old-cursor");
    await surface.history("next-cursor");
    late.resolve({ ...history, capturedAt: "stale" });
    await first;
    expect(surface.state.history?.capturedAt).toBe("now");
    await surface.history();
    expect(reads.agentOperationHistory.mock.calls.at(-1)![2].cursor).toBe("next-cursor");
    await surface.latest();
    expect(reads.agentOperationHistory.mock.calls.at(-1)![2].cursor).toBeUndefined();
  });
  it("selection aborts old detail and report reads, rejecting even late successful replies", async () => {
    const { surface, reads } = fixture();
    const oldDetail = deferred<LocalAgentOperationDetail>();
    reads.agentOperationDetail.mockReturnValueOnce(oldDetail.promise);
    const first = surface.select("old");
    const oldReport = deferred<LocalAgentDiagnosticReport>();
    reads.agentDiagnosticReport.mockReturnValueOnce(oldReport.promise);
    const copy = vi.fn(async () => undefined);
    const copying = surface.report(copy);
    await surface.select("new");
    expect(reads.agentOperationDetail.mock.calls[0]![3].aborted).toBe(true);
    expect(reads.agentDiagnosticReport.mock.calls[0]![3].aborted).toBe(true);
    oldDetail.resolve({ ...detail, capturedAt: "stale" });
    oldReport.resolve(report("stale"));
    await Promise.all([first, copying]);
    expect(surface.state.selectedId).toBe("new");
    expect(surface.state.detail?.capturedAt).toBe("now");
    expect(surface.state.preview).toBeUndefined();
    expect(copy).not.toHaveBeenCalled();
  });
  for (const status of [401, 403, 404]) it(`clears every privileged projection and fences all lanes on HTTP ${status}`, async () => {
    const { surface, reads } = fixture();
    await surface.history();
    await surface.select("selected");
    await surface.report();
    expect(surface.state.preview).toBeDefined();
    const late = deferred<LocalAgentOperationHistory>();
    reads.agentOperationHistory.mockReturnValueOnce(late.promise);
    const pending = surface.history();
    reads.agentDiagnosticReport.mockRejectedValueOnce(new LocalControlClientError("PRIVATE_ERROR", status));
    await surface.report();
    expect(reads.agentOperationHistory.mock.calls.at(-1)![2].signal.aborted).toBe(true);
    late.resolve(history);
    await pending;
    await surface.select("another");
    await surface.history();
    expect(surface.state).toEqual({ revoked: true });
    expect(reads.agentOperationDetail).toHaveBeenCalledTimes(1);
  });
  it("copies a fresh read rather than cached preview, and clears previews on selection", async () => {
    const { surface, reads } = fixture();
    await surface.select("selected");
    reads.agentDiagnosticReport.mockResolvedValueOnce(report("preview-time")).mockResolvedValueOnce(report("copy-time"));
    await surface.report();
    expect(surface.state.preview).toContain("preview-time");
    const copy = vi.fn(async (_text: string) => undefined);
    await surface.report(copy);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(copy.mock.calls[0]![0]).capturedAt).toBe("copy-time");
    expect(reads.agentDiagnosticReport).toHaveBeenCalledTimes(2);
    expect(surface.state.preview).toBeUndefined();
    expect(surface.state.reportMessage).toContain("cannot be revoked");
    await surface.select("other");
    expect(surface.state.reportMessage).toBeUndefined();
  });
  it("clears memory on role/navigation/session loss while Copy is awaiting its fresh read", async () => {
    const { surface, reads } = fixture();
    await surface.select("selected");
    const late = deferred<LocalAgentDiagnosticReport>();
    reads.agentDiagnosticReport.mockReturnValueOnce(late.promise);
    const copy = vi.fn(async () => undefined);
    const pending = surface.report(copy);
    surface.revoke();
    late.resolve(report());
    await pending;
    expect(copy).not.toHaveBeenCalled();
    expect(surface.state).toEqual({ revoked: true });
  });
  it("clipboard failure and report failures never expose raw errors or retain report content", async () => {
    const { surface, reads } = fixture();
    await surface.select("selected");
    await surface.report(async () => { throw new Error("PRIVATE_CLIPBOARD_ERROR"); });
    expect(surface.state.reportMessage).toContain("Clipboard access failed");
    expect(JSON.stringify(surface.state)).not.toContain("PRIVATE_CLIPBOARD_ERROR");
    expect(surface.state.preview).toBeUndefined();
    reads.agentDiagnosticReport.mockRejectedValueOnce(new Error("PRIVATE_REPORT_ERROR"));
    await surface.report();
    expect(surface.state.reportMessage).toContain("Report read failed");
    expect(JSON.stringify(surface.state)).not.toContain("PRIVATE_REPORT_ERROR");
  });
  it("fences clipboard completion after disposal without claiming clipboard revocation", async () => {
    const { surface, changed } = fixture();
    await surface.select("selected");
    const clipboard = deferred<void>();
    const copy = vi.fn(() => clipboard.promise);
    const pending = surface.report(copy);
    await Promise.resolve();
    expect(copy).toHaveBeenCalledTimes(1);
    surface.dispose();
    const count = changed.mock.calls.length;
    clipboard.resolve();
    await pending;
    expect(changed).toHaveBeenCalledTimes(count);
    expect(surface.state).toEqual({});
  });
  it("retains a stale labeled snapshot on read failure without inventing outcome or expiry", async () => {
    const { surface, reads } = fixture();
    await surface.history();
    await surface.select("missing");
    expect(surface.state.detail?.coverage).toBe("available");
    expect(surface.state.detail?.detail).toBeUndefined();
    reads.agentOperationHistory.mockRejectedValueOnce(new Error("PRIVATE_HISTORY_ERROR"));
    reads.agentOperationDetail.mockRejectedValueOnce(new Error("PRIVATE_DETAIL_ERROR"));
    await surface.history();
    await surface.refreshDetail();
    expect(surface.state.history).toEqual(history);
    expect(surface.state.historyError).toContain("stale");
    expect(surface.state.detailError).toContain("not verified");
    expect(JSON.stringify(surface.state)).not.toContain("PRIVATE_");
    expect(requestDispositionLabel("handler_returned")).toContain("not proof");
    expect(requestDispositionLabel("handler_failed")).toContain("effects may remain");
  });
});
