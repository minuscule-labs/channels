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

export function turnFailureDiagnosticKey(diagnostic: LocalTurnFailureDiagnostic): string {
  return [
    diagnostic.participant.identityId,
    diagnostic.failedAt,
    diagnostic.causeCategory,
    diagnostic.elapsedMs,
    diagnostic.attemptCount,
  ].join(":");
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

export function TurnFailureDiagnostics({
  diagnostics,
  isLoading,
  unavailable,
  pendingKey,
  action,
  onOpen,
}: {
  diagnostics?: readonly LocalTurnFailureDiagnostic[];
  isLoading: boolean;
  unavailable: boolean;
  pendingKey?: string;
  action?: { key: string; status: "accepted" | "unavailable" };
  onOpen(key: string, token: string): void;
}) {
  if (isLoading) {
    return <section className="border-b border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-xs text-[var(--muted)]" aria-label="Recent turn failures">Loading recent failures…</section>;
  }
  if (unavailable) return null;
  if (!diagnostics?.length) return null;
  return (
    <section className="border-b border-[var(--border)] bg-[var(--panel)] px-4 py-3" aria-label="Recent turn failures">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold">Recent turn failures</h2>
        <span className="text-[10px] text-[var(--muted)]">Local only</span>
      </div>
      <ul className="grid gap-2">
        {diagnostics.map((diagnostic, index) => {
          const token = diagnostic.openDiagnostic.token;
          const key = turnFailureDiagnosticKey(diagnostic);
          const actionStatus = action?.key === key ? action.status : undefined;
          return (
            <li key={`${key}:${index}`} className="rounded-md border border-[var(--border)] px-3 py-2 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="font-medium">{failureLabel(diagnostic.causeCategory)} · {diagnostic.participant.displayLabel}</p>
                <time className="text-[11px] text-[var(--muted)]" dateTime={diagnostic.failedAt}>{new Date(diagnostic.failedAt).toLocaleString()}</time>
              </div>
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                {elapsedLabel(diagnostic.elapsedMs)} · {diagnostic.attemptCount} {diagnostic.attemptCount === 1 ? "attempt" : "attempts"} · {deliveryLabel(diagnostic.deliveryOutcome)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-[var(--muted)]">Recommended: {diagnostic.remediation.label}</span>
                {diagnostic.openDiagnostic.state === "available" && token ? (
                  <button
                    type="button"
                    className="button-secondary ml-auto"
                    disabled={pendingKey === key}
                    onClick={() => onOpen(key, token)}
                  >
                    {pendingKey === key ? "Opening…" : actionStatus === "accepted" ? "Diagnostic opened" : "Open diagnostic"}
                  </button>
                ) : (
                  <span className="ml-auto text-[11px] text-[var(--muted)]">
                    {diagnostic.openDiagnostic.state === "stale" ? "Stale binding" : "Diagnostic unavailable"}
                  </span>
                )}
                {actionStatus === "unavailable" ? (
                  <span className="text-[11px] text-[var(--warning)]" role="status">Diagnostic unavailable</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
