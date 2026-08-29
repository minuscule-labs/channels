import type { LocalChannelAgent } from "@minu/channels-control/contracts";
import type { Participant } from "@minu/channels-core/types";
import { LoaderCircle, Play } from "lucide-react";
import { participantLabel } from "../lib/participants";
import { shortId } from "../lib/messages";
import { DrawerCloseButton } from "./ui/drawer";

export function MemberRoster({
  participants,
  localAgents,
  localStatus = "loading",
  drawer = false,
  onStartAgent,
  startingAgentId,
}: {
  participants: Participant[];
  localAgents?: ReadonlyMap<string, LocalChannelAgent>;
  localStatus?: "loading" | "available" | "unavailable";
  drawer?: boolean;
  onStartAgent?(identityId: string): void;
  startingAgentId?: string;
}) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-[var(--border)] bg-[var(--panel)] lg:w-72">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div>
          <h2 className="text-sm font-semibold">Participants</h2>
          <p className="text-xs text-[var(--muted)]">{participants.length} in this Channel</p>
          {localStatus === "unavailable" ? (
            <p className="text-[10px] text-[var(--warning)]">Runtime status unavailable</p>
          ) : null}
        </div>
        {drawer ? <DrawerCloseButton label="Close participants" /> : null}
      </div>
      <ul className="minu-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {participants.map((participant) => {
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
                        title={`Runtime: ${localAgent.state}`}
                      >
                        runtime: {localAgent.state}
                      </span>
                    ) : null}
                    {localAgent?.capabilities.start && onStartAgent ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50"
                        disabled={startingAgentId !== undefined}
                        onClick={() => onStartAgent(participant.id)}
                        aria-label={`Start ${participantLabel(participant, participant.id)}`}
                        title="Start an isolated Runtime session for this Channel"
                      >
                        {startingAgentId === participant.id
                          ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
                          : <Play className="h-2.5 w-2.5" />}
                        Start
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
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
