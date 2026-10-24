import type { LocalRuntimeEventCode } from "@minu/channels-control/contracts";
import type { DiagnosticSurface, DiagnosticSurfaceState } from "../lib/operation-diagnostics";

const labels: Record<LocalRuntimeEventCode, string> = {
  bridge_ready: "Runtime bridge ready",
  turn_accepted: "Turn accepted",
  turn_reused: "Existing turn reused",
  turn_rejected_conflict: "Turn rejected: conflicting input",
  turn_dispatch_requested: "Dispatch requested",
  turn_dispatch_returned: "Dispatch returned",
  turn_dispatch_failed: "Dispatch failed",
  turn_completed: "Runtime turn completed",
  turn_failed: "Runtime turn failed",
  request_rejected_busy: "Request rejected: busy",
  steer_requested: "Steering requested",
  steer_acknowledged: "Steering acknowledged",
  steer_failed: "Steering failed",
  interrupt_requested: "Interrupt requested",
  interrupt_acknowledged: "Interrupt acknowledged",
  interrupt_failed: "Interrupt failed",
  stop_requested: "Stop requested",
};
export function RecentRuntimeEvents({ state, surface }: { state: DiagnosticSurfaceState; surface: DiagnosticSurface }) {
  const blocked = state.inspectionBusy || state.reportBusy;
  const snapshot = state.runtimeEvents?.availability === "available" ? state.runtimeEvents.snapshot : undefined;
  return <section aria-label="Recent Runtime events" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Recent Runtime events</h3>
      <button type="button" className="button-secondary" aria-expanded={Boolean(state.eventsOpen)} disabled={!state.eventsOpen && blocked}
        onClick={() => state.eventsOpen ? surface.closeEvents() : void surface.openEvents()}>{state.eventsOpen ? "Hide events" : "Show events"}</button>
    </div>
    {state.eventsOpen ? <>
      <button type="button" className="button-secondary" disabled={state.eventsBusy || blocked} onClick={() => void surface.refreshEvents()}>Refresh events</button>
      {state.eventsBusy ? <p role="status">Reading events…</p> : null}
      {state.eventsError ? <p role="alert">{state.eventsError}</p> : null}
      {state.runtimeEvents?.availability === "changed" ? <p role="status">Changed during read</p> : null}
      {state.runtimeEvents?.availability === "unavailable" ? <p role="status">Unavailable</p> : null}
      {snapshot ? <>
        <dl className="text-sm">
          <div><dt className="inline font-medium">Captured: </dt><dd className="inline">{snapshot.capturedAt}</dd></div>
          <div><dt className="inline font-medium">Window since: </dt><dd className="inline">{snapshot.recordingSince}</dd></div>
          <div><dt className="inline font-medium">Events evicted: </dt><dd className="inline">{snapshot.eventsDropped}</dd></div>
        </dl>
        {snapshot.events.length ? <ol aria-label="Runtime observations" className="max-h-64 space-y-2 overflow-auto text-sm">
          {snapshot.events.map(event => <li key={event.sequence} className="flex flex-wrap gap-x-3">
            <time dateTime={event.observedAt}>{event.observedAt}</time><span>{Object.hasOwn(labels, event.code) ? labels[event.code] : "Unavailable"}</span>
          </li>)}
        </ol> : <p role="status">No retained events</p>}
      </> : null}
    </> : null}
  </section>;
}
