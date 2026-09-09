import type { LocalChannelAgent } from "@minu/channels-control/contracts";
import type { ChannelMessage, Participant } from "@minu/channels-core/types";
import { CircleX, LoaderCircle, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { participantLabel } from "../lib/participants";
import { shortId } from "../lib/messages";
import { DrawerCloseButton } from "./ui/drawer";

function elapsedLabel(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function runtimeStateLabel(state: LocalChannelAgent["state"]): string {
  switch (state) {
    case "running": return "Running";
    case "idle": return "Idle";
    case "unbound": return "Not started";
    case "uncertain": return "Status uncertain";
    case "offline": return "Offline";
    case "disabled": return "Stopped";
  }
}

function messageSnippet(message: ChannelMessage | undefined): string | undefined {
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
  drawer = false,
  onStartAgent,
  onReplaceAgent,
  onCancelAgent,
  onStopAgent,
  pendingAgentAction,
}: {
  participants: Participant[];
  currentHumanIdentityId?: string;
  messages?: readonly ChannelMessage[];
  localAgents?: ReadonlyMap<string, LocalChannelAgent>;
  localStatus?: "loading" | "available" | "unavailable";
  drawer?: boolean;
  onStartAgent?(identityId: string): void;
  onReplaceAgent?(identityId: string): void;
  onCancelAgent?(identityId: string): void;
  onStopAgent?(identityId: string): void;
  pendingAgentAction?: { action: "start" | "replace" | "stop" | "cancel"; identityId: string };
}) {
  const [now, setNow] = useState(() => Date.now());
  const hasActivity = [...(localAgents?.values() ?? [])].some((agent) => agent.activity);
  useEffect(() => {
    if (!hasActivity) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActivity]);
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-[var(--border)] bg-[var(--panel)] lg:w-72">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div>
          <h2 className="text-sm font-semibold">Collaborators</h2>
          <p className="text-xs text-[var(--muted)]">{participants.filter(({ id }) => id !== currentHumanIdentityId).length} in this Channel</p>
          {localStatus === "unavailable" ? (
            <p className="text-[10px] text-[var(--warning)]">Runtime status unavailable</p>
          ) : null}
        </div>
        {drawer ? <DrawerCloseButton label="Close participants" /> : null}
      </div>
      <ul className="minu-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {participants.filter((participant) => participant.id !== currentHumanIdentityId).map((participant) => {
          const localAgent = localAgents?.get(participant.id);
          return (
            <li key={participant.id} className="rounded-md px-2.5 py-2 hover:bg-[var(--hover)]">
              <div className="flex items-center gap-2">
                <span className="avatar" aria-hidden="true">
                  {(participant.displayName ?? participant.handle ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{participantLabel(participant, participant.id)}</span>
                    <span
                      className={`status-dot ${participant.status === "disabled" ? "opacity-40" : ""}`}
                      title={participant.status === "disabled" ? "Disabled membership" : "Active membership"}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate font-mono text-[11px] text-[var(--muted)]">
                      @{participant.handle ?? shortId(participant.id)} · {participant.type}
                    </p>
                    {localAgent ? (
                      <span
                        className="local-agent-state"
                        data-state={localAgent.state}
                        title={`Runtime: ${runtimeStateLabel(localAgent.state)}`}
                      >
                        {runtimeStateLabel(localAgent.state)}
                      </span>
                    ) : null}
                    {localAgent?.capabilities.start && onStartAgent ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50"
                        disabled={pendingAgentAction !== undefined}
                        onClick={() => onStartAgent(participant.id)}
                        aria-label={`Start ${participantLabel(participant, participant.id)}`}
                        title="Start an isolated Runtime session for this Channel"
                      >
                        {pendingAgentAction?.action === "start" && pendingAgentAction.identityId === participant.id
                          ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                          : <Play className="h-2.5 w-2.5" />}
                        Start
                      </button>
                    ) : null}
                    {localAgent?.capabilities.replace && onReplaceAgent ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50"
                        disabled={pendingAgentAction !== undefined}
                        onClick={() => onReplaceAgent(participant.id)}
                        aria-label={`Start fresh with ${participantLabel(participant, participant.id)}`}
                        title="Start a new session with current Workspace configuration and an empty Runtime transcript"
                      >
                        {pendingAgentAction?.action === "replace" && pendingAgentAction.identityId === participant.id
                          ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                          : <RotateCcw className="h-2.5 w-2.5" />}
                        Start fresh
                      </button>
                    ) : null}
                    {localAgent?.capabilities.interrupt && onCancelAgent ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--warning)]/60 px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50"
                        disabled={pendingAgentAction !== undefined}
                        onClick={() => onCancelAgent(participant.id)}
                        aria-label={`Cancel current request for ${participantLabel(participant, participant.id)}`}
                        title="Cancel the active request and keep this agent session available"
                      >
                        {pendingAgentAction?.action === "cancel" && pendingAgentAction.identityId === participant.id
                          ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                          : <CircleX className="h-2.5 w-2.5" />}
                        Cancel current
                      </button>
                    ) : null}
                    {localAgent?.capabilities.stop && onStopAgent ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--danger)] hover:bg-[var(--hover)] disabled:opacity-50"
                        disabled={pendingAgentAction !== undefined}
                        onClick={() => onStopAgent(participant.id)}
                        aria-label={`Stop agent ${participantLabel(participant, participant.id)}`}
                        title="Disable this Channel binding and stop its Runtime process"
                      >
                        {pendingAgentAction?.action === "stop" && pendingAgentAction.identityId === participant.id
                          ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                          : <Square className="h-2.5 w-2.5" />}
                        Stop agent
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              {localAgent?.activity ? (() => {
                const trigger = messages.find((message) => message.id === localAgent.activity!.triggerMessageId);
                const author = trigger ? participants.find((participant) => participant.id === trigger.participantId) : undefined;
                const phase = localAgent.activity.phase === "retrying"
                  ? `Retrying (attempt ${localAgent.activity.retryAttempt ?? 1})`
                  : localAgent.activity.phase === "canceling" ? "Canceling…" : "Running";
                return (
                  <div className="mt-2 rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px]">
                    <p className="font-medium"><span aria-live="polite">{phase}</span> · {elapsedLabel(localAgent.activity.startedAt, now)}</p>
                    <p className="mt-1 line-clamp-2 text-[var(--muted)]">
                      #{localAgent.activity.triggerSequence} {messageSnippet(trigger)
                        ? `“${messageSnippet(trigger)}”${author ? ` — ${participantLabel(author, author.id)}` : ""}`
                        : `Message #${localAgent.activity.triggerSequence}`}
                    </p>
                    {localAgent.activity.queuedTurns > 0 ? (
                      <p className="mt-1 text-[var(--muted)]">
                        {localAgent.activity.queuedTurns} {localAgent.activity.queuedTurns === 1 ? "queued turn" : "queued turns"}
                      </p>
                    ) : null}
                  </div>
                );
              })() : null}
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
