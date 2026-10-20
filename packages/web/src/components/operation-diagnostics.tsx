import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState } from "react";
import { conversations, localControl } from "../lib/api";
import { DiagnosticSurface, diagnosticScopeKey, observationLabel, requestDispositionLabel, type DiagnosticSurfaceState, type DiagnosticTargetScope } from "../lib/operation-diagnostics";
import { queryKeys } from "../lib/query-keys";
import { TurnFailureDiagnostics } from "./turn-failure-diagnostics";
import { TriggerLink } from "./trigger-message-link";

/** Mounted only for an open privileged agent surface. Shared queries contain public
 * authorization inputs only; diagnostic projections stay in the disposable child. */
export function OperationDiagnostics({ scope, onViewMessage, loadedSequences, requestPending = false }: {
  scope: DiagnosticTargetScope;
  loadedSequences: ReadonlySet<number>;
  onViewMessage(sequence: number): void;
  requestPending?: boolean;
}) {
  const workspace = useQuery({ queryKey: queryKeys.workspace(scope.workspaceId), queryFn: () => conversations.getWorkspace(scope.workspaceId), retry: false, refetchInterval: 5_000 });
  const session = useQuery({ queryKey: queryKeys.localCurrentSession(), queryFn: () => localControl.currentSession(), retry: false, refetchInterval: 5_000 });
  const members = useQuery({ queryKey: queryKeys.workspaceMembers(scope.workspaceId), queryFn: () => conversations.listWorkspaceMembers(scope.workspaceId), retry: false, refetchInterval: 5_000 });
  const identities = useQuery({ queryKey: queryKeys.identities(), queryFn: () => conversations.listIdentities(), retry: false, refetchInterval: 5_000 });
  const metadata = useQuery({ queryKey: queryKeys.conversation(scope.conversationId), queryFn: () => conversations.getConversation(scope.conversationId), retry: false, refetchInterval: 5_000 });
  const identity = identities.data?.find(({ id }) => id === scope.humanIdentityId);
  const member = members.data?.find(({ identityId }) => identityId === scope.humanIdentityId);
  const participant = metadata.data?.participants.find(({ id }) => id === scope.humanIdentityId);
  const authorized = workspace.isSuccess && workspace.data.status === "active" && session.isSuccess && members.isSuccess && identities.isSuccess && metadata.isSuccess
    && session.data.identityId === scope.humanIdentityId && identity?.type === "human" && identity.status === "active"
    && member?.status === "active" && (member.accessRole === "owner" || member.accessRole === "admin")
    && metadata.data.workspaceId === scope.workspaceId && participant && participant.status !== "disabled";
  return authorized ? <OperationDiagnosticsContent key={diagnosticScopeKey(scope)} scope={scope} onViewMessage={onViewMessage} loadedSequences={loadedSequences} requestPending={requestPending} />
    : <p role="status">Privileged diagnostics cleared: access could not be verified. Previously copied data cannot be revoked.</p>;
}

