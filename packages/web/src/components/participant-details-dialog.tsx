import type { LocalConversationAgent, LocalTurnFailureDiagnostic } from "@minu/channels-control/contracts";
import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { participantLabel } from "../lib/participants";
import { activityLabel, elapsedLabel, liveCapabilityLabel, runtimeStateLabel } from "../lib/participant-status";
import { queuedTurnsSummary } from "./conversation-activity-strip";
import { TurnFailureDiagnostics } from "./turn-failure-diagnostics";

export function ParticipantDetailsDialog({
  participant, agent, messages, participants, localStatus, showDiagnostics, now,
  open, onOpenChange, onCloseAutoFocus, actionError, failures,
}: {
  participant: Participant;
  agent?: LocalConversationAgent;
  messages: readonly ConversationMessage[];
  participants: readonly Participant[];
  localStatus: "loading" | "available" | "unavailable";
  showDiagnostics: boolean;
  now: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCloseAutoFocus(event: Event): void;
  actionError?: string;
  failures?: readonly LocalTurnFailureDiagnostic[];
}) {
  const label = participantLabel(participant, participant.id);
  const trigger = agent?.activity ? messages.find(({ id }) => id === agent.activity!.triggerMessageId) : undefined;
  const author = trigger ? participants.find(({ id }) => id === trigger.participantId) : undefined;
  const phase = activityLabel(agent);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-[71] flex max-h-[90vh] w-[min(36rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-xl outline-none"
        >
          <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">Details for {label}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-[var(--muted)]">Participant information and available local diagnostics.</Dialog.Description>
            </div>
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
            {participant.type === "agent" ? (
              <section aria-label="Runtime details">
                <h3 className="font-semibold">Runtime</h3>
                <p className="mt-2 text-[var(--muted)]">{agent ? runtimeStateLabel(agent) : localStatus === "loading" ? "Loading Runtime status…" : "Runtime status unavailable"}</p>
                {phase && agent?.activity ? <p className="mt-1 text-[var(--muted)]">{phase} · {elapsedLabel(agent.activity.startedAt, now)}{queuedTurnsSummary(agent.activity) ? ` · ${queuedTurnsSummary(agent.activity)}` : ""}</p> : null}
                {agent?.wakePolicy ? <p className="mt-1 text-[var(--muted)]">Wake policy: {agent.wakePolicy}</p> : null}
              </section>
            ) : null}
            {agent?.activity ? (
              <section aria-label="Triggering message">
                <h3 className="font-semibold">Triggering message #{agent.activity.triggerSequence}</h3>
                {trigger ? <>
                  <p className="mt-2 whitespace-pre-wrap break-words leading-5 text-[var(--muted)]">{trigger.body}</p>
                  {author ? <p className="mt-1 text-[var(--muted)]">— {participantLabel(author, author.id)}</p> : null}
                </> : <p className="mt-2 text-[var(--muted)]">Message is not in the loaded history.</p>}
              </section>
            ) : null}
            {showDiagnostics && agent?.diagnostics ? (
              <section aria-label="Participant diagnostics">
                <h3 className="font-semibold">Diagnostics</h3>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--muted)]">
                  <dt>Connection</dt><dd>{agent.diagnostics.connection}</dd>
                  <dt>Queue</dt><dd>{queuedTurnsSummary(agent.diagnostics) || "0 queued"}</dd>
                  <dt>Last binding verification</dt><dd>{agent.diagnostics.lastVerifiedAt ?? "Not verified"}</dd>
                  <dt>Safe activity</dt><dd>{liveCapabilityLabel(agent.diagnostics.capabilities.safeActivityEvents)}</dd>
                  <dt>Interrupt</dt><dd>{liveCapabilityLabel(agent.diagnostics.capabilities.interrupt)}</dd>
                  <dt>Reconnect existing</dt><dd>{liveCapabilityLabel(agent.diagnostics.capabilities.reconnectExisting)}</dd>
                  <dt>Interactive attach</dt><dd>{liveCapabilityLabel(agent.diagnostics.capabilities.interactiveAttach)}</dd>
                  <dt>Live skill verification</dt><dd>{liveCapabilityLabel(agent.diagnostics.capabilities.liveSkillVerification)}</dd>
                </dl>
              </section>
            ) : null}
            {actionError ? <section aria-label="Failed participant action"><h3 className="font-semibold text-[var(--danger)]">Last action failed</h3><p className="mt-2 break-words text-[var(--muted)]">{actionError}</p></section> : null}
            {failures?.length ? <TurnFailureDiagnostics diagnostics={failures} /> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
