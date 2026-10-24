import type { DiagnosticSurface, DiagnosticSurfaceState } from "../lib/operation-diagnostics";
import { observationLabel } from "../lib/operation-diagnostics";
import { TriggerLink } from "./trigger-message-link";

export function SessionContextInspection({ state, surface, loadedSequences, onViewMessage }: {
  state: DiagnosticSurfaceState; surface: DiagnosticSurface;
  loadedSequences: ReadonlySet<number>; onViewMessage(sequence: number): void;
}) {
  const value = state.inspection;
  const recorded = value?.recorded;
  const live = value?.running.status === "available" ? value.running.profile : undefined;
  const saved = value?.saved.status === "available" ? value.saved.profile : undefined;
  return <section aria-label="Session and context" className="space-y-3 border-t border-[var(--border)] pt-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Session &amp; context</h3>
      <button className="button-secondary" type="button" disabled={state.inspectionBusy || state.reportBusy || state.eventsBusy} onClick={() => void surface.inspectSession()}>Refresh session</button>
    </div>
    <p className="text-[var(--muted)]">Read-only snapshots. Refresh does not send a message, start or resume a worker, or read prompts, transcripts or logs.</p>
    {state.inspectionBusy ? <p role="status">Reading session metadata…</p> : null}
    {state.inspectionError ? <p role="alert">{state.inspectionError}</p> : null}
    {value ? <>
      <p className="text-[var(--muted)]">Inspection captured {value.capturedAt} · {value.availability === "changed" ? "Session changed during read; earlier evidence was discarded." : value.availability === "unbound" ? "No current binding." : value.availability === "conflict" ? "Conflicting bindings; no current session is asserted." : value.availability === "legacy" ? "Legacy/unmapped session; context and live profile are not verified." : `Metadata: ${value.availability}.`}</p>
      <section aria-label="Recorded activation and context" className="space-y-1">
        <h4 className="font-semibold">Recorded activation &amp; context</h4>
        {recorded ? <>
          <p>Recorded activation origin: {observationLabel(recorded.origin)}</p>
          <p>Recorded binding state: {recorded.bindingState} (not fresh Runtime liveness evidence)</p>
          {recorded.adapter ? <p>Recorded adapter: {recorded.adapter}</p> : null}
          {recorded.activatedAt ? <p>Activation recorded {recorded.activatedAt}</p> : null}
          <p>Recorded context policy: {recorded.contextMode === "fresh" ? "Fresh" : recorded.contextMode === "with_context" ? "With context" : "Not verified"}</p>
          {recorded.activationSequence !== undefined ? <>
            <p>Activation boundary: public sequence #{recorded.activationSequence}{recorded.contextMode === "fresh" ? "; host policy excludes Conversation messages through this boundary." : "; this is not a Stop boundary."}</p>
            {recorded.activationSequence > 0 ? <TriggerLink kind="activation" sequence={recorded.activationSequence} loaded={loadedSequences.has(recorded.activationSequence)} onView={onViewMessage} /> : null}
          </> : <p>Activation boundary: Not recorded</p>}
        </> : <p>Current activation evidence unavailable.</p>}
        <p className="text-[var(--muted)]">Activation origin is not the latest Start action. Context policy does not reconstruct any turn’s actual prompt.</p>
        <p>Latest Start behavior: Not verified</p><p>Last Stop boundary: Not recorded (delivery progress is not a Stop boundary)</p>
      </section>
      <section aria-label="Observed running profile" className="space-y-1">
        <h4 className="font-semibold">Observed running profile</h4>
        {live ? <p className="text-[var(--muted)]">Observed through the existing worker · captured {live.capturedAt}</p> : <p>Not verified — this adapter/session did not provide usable live evidence. Saved settings are not substituted.</p>}
        <p>Current model: {live?.model.status === "verified" ? `${live.model.provider}/${live.model.id} (verified)` : "Not verified"}</p>
        <p>Current reasoning: {live?.reasoning.status === "verified" ? `${live.reasoning.level} (verified)` : "Not verified"}</p>
        <p>Available skill commands: {live?.skills.status === "verified" ? `${live.skills.commandIds.join(", ") || (live.skills.complete ? "None" : "No verified identifiers")}${live.skills.complete ? " (verified)" : " (partial evidence)"}` : "Not verified"}</p>
        <p className="text-[var(--muted)]">Available commands are not evidence that skill instructions were loaded or used in a turn.</p>
      </section>
      <section aria-label="Saved future session settings" className="space-y-1">
        <h4 className="font-semibold">Saved settings for future new sessions</h4>
        {saved ? <>
          {saved.updatedAt ? <p className="text-[var(--muted)]">Settings updated {saved.updatedAt}</p> : null}
          <p>Saved adapter: {saved.adapter ?? "Not configured"}</p>
          <p>Saved model: {saved.model ? `${saved.model.provider}/${saved.model.id}` : "Adapter defaults — not resolved by this read"}</p>
          <p>Saved reasoning: {saved.reasoningLevel ?? "Adapter defaults — not resolved by this read"}</p>
          <p>Saved skill selection: {saved.skills.selection === "default" ? "Adapter defaults — not resolved by this read" : saved.skills.ids.join(", ") || (saved.skills.complete ? "Explicitly no skills" : "No verified identifiers shown")}{saved.skills.complete ? "" : " (partial selection shown)"}</p>
        </> : <p>{value.saved.status === "unconfigured" ? "No saved agent configuration." : "Saved settings unavailable."}</p>}
        <p className="text-[var(--muted)]">These launch settings are not the running profile. Resuming a stopped managed session reuses it; changed launch settings apply to a future new session.</p>
      </section>
      {saved ? <section aria-label="Saved host context limits" className="space-y-1">
        <h4 className="font-semibold">Saved host context limits — not verified as applied</h4>
        <p>Saved recent-context limits: {saved.recentContextMessages ?? "default"} messages · {saved.recentContextTokens ?? "default"} tokens</p>
        <p>Saved handoff summary budget: {saved.handoffSummaryTokens ?? "default"} tokens when a new activation requests a summary</p>
        <p className="text-[var(--muted)]">Relay reads recent-context limits when attaching. Stop/Start can refresh those host limits without changing the Runtime model, reasoning or skills. This read does not verify the currently applied limits or reconstruct turn context.</p>
      </section> : null}
    </> : null}
  </section>;
}