function OperationDiagnosticsContent({ scope, onViewMessage, loadedSequences, requestPending }: {
  requestPending: boolean;
  scope: DiagnosticTargetScope;
  loadedSequences: ReadonlySet<number>;
  onViewMessage(sequence: number): void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<DiagnosticSurfaceState>({});
  const key = diagnosticScopeKey(scope);
  // Create inside the effect: React effect replay must get a fresh, live owner,
  // not reuse an instance already disposed by the previous cleanup.
  const [surface, setSurface] = useState<DiagnosticSurface>();
  const [pollBudget, setPollBudget] = useState(() => performance.now() + 60_000);
  const [pollEnded, setPollEnded] = useState(false);
  const [eventFilter, setEventFilter] = useState("all");
  useEffect(() => setEventFilter("all"), [state.selectedId]);
  useLayoutEffect(() => {
    const opened = new DiagnosticSurface(scope, localControl, setState);
    setSurface(opened);
    void opened.history();
    return () => opened.dispose();
  }, [key]);
  useEffect(() => {
    if (!state.revoked) return;
    // Clear older privileged Phase 1 projections as well as this surface's memory.
    for (const queryKey of [queryKeys.localConversationTurnFailures(scope.conversationId, scope.humanIdentityId), queryKeys.localConversationAgents(scope.conversationId)]) {
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.removeQueries({ queryKey, exact: true });
    }
    for (const queryKey of [queryKeys.localCurrentSession(), queryKeys.workspaceMembers(scope.workspaceId), queryKeys.identities(), queryKeys.conversation(scope.conversationId)]) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }, [state.revoked, key, queryClient]);
  const pending = requestPending || state.history?.operations.some(({ outcome }) => outcome === "pending") || state.detail?.detail?.operation.outcome === "pending";
  useEffect(() => {
    if (!surface || !pending || state.revoked || state.historyError || state.detailError) return;
    if (performance.now() >= pollBudget) { setPollEnded(true); return; }
    const timer = window.setTimeout(() => {
      if (performance.now() >= pollBudget) { setPollEnded(true); return; }
      if (!surface.state.historyBusy) void surface.history();
      if (!surface.state.detailBusy) void surface.refreshDetail();
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [pending, state, surface, pollBudget]);
  const refresh = () => {
    if (!surface) return;
    setPollBudget(performance.now() + 60_000);
    setPollEnded(false);
    void surface.history();
    void surface.refreshDetail();
  };
  if (!surface) return <p role="status">Opening operation history…</p>;
  if (state.revoked) return <p role="status">Privileged diagnostics cleared: access or the requested diagnostic resource is unavailable, or the browser session expired. Close and reopen after verifying access. Previously copied data cannot be revoked.</p>;
  const detail = state.detail?.detail;
  const operation = detail?.operation;
  return <section aria-label="Operation history" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Operation history</h3>
      <button type="button" className="button-secondary" onClick={refresh} disabled={state.historyBusy || state.detailBusy}>Refresh operations</button>
    </div>
    <p className="text-[var(--muted)]">Local best-effort observations, not lifecycle authority. Handler return, interrupt acknowledgment, turn settlement, binding commit, and cleanup are separate evidence.</p>
    {state.historyBusy ? <p role="status">Reading history…</p> : null}
    {state.historyError ? <p role="alert">{state.historyError}</p> : null}
    {state.history ? <>
      <p className="text-[var(--muted)]">History captured {state.history.capturedAt}. Coverage: {state.history.coverage}. Terminal retention: up to {state.history.retention.days} days or {state.history.retention.terminalLimit} installation-wide records, whichever limit is reached first.</p>
      {state.history.recordingGap ? <p className="text-[var(--warning)]">Recording gap: some observations may be missing.</p> : null}
      {!state.history.operations.length ? <p>{state.history.coverage === "unavailable" ? "Journal unavailable; this does not mean no operations occurred." : "No retained operations on this page. Earlier activity may be unrecorded or pruned; new observations may not yet be persisted."}</p> : null}
      <ul className="space-y-1" aria-label="Recorded operations">
        {state.history.operations.map((item) => <li key={item.operationId}><button type="button" className="w-full rounded border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--hover)]" aria-pressed={state.selectedId === item.operationId} onClick={() => void surface.select(item.operationId)}>
          {observationLabel(item.action)} · {item.outcome} · {item.requestedAt}
        </button></li>)}
      </ul>
      <div className="flex gap-2">
        <button type="button" className="button-secondary" disabled={state.historyBusy} onClick={() => void surface.latest()}>Latest page</button>
        {state.history.nextCursor ? <button type="button" className="button-secondary" disabled={state.historyBusy} onClick={() => void surface.history(state.history!.nextCursor)}>Older operations</button> : null}
      </div>
    </> : null}
    {pending ? <p className="text-[var(--muted)]">{pollEnded ? "Automatic pending refresh paused after one minute. Refresh operations to read again." : "Pending inspection refreshes every five seconds for at most one minute while this surface is open. A pending browser request does not confirm a recorded host operation."} Idle Runtime state or HTTP success does not prove settlement.</p> : null}
    {state.detailBusy ? <p role="status">Reading selected operation…</p> : null}
    {state.detailError ? <p role="alert">{state.detailError}</p> : null}
    {state.detail ? <section aria-label="Selected operation" className="space-y-2 border-t border-[var(--border)] pt-3">
      <h4 className="font-semibold">Selected operation</h4>
      <p className="break-all font-mono">{state.selectedId}</p>
      <p className="text-[var(--muted)]">Detail captured {state.detail.capturedAt} · coverage: {state.detail.coverage}</p>
      {!operation ? <p>Selected timeline unavailable: it may be unrecorded, pruned, expired, or not yet persisted. Missing history is not proof of expiry or success.</p> : <>
        <p>{observationLabel(operation.action)} · Lifecycle outcome: <strong>{operation.outcome}</strong></p>
        <p>Request handling: {requestDispositionLabel(operation.requestDisposition)}</p>
        <p>Last confirmed stage: {operation.lastConfirmedStage ? observationLabel(operation.lastConfirmedStage) : "None recorded"}</p>
        {operation.triggerSequence !== undefined ? <TriggerLink sequence={operation.triggerSequence} loaded={loadedSequences.has(operation.triggerSequence)} onView={onViewMessage} /> : null}
        <p>Source observed {operation.observedAt} · measured elapsed {operation.elapsedMs} ms{operation.finishedAt ? ` · Finish observed ${operation.finishedAt}` : operation.closedAt ? ` · Observation closed ${operation.closedAt}; actual finish not confirmed` : " · Finish not confirmed"}</p>
        {operation.outcome === "unknown" ? <p>Final lifecycle outcome is unknown. This is not permission to retry or recover automatically.</p> : null}
        {operation.recordingGap || detail?.recordingGap || operation.eventsDropped ? <p className="text-[var(--warning)]">Incomplete timeline · {operation.eventsDropped} dropped observations. Sequence gaps are not reconstructed.</p> : null}
        {operation.bulkTarget ? <p>Bulk target handler result: {operation.bulkTarget.outcome}{operation.bulkTarget.reason ? ` (${observationLabel(operation.bulkTarget.reason)})` : ""}. This is separate from lifecycle outcome.</p> : null}
        {operation.bulk ? <div>
          <p>Bulk handler results: {operation.bulk.completed}/{operation.bulk.targets} assessed; {operation.bulk.started} started, {operation.bulk.stopped} stopped, {operation.bulk.skipped} skipped, {operation.bulk.failed} failed.</p>
          <p>{operation.bulk.unknown} lifecycle outcomes unknown (overlaps handler counts); {operation.bulk.childrenUnrecorded} children unrecorded; {operation.bulk.childrenUnavailable ?? 0} completed children unavailable, not necessarily expired.</p>
          <p>Bulk subject is the initiating human, not the agent target. Counts do not imply every target succeeded.</p>
        </div> : null}
        <label className="flex flex-wrap items-center gap-2">Timeline result filter
          <select aria-label="Timeline result filter" className="rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1" value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}>
            {["all", "started", "confirmed", "failed", "unknown", "skipped"].map((result) => <option key={result} value={result}>{result === "all" ? "All observations" : result}</option>)}
          </select>
        </label>
        <p className="text-[var(--muted)]">Filtering changes this view only, not sequence order or report contents.</p>
        {!detail?.events.some((event) => eventFilter === "all" || event.result === eventFilter) ? <p>No retained observations match this view; absence is not proof that work did not occur.</p> : null}
        <ol aria-label="Operation timeline" className="space-y-2 border-l border-[var(--border)] pl-3">
          {detail?.events.map((event, index, events) => eventFilter !== "all" && event.result !== eventFilter ? null : <li key={event.sequence}>
            {event.sequence > (events[index - 1]?.sequence ?? 0) + 1 ? <p className="text-[var(--warning)]">Sequence gap before observation #{event.sequence}</p> : null}
            <p>#{event.sequence} · {observationLabel(event.stage)} · {event.result}{event.reasonCode ? ` (${observationLabel(event.reasonCode)})` : ""}</p>
            <p className="text-[var(--muted)]">{observationLabel(event.source)} · {event.observedAt} · +{event.elapsedMs} ms</p>
            {event.triggerSequence !== undefined ? <TriggerLink sequence={event.triggerSequence} loaded={loadedSequences.has(event.triggerSequence)} onView={onViewMessage} /> : null}
          </li>)}
        </ol>
      </>}
      {state.detail.relations.map((relation) => <button key={`${relation.kind}:${relation.operationId}`} className="button-secondary mr-2" type="button" onClick={() => void surface.select(relation.operationId)}>View {relation.kind === "bulk_parent" ? "bulk parent" : "explicit cleanup relation"}</button>)}
      {state.detail.failuresUnavailable ? <p>Issue evidence unavailable; absence is not confirmed.</p> : null}
      <p className="text-[var(--muted)]">Exact targeted-trigger correlation is not causation. Other issues remain uncorrelated; timestamps alone do not link operations.</p>
      {state.detail.failures.length ? <TurnFailureDiagnostics diagnostics={state.detail.failures} loadedSequences={loadedSequences} onViewMessage={onViewMessage} /> : null}
    </section> : null}
    {state.selectedId ? <section aria-label="Diagnostic report" className="space-y-2 border-t border-[var(--border)] pt-3">
      <h4 className="font-semibold">Diagnostic report</h4>
      <p className="text-[var(--muted)]">Sanitized local JSON. Copy always requests a fresh authorized snapshot, not the preview. Nothing is published to the Conversation or saved in browser storage. Previously copied or disclosed data cannot be revoked.</p>
      <div className="flex flex-wrap gap-2">
        <button className="button-secondary" type="button" disabled={state.reportBusy} onClick={() => void surface.report()}>Preview report</button>
        <button className="button-secondary" type="button" disabled={state.reportBusy} onClick={() => void surface.report((text) => navigator.clipboard.writeText(text))}>Copy fresh report</button>
      </div>
      {state.reportBusy ? <p role="status">Reading a fresh report…</p> : null}
      {state.reportMessage ? <p role="status">{state.reportMessage}</p> : null}
      {state.preview ? <pre aria-label="Report preview" className="minu-scroll max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--border)] p-3">{state.preview}</pre> : null}
    </section> : null}
  </section>;
}
