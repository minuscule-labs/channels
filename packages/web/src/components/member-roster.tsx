import type { Participant } from "@minu/channels-core/types";
import { participantLabel } from "../lib/participants";
import { shortId } from "../lib/messages";
import { DrawerCloseButton } from "./ui/drawer";

export function MemberRoster({ participants, drawer = false }: { participants: Participant[]; drawer?: boolean }) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-[var(--border)] bg-[var(--panel)] lg:w-72">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div>
          <h2 className="text-sm font-semibold">Participants</h2>
          <p className="text-xs text-[var(--muted)]">{participants.length} in this Channel</p>
        </div>
        {drawer ? <DrawerCloseButton label="Close participants" /> : null}
      </div>
      <ul className="minu-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {participants.map((participant) => (
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
                <p className="truncate font-mono text-[11px] text-[var(--muted)]">
                  @{participant.handle ?? shortId(participant.id)} · {participant.type}
                </p>
              </div>
            </div>
            {participant.role || participant.profile ? (
              <p className="mt-2 line-clamp-3 pl-9 text-xs leading-5 text-[var(--muted)]">
                {participant.role ? `${participant.role}${participant.profile ? " — " : ""}` : ""}
                {participant.profile}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}
