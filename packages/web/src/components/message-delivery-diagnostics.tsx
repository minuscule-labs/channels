import type { LocalAgentDeliveryTrails } from "@minu/channels-control/contracts";
import type { DiagnosticSurface, DiagnosticSurfaceState } from "../lib/operation-diagnostics";
import { TriggerLink } from "./trigger-message-link";
type Detail = NonNullable<LocalAgentDeliveryTrails["selected"]>;
const outcomes: Record<Detail["outcome"], string> = { pending: "In progress", delivered: "Reply delivered", response_reused: "Existing response acknowledged", failed: "Request failed", canceled: "Canceled", unknown: "Unknown" };
const stages: Record<Detail["events"][number]["stage"], string> = {
  eligible_observed: "Eligible message observed", processing_started: "Processing started", wake_deferred: "Wake deferred", runtime_waiting: "Runtime observed busy",
  dispatch_requested: "Dispatch requested", runtime_reused: "Existing Runtime turn observed", runtime_accepted: "Runtime turn observed", runtime_completed: "Runtime completed", runtime_failed: "Runtime failed",
  runtime_interrupted: "Runtime interrupted", retrying: "Retry observed", delivery_requested: "Response delivery requested", delivery_retrying: "Response delivery retry",
  response_committed: "Public response commit acknowledged", response_reused: "Existing public response acknowledged", cursor_committed: "Private recovery cursor committed",
  dead_letter: "Private delivery outcome recorded", observer_lost: "Observer lost",
};
const kinds = { reply: "Reply", failure_notice: "Failure notice", cancellation_notice: "Cancellation notice" };
const reasons = { delivery_rejected: "Delivery rejected", delivery_timed_out: "Delivery timed out", cursor_commit_failed: "Cursor commit failed" };
export function MessageDeliveryDiagnostics({ state, surface, loadedSequences, onViewMessage }: {
  state: DiagnosticSurfaceState; surface: DiagnosticSurface; loadedSequences: ReadonlySet<number>; onViewMessage(sequence: number): void;
}) {
  const result = state.deliveryTrails, selected = result?.selected;
  return <section aria-label="Message delivery" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Message delivery</h3>
      <button className="button-secondary" type="button" aria-expanded={Boolean(state.trailsOpen)} disabled={!state.trailsOpen && state.inspectionBusy}
        onClick={() => state.trailsOpen ? surface.closeTrails() : void surface.openTrails()}>{state.trailsOpen ? "Hide message trails" : "Show message trails"}</button>
    </div>
    {state.trailsOpen ? <>
      <button className="button-secondary" type="button" disabled={state.trailsBusy} onClick={() => void surface.latestTrails()}>Latest message trails</button>
      <button className="button-secondary ml-2" type="button" disabled={state.trailsBusy} onClick={() => void surface.refreshTrails()}>Refresh message trails</button>
      {state.trailsBusy ? <p role="status">Reading message trails…</p> : null}
      {state.trailsError ? <p role="alert">{state.trailsError}</p> : null}
      {result ? <>
        <dl className="text-sm">
          <div><dt className="inline font-medium">Captured: </dt><dd className="inline">{result.capturedAt}</dd></div>
          <div><dt className="inline font-medium">Retention days: </dt><dd className="inline">{result.retention.days}</dd></div>
          <div><dt className="inline font-medium">Completed-trail limit: </dt><dd className="inline">{result.retention.terminalLimit}</dd></div>
        </dl>
        {result.availability !== "available" ? <p role="status">{result.availability === "changed" ? "Changed during read" : "Unavailable"}</p> : <>
          {result.history?.recordingGap ? <p role="status">Recording gap</p> : null}
          {!result.history?.trails.length ? <p role="status">Not recorded</p> : <ol aria-label="Recorded message trails" className="max-h-48 space-y-1 overflow-auto">
            {result.history.trails.map(trail => <li key={trail.trailId}><button className="button-secondary" type="button" aria-pressed={selected?.trailId === trail.trailId}
              disabled={state.trailsBusy} onClick={() => void surface.selectTrail(trail.trailId)}>Message #{trail.triggerSequence} · {Object.hasOwn(outcomes, trail.outcome) ? outcomes[trail.outcome] : "Unknown"}</button></li>)}
          </ol>}
          {result.history?.nextCursor ? <button className="button-secondary" type="button" disabled={state.trailsBusy} onClick={() => void surface.moreTrails()}>Older message trails</button> : null}
          {!selected && result.history?.trails.length ? <p role="status">Not recorded</p> : null}
          {selected ? <section aria-label="Selected message delivery" className="space-y-2 border-t border-[var(--border)] pt-2">
            <h4 className="font-semibold">Message #{selected.triggerSequence} · {Object.hasOwn(outcomes, selected.outcome) ? outcomes[selected.outcome] : "Unknown"}</h4>
            {loadedSequences.has(selected.triggerSequence) ? <TriggerLink sequence={selected.triggerSequence} loaded onView={onViewMessage} /> : null}
            {selected.recordingGap ? <p role="status">Recording gap</p> : null}
            {selected.eventsDropped ? <p role="status">Clipped observations: {selected.eventsDropped}</p> : null}
            <ol aria-label="Message delivery observations" className="max-h-64 space-y-2 overflow-auto text-sm">
              {selected.events.map(event => <li key={event.sequence}>
                <p>{Object.hasOwn(stages, event.stage) ? stages[event.stage] : "Unknown"}{event.kind && Object.hasOwn(kinds, event.kind) ? ` · ${kinds[event.kind]}` : ""}{event.reason && Object.hasOwn(reasons, event.reason) ? ` · ${reasons[event.reason]}` : ""}{event.attempt ? ` · Attempt ${event.attempt}` : ""}</p>
                <p><time dateTime={event.observedAt}>{event.observedAt}</time> · +{event.elapsedMs} ms</p>
              </li>)}
            </ol>
          </section> : null}
        </>}
      </> : null}
    </> : null}
  </section>;
}
