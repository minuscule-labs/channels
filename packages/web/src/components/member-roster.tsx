import type {
  LocalBulkAgentLifecycleResult,
  LocalConversationAgent,
  LocalTurnFailureDiagnostic,
} from "@minu/channels-control/contracts";
import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { AlertCircle, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, EllipsisVertical, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { activityLabel, elapsedLabel, runtimeStateLabel, runtimeStatusTone } from "../lib/participant-status";
import { participantLabel } from "../lib/participants";
import { shortId } from "../lib/messages";
import { queuedTurnsSummary } from "./conversation-activity-strip";
import { ParticipantActionsMenu } from "./participant-actions-menu";
import { ParticipantSessionActionsMenu } from "./participant-session-actions-menu";
import { ParticipantDetailsDialog } from "./participant-details-dialog";
import { DrawerCloseButton } from "./ui/drawer";

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

export function MemberRoster({
  participants,
  currentHumanIdentityId,
  messages = [],
  localAgents,
  localStatus = "loading",
  showDiagnostics = false,
  drawer = false,
  readOnly = false,
  onStartAgent,
  onReconnectAgent,
  onReplaceAgent,
  onCancelAgent,
  onStopAgent,
  onStartAllAgents,
  onStopAllAgents,
  onDismissAgentError,
  onDismissBulkError,
  pendingAgentAction,
  pendingBulkAction,
  pendingBulkIdentityIds,
  bulkResultAction,
  bulkResults,
  bulkResultsExpanded = true,
  onToggleBulkResults,
  onDismissBulkResults,
  participantActionError,
  turnFailures,
}: {
  participants: Participant[];
  currentHumanIdentityId?: string;
  messages?: readonly ConversationMessage[];
  localAgents?: ReadonlyMap<string, LocalConversationAgent>;
  localStatus?: "loading" | "available" | "unavailable";
  showDiagnostics?: boolean;
  drawer?: boolean;
  readOnly?: boolean;
  onStartAgent?(identityId: string): void | Promise<unknown>;
  onReconnectAgent?(identityId: string): void | Promise<unknown>;
  onReplaceAgent?(identityId: string): void | Promise<unknown>;
  onCancelAgent?(identityId: string): void | Promise<unknown>;
  onStopAgent?(identityId: string): void | Promise<unknown>;
  onStartAllAgents?(): void;
  onStopAllAgents?(): Promise<void>;
  onDismissAgentError?(): void;
  onDismissBulkError?(): void;
  pendingAgentAction?: { action: "start" | "reconnect" | "replace" | "stop" | "cancel"; identityId: string };
  pendingBulkAction?: "start" | "stop";
  pendingBulkIdentityIds?: ReadonlySet<string>;
  bulkResultAction?: "start" | "stop";
  bulkResults?: readonly LocalBulkAgentLifecycleResult[];
  bulkResultsExpanded?: boolean;
  onToggleBulkResults?(): void;
  onDismissBulkResults?(): void;
  participantActionError?: { identityId: string; message: string };
  turnFailures?: readonly LocalTurnFailureDiagnostic[];
}) {
  const bulkResultsId = useId();
  const [minimized, setMinimized] = useState(() => {
    if (drawer) return false;
    try { return localStorage.getItem("minu-channels:participants-minimized") === "true"; }
    catch { return false; }
  });
  const setRosterMinimized = (value: boolean) => {
    setMinimized(value);
    try { localStorage.setItem("minu-channels:participants-minimized", String(value)); }
    catch { /* Keep the toggle usable when storage is unavailable. */ }
  };
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedParticipantId, setSelectedParticipantId] = useState<string>();
  const detailsTrigger = useRef<HTMLElement | null>(null);
  const detailsFallbackTrigger = useRef<HTMLElement | null>(null);
  const visibleParticipants = participants.filter(({ id }) => id !== currentHumanIdentityId);
  const selectedParticipant = visibleParticipants.find(({ id }) => id === selectedParticipantId);
  const openDetails = (identityId: string, trigger: HTMLElement | null) => {
    detailsTrigger.current = trigger;
    detailsFallbackTrigger.current = trigger?.closest("li")?.querySelector<HTMLElement>('button[aria-label^="Open actions for"]') ?? trigger;
    setSelectedParticipantId(identityId);
    setDetailsOpen(true);
  };
  useEffect(() => {
    if (!selectedParticipant) setDetailsOpen(false);
  }, [selectedParticipant]);
  const actionErrorFor = (identityId: string) => participantActionError?.identityId === identityId
    ? participantActionError.message
    : bulkResults?.some((result) => result.identityId === identityId && result.outcome === "failed")
      ? `Bulk ${bulkResultAction ?? "agent"} action failed.` : undefined;
  const [now, setNow] = useState(() => Date.now());
  const agentValues = [...(localAgents?.values() ?? [])];
  const hasActivity = agentValues.some((agent) => agent.activity);
  const startEligible = agentValues.filter(({ state }) => state === "unbound" || state === "disabled").length;
  const stopEligible = agentValues.filter(({ state }) => state === "idle" || state === "running" || state === "disconnected" || state === "offline").length;
  const participantActionsMenu = !readOnly && (onStartAllAgents || onStopAllAgents) ? (
    <ParticipantActionsMenu
      startEligible={startEligible}
      stopEligible={stopEligible}
      pendingAction={pendingBulkAction}
      disabled={Boolean(pendingAgentAction)}
      onStart={onStartAllAgents}
      onStop={onStopAllAgents}
      onDismissError={onDismissBulkError}
    />
  ) : null;
  useEffect(() => {
    if (!hasActivity) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActivity]);
  return (
    <aside aria-label="Participants sidebar" data-minimized={minimized} className={`flex h-full min-h-0 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)] ${drawer ? "w-full" : minimized ? "w-16" : "w-72"}`}>
      <div className={`flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] py-2 ${minimized ? "justify-center px-2" : "px-4"}`}>
        <div className={minimized ? "sr-only" : "min-w-0"}>
          <h2 className="text-sm font-semibold">Participants</h2>
          {localStatus === "unavailable" ? (
            <p className="text-[10px] text-[var(--warning)]">Runtime status unavailable</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!minimized ? participantActionsMenu : null}
          {drawer ? <DrawerCloseButton label="Close participants" /> : (
            <button type="button" className="icon-button inline-flex" aria-label={minimized ? "Expand participants" : "Minimize participants"} title={minimized ? "Expand participants" : "Minimize participants"} aria-expanded={!minimized} onClick={() => setRosterMinimized(!minimized)}>
              {minimized ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>
      {minimized && participantActionsMenu ? (
        <div className="flex shrink-0 justify-center border-b border-[var(--border)] p-1">
          {participantActionsMenu}
        </div>
      ) : null}
      {bulkResults && minimized ? (
        <button type="button" className="icon-button mx-auto my-2 inline-flex" aria-label="Show bulk results" title="Bulk action complete" onClick={() => {
          setRosterMinimized(false);
          if (!bulkResultsExpanded) onToggleBulkResults?.();
        }}>
          {bulkResults.some(({ outcome }) => outcome === "failed") ? <AlertCircle className="h-4 w-4 text-[var(--danger)]" /> : <CheckCircle className="h-4 w-4 text-[var(--success)]" />}
        </button>
      ) : null}
      {bulkResults && !minimized ? (
        <div role="status" className="border-b border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-[var(--text)]">Bulk action complete</p>
            <div className="flex shrink-0 items-center gap-1">
              {onToggleBulkResults ? (
                <button
                  type="button"
                  className="icon-button inline-flex"
                  aria-label={bulkResultsExpanded ? "Hide bulk results" : "Show bulk results"}
                  aria-expanded={bulkResultsExpanded}
                  aria-controls={bulkResultsId}
                  onClick={onToggleBulkResults}
                >
                  {bulkResultsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
              ) : null}
              {onDismissBulkResults ? (
                <button type="button" className="icon-button inline-flex" aria-label="Dismiss bulk results" title="Dismiss bulk results" onClick={onDismissBulkResults}>
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          <ul id={bulkResultsId} hidden={!bulkResultsExpanded} className="mt-1 space-y-0.5">
            {bulkResults.map((result) => {
              const participant = participants.find(({ id }) => id === result.identityId);
              return (
                <li key={result.identityId}>
                  {participant ? participantLabel(participant, participant.id) : shortId(result.identityId)}: {result.outcome}
                  {result.reason ? ` (${bulkReasonLabel(result.reason)})` : ""}
                  {!readOnly && result.outcome === "failed" && bulkResultAction ? (
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
      <ul className={`minu-scroll min-h-0 flex-1 space-y-1 overflow-y-auto ${minimized ? "p-2" : "p-3"}`}>
        {visibleParticipants.map((participant) => {
          const localAgent = localAgents?.get(participant.id);
          const label = participantLabel(participant, participant.id);
          const phase = activityLabel(localAgent);
          const status = participant.type === "agent"
            ? localAgent ? `Runtime: ${runtimeStateLabel(localAgent)}` : localStatus === "loading" ? "Runtime: Loading status" : "Runtime: Status unavailable"
            : participant.status === "disabled" ? "Disabled membership" : "Active membership";
          const tone = participant.type === "agent"
            ? runtimeStatusTone(localAgent)
            : participant.status === "disabled" ? "inactive" : "unknown";
          const actionError = actionErrorFor(participant.id);
          const dot = <span role="img" aria-label={`${label}: ${status}`} title={status} className="participant-status-dot absolute -bottom-0.5 -right-0.5 ring-2 ring-[var(--panel)]" data-tone={tone} />;
          const avatar = <span data-participant-avatar className="avatar relative h-8 w-8 shrink-0">
            <span aria-hidden="true">{(participant.displayName ?? participant.handle ?? "?").slice(0, 1).toUpperCase()}</span>{dot}
          </span>;
          return (
            <li key={participant.id} data-participant-id={participant.id} className={`relative rounded-lg border border-transparent py-2 hover:border-[var(--border)] hover:bg-[var(--hover)] ${minimized ? "flex justify-center px-0" : "px-2"}`}>
              <div className={`relative ${minimized ? "h-8 w-8" : "min-w-0"}`}>
                {renderMenu(<button type="button" className={minimized ? "avatar relative" : "flex h-8 w-full min-w-0 items-center gap-2 text-left"} aria-label={`Open actions for ${label}`} title={`${label} · ${status.replace(/^Runtime: /, "")}${phase ? ` · ${phase}` : ""}`}>
                  {avatar}
                  {!minimized ? <><span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span><EllipsisVertical aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--muted)]" /></> : null}
                </button>)}
              </div>
              {!minimized && actionError ? <button
                type="button"
                className="participant-issue-notice mt-1 flex min-h-6 items-center gap-1.5 pl-10 text-left text-[11px] font-medium hover:underline"
                aria-label={`View issue details for ${label}`}
                onClick={(event) => openDetails(participant.id, event.currentTarget)}
              >
                <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span>Participant action failed · View details</span>
              </button> : null}
              {!minimized && phase && localAgent?.activity ? <p className="mt-1 pl-10 text-[11px] text-[var(--muted)]">
                <span aria-live="polite">{phase}</span> · {elapsedLabel(localAgent.activity.startedAt, now)}{queuedTurnsSummary(localAgent.activity) ? ` · ${queuedTurnsSummary(localAgent.activity)}` : ""}
              </p> : null}
            </li>
          );
          function renderMenu(trigger: React.ReactNode) {
            return <ParticipantSessionActionsMenu
              participantName={label}
              trigger={trigger}
              onDetails={(trigger) => openDetails(participant.id, trigger)}
              replacementStartsSession={localAgent?.state === "disabled" || localAgent?.state === "offline"}
              canStart={!readOnly && Boolean(localAgent?.capabilities.start && onStartAgent)}
              canReconnect={!readOnly && Boolean(localAgent?.capabilities.reconnect && onReconnectAgent)}
              canReplace={!readOnly && Boolean(localAgent?.capabilities.replace && onReplaceAgent)}
              canCancel={!readOnly && Boolean(localAgent?.capabilities.interrupt && onCancelAgent)}
              canStop={!readOnly && Boolean(localAgent?.capabilities.stop && onStopAgent)}
              pendingAction={pendingAgentAction?.identityId === participant.id ? pendingAgentAction.action : undefined}
              disabled={Boolean(pendingAgentAction && pendingAgentAction.identityId !== participant.id) || pendingBulkIdentityIds?.has(participant.id)}
              onStart={onStartAgent ? () => onStartAgent(participant.id) : undefined}
              onReconnect={onReconnectAgent ? () => onReconnectAgent(participant.id) : undefined}
              onReplace={onReplaceAgent ? () => onReplaceAgent(participant.id) : undefined}
              onCancel={onCancelAgent ? () => onCancelAgent(participant.id) : undefined}
              onStop={onStopAgent ? () => onStopAgent(participant.id) : undefined}
              onDismissError={onDismissAgentError}
            />;
          }
        })}
      </ul>
      {selectedParticipant ? <ParticipantDetailsDialog
        participant={selectedParticipant}
        agent={localAgents?.get(selectedParticipant.id)}
        participants={participants}
        messages={messages}
        localStatus={localStatus}
        showDiagnostics={showDiagnostics}
        now={now}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = detailsTrigger.current?.isConnected ? detailsTrigger.current : detailsFallbackTrigger.current;
          if (target?.isConnected) target.focus();
        }}
        actionError={actionErrorFor(selectedParticipant.id)}
        failures={turnFailures?.filter(({ participant }) => participant.identityId === selectedParticipant.id)}
      /> : null}
    </aside>
  );
}
