import type { LocalTurnFailureDiagnostic } from "@minu/channels-control/contracts";

function elapsedLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function failureLabel(category: LocalTurnFailureDiagnostic["causeCategory"]): string {
  switch (category) {
    case "turn_timeout": return "Turn timed out";
    case "runtime_request_timeout": return "Runtime request timed out";
    case "runtime_offline": return "Runtime offline";
    case "runtime_rejected": return "Runtime rejected the turn";
    case "response_delivery_failed": return "Response delivery failed";
    case "unknown": return "Unknown Runtime failure";
  }
}

function deliveryLabel(outcome: LocalTurnFailureDiagnostic["deliveryOutcome"]): string {
  switch (outcome) {
    case "pending": return "Delivery pending";
    case "delivered": return "Delivered";
    case "delivery_rejected": return "Delivery rejected";
    case "delivery_timed_out": return "Delivery timed out";
    case "cursor_commit_failed": return "Cursor recovery required";
  }
}

export function TurnFailureDiagnostics({ diagnostics }: { diagnostics: readonly LocalTurnFailureDiagnostic[] }) {
  return (
    <section className="border-b border-[var(--border)] bg-[var(--panel)] px-4 py-3" aria-label="Issue diagnostics">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold">Issue details</h2>
        <span className="text-[10px] text-[var(--muted)]">Local only</span>
      </div>
      <ul className="grid gap-2">
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.participant.identityId}:${diagnostic.failedAt}:${index}`} className="rounded-md border border-[var(--border)] px-3 py-2 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="font-medium">{failureLabel(diagnostic.causeCategory)} · {diagnostic.participant.displayLabel}</p>
              <time className="text-[11px] text-[var(--muted)]" dateTime={diagnostic.failedAt}>{new Date(diagnostic.failedAt).toLocaleString()}</time>
            </div>
            <p className="mt-1 text-[11px] text-[var(--muted)]">
              {elapsedLabel(diagnostic.elapsedMs)} · {diagnostic.attemptCount} {diagnostic.attemptCount === 1 ? "attempt" : "attempts"} · {deliveryLabel(diagnostic.deliveryOutcome)}
            </p>
            <p className="mt-1 text-[11px] text-[var(--muted)]">Recommended: {diagnostic.remediation.label}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
