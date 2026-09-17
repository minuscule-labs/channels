import type {
  LocalBulkAgentLifecycleResult,
  LocalConversationAgent,
  LocalLiveCapabilityState,
} from "@minu/channels-control/contracts";
import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { useEffect, useState } from "react";
import { participantLabel } from "../lib/participants";
import { shortId } from "../lib/messages";
import { queuedTurnsSummary } from "./conversation-activity-strip";
import { ParticipantActionsMenu } from "./participant-actions-menu";
import { ParticipantSessionActionsMenu } from "./participant-session-actions-menu";
import { DrawerCloseButton } from "./ui/drawer";

function elapsedLabel(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function runtimeStateLabel(agent: LocalConversationAgent): string {
  switch (agent.state) {
    case "running": return agent.activity
      && agent.diagnostics?.capabilities.safeActivityEvents === "available"
      ? "Working"
      : "Working · activity unavailable";
    case "idle": return "Idle";
    case "unbound": return "Not started";
    case "disconnected": return "Disconnected";
    case "uncertain": return "Connection uncertain";
    case "offline": return "Offline";
    case "disabled": return "Stopped";
  }
}

function liveCapabilityLabel(state: LocalLiveCapabilityState): string {
  switch (state) {
    case "available": return "Available";
    case "unavailable": return "Unavailable";
    case "not_verified": return "Not verified";
  }
}

function bulkReasonLabel(reason: LocalBulkAgentLifecycleResult["reason"]): string | undefined {
  switch (reason) {
    case "already_running": return "already running";
    case "already_idle": return "already idle";
    case "unconfigured": return "not configured";
    case "offline": return "offline";
    case "uncertain": return "status uncertain";
    case "unavailable": return "unavailable";
    case undefined: return undefined;
  }
}

function messageSnippet(message: ConversationMessage | undefined): string | undefined {
  if (!message) return undefined;
  const plainText = message.body.replace(/\s+/g, " ").trim();
  return plainText.length > 140 ? `${plainText.slice(0, 137)}…` : plainText;
}

export function MemberRoster({
  participants,
  currentHumanIdentityId,
  messages = [],
  localAgents,
  localStatus = "loading",
  showDiagnostics = false,
  drawer = false,
  onStartAgent,
  onReconnectAgent,
  onReplaceAgent,
  onCancelAgent,
  onStopAgent,
  onOpenAgentDiagnostic,
  openedDiagnosticIdentityId,
  pendingDiagnosticIdentityId,
  onStartAllAgents,
  onStopAllAgents,
  pendingAgentAction,
  pendingBulkAction,
  pendingBulkIdentityIds,
  bulkResultAction,
  bulkResults,
}: {
  participants: Participant[];
  currentHumanIdentityId?: string;
  messages?: readonly ConversationMessage[];
  localAgents?: ReadonlyMap<string, LocalConversationAgent>;
  localStatus?: "loading" | "available" | "unavailable";
  showDiagnostics?: boolean;
  drawer?: boolean;
  onStartAgent?(identityId: string): void | Promise<unknown>;
  onReconnectAgent?(identityId: string): void | Promise<unknown>;
  onReplaceAgent?(identityId: string): void | Promise<unknown>;
  onCancelAgent?(identityId: string): void | Promise<unknown>;
  onStopAgent?(identityId: string): void | Promise<unknown>;
  onOpenAgentDiagnostic?(identityId: string): void | Promise<unknown>;
  openedDiagnosticIdentityId?: string;
  pendingDiagnosticIdentityId?: string;
  onStartAllAgents?(): void;
  onStopAllAgents?(): Promise<void>;
  pendingAgentAction?: { action: "start" | "reconnect" | "replace" | "stop" | "cancel"; identityId: string };
  pendingBulkAction?: "start" | "stop";
  pendingBulkIdentityIds?: ReadonlySet<string>;
  bulkResultAction?: "start" | "stop";
  bulkResults?: readonly LocalBulkAgentLifecycleResult[];
}) {
  const [now, setNow] = useState(() => Date.now());
  const agentValues = [...(localAgents?.values() ?? [])];
  const hasActivity = agentValues.some((agent) => agent.activity);
  const startEligible = agentValues.filter(({ state }) => state === "unbound" || state === "disabled").length;
  const stopEligible = agentValues.filter(({ state }) => state === "idle" || state === "running" || state === "disconnected" || state === "offline").length;
  useEffect(() => {
    if (!hasActivity) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActivity]);
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-[var(--border)] bg-[var(--panel)] lg:w-72">
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Participants</h2>
          <p className="truncate text-xs text-[var(--muted)]">{participants.filter(({ id }) => id !== currentHumanIdentityId).length} in this Conversation</p>
          {localStatus === "unavailable" ? (
            <p className="text-[10px] text-[var(--warning)]">Runtime status unavailable</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(onStartAllAgents || onStopAllAgents) ? (
            <ParticipantActionsMenu
              startEligible={startEligible}
              stopEligible={stopEligible}
              pendingAction={pendingBulkAction}
              onStart={onStartAllAgents}
              onStop={onStopAllAgents}
            />
          ) : null}
          {drawer ? <DrawerCloseButton label="Close participants" /> : null}
        </div>
      </div>
      {bulkResults ? (
        <div role="status" className="border-b border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
          <p className="font-medium text-[var(--text)]">Bulk action complete</p>
          <ul className="mt-1 space-y-0.5">
            {bulkResults.map((result) => {
              const participant = participants.find(({ id }) => id === result.identityId);
              return (
                <li key={result.identityId}>
                  {participant ? participantLabel(participant, participant.id) : shortId(result.identityId)}: {result.outcome}
                  {result.reason ? ` (${bulkReasonLabel(result.reason)})` : ""}
                  {result.outcome === "failed" && bulkResultAction ? (
                    <button
                      type="button"
                      className="ml-1 underline underline-offset-2 hover:text-[var(--text)]"
                      onClick={() => {
                        const retry = bulkResultAction === "stop"
                          ? onStopAgent?.(result.identityId)
                          : localAgents?.get(result.identityId)?.state === "disabled"
                            ? onReplaceAgent?.(result.identityId)
                            : onStartAgent?.(result.identityId);
                        void Promise.resolve(retry).catch(() => undefined);
                      }}
                    >
                      Retry
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <ul className="minu-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {participants.filter((participant) => participant.id !== currentHumanIdentityId).map((participant) => {
          const localAgent = localAgents?.get(participant.id);
          const label = participantLabel(participant, participant.id);
          const participantPendingAction = pendingAgentAction?.identityId === participant.id
            ? pendingAgentAction.action
            : undefined;
          const trigger = localAgent?.activity
            ? messages.find((message) => message.id === localAgent.activity!.triggerMessageId)
            : undefined;
          const author = trigger
            ? participants.find((candidate) => candidate.id === trigger.participantId)
            : undefined;
          const phase = localAgent?.activity?.phase === "retrying"
            ? `Retrying (attempt ${localAgent.activity.retryAttempt ?? 1})`
            : localAgent?.activity?.phase === "canceling"
              ? "Canceling…"
              : localAgent?.activity?.phase === "using_tools"
                ? "Using tools…"
                : localAgent?.activity?.phase === "responding"
                  ? "Responding…"
                  : localAgent?.activity ? "Working…" : undefined;
          return (
            <li key={participant.id} className="rounded-lg border border-transparent px-2.5 py-2 hover:border-[var(--border)] hover:bg-[var(--hover)]">
              <div className="flex items-start gap-2">
                <span className="avatar mt-0.5" aria-hidden="true">
                  {(participant.displayName ?? participant.handle ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{label}</span>
                    <span
                      className={`status-dot shrink-0 ${participant.status === "disabled" ? "opacity-40" : ""}`}
                      title={participant.status === "disabled" ? "Disabled membership" : "Active membership"}
                    />
                  </div>
                  <p className="truncate font-mono text-[11px] text-[var(--muted)]">
                    @{participant.handle ?? shortId(participant.id)} · {participant.type}
                  </p>
                  {localAgent ? (
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                      <span
                        className="local-agent-state"
                        data-state={localAgent.state}
                        title={`Runtime: ${runtimeStateLabel(localAgent)}`}
                      >
                        {runtimeStateLabel(localAgent)}
                      </span>
                      {phase && localAgent.activity ? (
                        <span className="truncate text-[11px] text-[var(--muted)]">
                          <span aria-live="polite">{phase}</span> · {elapsedLabel(localAgent.activity.startedAt, now)}
                          {queuedTurnsSummary(localAgent.activity)
                            ? ` · ${queuedTurnsSummary(localAgent.activity)}`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {localAgent ? (
                  <ParticipantSessionActionsMenu
                    participantName={label}
                    canStart={localAgent.capabilities.start && Boolean(onStartAgent)}
                    canReconnect={localAgent.capabilities.reconnect && Boolean(onReconnectAgent)}
                    canReplace={localAgent.capabilities.replace && Boolean(onReplaceAgent)}
                    canCancel={localAgent.capabilities.interrupt && Boolean(onCancelAgent)}
                    canStop={localAgent.capabilities.stop && Boolean(onStopAgent)}
                    pendingAction={participantPendingAction}
                    disabled={pendingBulkIdentityIds?.has(participant.id)}
                    onStart={onStartAgent ? () => onStartAgent(participant.id) : undefined}
                    onReconnect={onReconnectAgent ? () => onReconnectAgent(participant.id) : undefined}
                    onReplace={onReplaceAgent ? () => onReplaceAgent(participant.id) : undefined}
                    onCancel={onCancelAgent ? () => onCancelAgent(participant.id) : undefined}
                    onStop={onStopAgent ? () => onStopAgent(participant.id) : undefined}
                  />
                ) : null}
              </div>
              {localAgent?.activity ? (
                <p className="mt-1 line-clamp-2 pl-9 text-[11px] text-[var(--muted)]">
                  #{localAgent.activity.triggerSequence} {messageSnippet(trigger)
                    ? `“${messageSnippet(trigger)}”${author ? ` — ${participantLabel(author, author.id)}` : ""}`
                    : `Message #${localAgent.activity.triggerSequence}`}
                </p>
              ) : null}
              {showDiagnostics && localAgent?.diagnostics ? (
                <details className="mt-2 pl-9 text-[11px] text-[var(--muted)]">
                  <summary className="cursor-pointer font-medium text-[var(--text)]">Diagnostics</summary>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    <dt>Connection</dt><dd>{localAgent.diagnostics.connection}</dd>
                    <dt>Queue</dt><dd>{queuedTurnsSummary(localAgent.diagnostics) || "0 queued"}</dd>
                    <dt>Last binding verification</dt><dd>{localAgent.diagnostics.lastVerifiedAt ?? "Not verified"}</dd>
                    <dt>Safe activity</dt><dd>{liveCapabilityLabel(localAgent.diagnostics.capabilities.safeActivityEvents)}</dd>
                    <dt>Interrupt</dt><dd>{liveCapabilityLabel(localAgent.diagnostics.capabilities.interrupt)}</dd>
                    <dt>Reconnect existing</dt><dd>{liveCapabilityLabel(localAgent.diagnostics.capabilities.reconnectExisting)}</dd>
                    <dt>Interactive attach</dt><dd>{liveCapabilityLabel(localAgent.diagnostics.capabilities.interactiveAttach)}</dd>
                    <dt>Open diagnostic</dt><dd>{liveCapabilityLabel(localAgent.diagnostics.capabilities.openDiagnostic)}</dd>
                    <dt>Live skill verification</dt><dd>{liveCapabilityLabel(localAgent.diagnostics.capabilities.liveSkillVerification)}</dd>
                  </dl>
                  {localAgent.diagnostics.capabilities.openDiagnostic === "available"
                    && onOpenAgentDiagnostic ? (
                      <button
                        type="button"
                        className="button-secondary mt-2"
                        disabled={pendingDiagnosticIdentityId === participant.id}
                        onClick={() => {
                          void Promise.resolve(onOpenAgentDiagnostic(participant.id)).catch(() => undefined);
                        }}
                      >
                        {pendingDiagnosticIdentityId === participant.id
                          ? "Opening…"
                          : openedDiagnosticIdentityId === participant.id
                            ? "Diagnostic opened"
                            : "Open diagnostic"}
                      </button>
                    ) : null}
                </details>
              ) : null}
              {participant.role || participant.profile ? (
                <p className="mt-2 line-clamp-3 pl-9 text-xs leading-5 text-[var(--muted)]">
                  {participant.role ? `${participant.role}${participant.profile ? " — " : ""}` : ""}
                  {participant.profile}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
