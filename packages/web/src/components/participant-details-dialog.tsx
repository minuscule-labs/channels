import type { LocalConversationAgent, LocalTurnFailureNotice } from "@minu/channels-control/contracts";
import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DiagnosticBrowserScope } from "../lib/operation-diagnostics";
import { type AgentDiagnosticsSnapshot, type PendingAgentInspection } from "../lib/agent-diagnostics";
import { participantDiagnosticsHref, participantLabel } from "../lib/participants";
import { activityLabel, elapsedLabel, runtimeStateLabel } from "../lib/participant-status";
import { queuedTurnsSummary } from "./conversation-activity-strip";

export function ParticipantDetailsDialog({
  participant, agent, messages, participants, localStatus, showDiagnostics,
  open, onOpenChange, onCloseAutoFocus, actionError, actionUnconfirmed, onDismissError, pendingAction, diagnosticsSnapshot, diagnosticScope, onViewMessage, selectedIssue,
}: {
  participant: Participant;
  agent?: LocalConversationAgent;
  messages: readonly ConversationMessage[];
  participants: readonly Participant[];
  localStatus: "loading" | "available" | "unavailable";
  showDiagnostics: boolean;
  diagnosticScope?: DiagnosticBrowserScope;
  selectedIssue?: LocalTurnFailureNotice;
  onViewMessage?(sequence: number): void;
  pendingAction?: PendingAgentInspection;
  diagnosticsSnapshot?: AgentDiagnosticsSnapshot;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCloseAutoFocus(event: Event): void;
  actionError?: string;
  actionUnconfirmed?: boolean;
  onDismissError?(): void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const messageNavigation = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [open]);
  const label = participantLabel(participant, participant.id);
  const trigger = agent?.activity ? messages.find(({ id }) => id === agent.activity!.triggerMessageId) : undefined;
  const author = trigger ? participants.find(({ id }) => id === trigger.participantId) : undefined;
  const phase = activityLabel(agent);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const sequence = messageNavigation.current;
            if (sequence !== undefined) {
              event.preventDefault();
              messageNavigation.current = undefined;
              onViewMessage?.(sequence);
            } else onCloseAutoFocus(event);
          }}
          className="fixed left-1/2 top-1/2 z-[71] flex max-h-[90vh] w-[min(36rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-xl outline-none"
        >
          <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
            <Dialog.Title className="text-base font-semibold">Details for {label}</Dialog.Title>
            <Dialog.Close className="icon-button inline-flex" aria-label="Close participant details"><X className="h-4 w-4" /></Dialog.Close>
          </header>
          <div className="minu-scroll min-h-0 space-y-5 overflow-y-auto p-5 text-xs">
            <section aria-label="Participant information">
              <h3 className="font-semibold">Participant</h3>
              <p className="mt-2 font-mono text-[var(--muted)]">@{participant.handle ?? participant.id} · {participant.type}</p>
              <p className="mt-1 text-[var(--muted)]">{participant.status === "disabled" ? "Disabled membership" : "Active membership"}</p>
              {participant.role ? <p className="mt-2 font-medium">{participant.role}</p> : null}
              {participant.profile ? <p className="mt-1 whitespace-pre-wrap leading-5 text-[var(--muted)]">{participant.profile}</p> : null}
            </section>
            {pendingAction ? <section aria-label="Pending participant action">
              <h3 className="font-semibold">Pending: {pendingAction.label} · {elapsedLabel(new Date(pendingAction.requestedAt).toISOString(), now)}</h3>
            </section> : null}
            {participant.type === "agent" ? <section aria-label="Status freshness">
              <h3 className="font-semibold">Runtime</h3>
              <p className="mt-2 text-[var(--muted)]">{agent ? runtimeStateLabel(agent) : localStatus === "loading" ? "Loading status…" : "Status unavailable"}</p>
              {phase && agent?.activity ? <p className="mt-1 text-[var(--muted)]">{phase} · {elapsedLabel(agent.activity.startedAt, now)}{queuedTurnsSummary(agent.activity) ? ` · ${queuedTurnsSummary(agent.activity)}` : ""}</p> : null}
              {diagnosticsSnapshot?.receivedAt ? <time className="mt-1 block text-[var(--muted)]" dateTime={new Date(diagnosticsSnapshot.receivedAt).toISOString()}>{new Date(diagnosticsSnapshot.receivedAt).toLocaleTimeString()}</time> : null}
              {diagnosticsSnapshot?.refreshFailed ? <p role="status" className="mt-2 text-[var(--warning)]">Status refresh failed</p> : null}
              {diagnosticsSnapshot ? <button type="button" className="button-secondary mt-2" disabled={diagnosticsSnapshot.refreshing} onClick={diagnosticsSnapshot.refresh}>{diagnosticsSnapshot.refreshing ? "Refreshing status…" : "Refresh status"}</button> : null}
            </section> : null}
            {agent?.activity ? <section aria-label="Triggering message">
              <h3 className="font-semibold">Triggering message #{agent.activity.triggerSequence}</h3>
              {trigger ? <>
                <p className="mt-2 whitespace-pre-wrap break-words leading-5 text-[var(--muted)]">{trigger.body}</p>
                {author ? <p className="mt-1 text-[var(--muted)]">— {participantLabel(author, author.id)}</p> : null}
              </> : null}
            </section> : null}
            {actionError ? <section aria-label="Failed participant action" className="flex items-start justify-between gap-2">
              <div><h3 className={`font-semibold ${actionUnconfirmed ? "text-[var(--warning)]" : "text-[var(--danger)]"}`}>{actionUnconfirmed ? "Outcome unconfirmed" : "Action rejected"}</h3><p className="mt-2 break-words text-[var(--muted)]">{actionError}</p></div>
              {onDismissError ? <button type="button" className="icon-button inline-flex" aria-label={`Dismiss action notice for ${label}`} onClick={onDismissError}><X className="h-3.5 w-3.5" /></button> : null}
            </section> : null}
            {selectedIssue ? <p>Runtime issue · message #{selectedIssue.triggerSequence} · {new Date(selectedIssue.failedAt).toLocaleString()}</p> : null}
            {showDiagnostics && diagnosticScope && participant.type === "agent" ? <a className="button-secondary inline-flex items-center gap-2" href={participantDiagnosticsHref(diagnosticScope.workspaceId, diagnosticScope.conversationId, participant.id, selectedIssue)} target="_blank" rel="noopener noreferrer">Open diagnostics<ExternalLink className="h-3.5 w-3.5" /></a> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
