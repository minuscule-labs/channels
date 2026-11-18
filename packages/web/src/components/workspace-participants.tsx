import type { Identity, WorkspaceMember } from "@minu/channels-core/types";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useMemo } from "react";
import { conversations, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { isConversationParticipantChoice } from "../lib/participants";

export interface WorkspaceParticipant {
  identity: Identity;
  member: WorkspaceMember;
}

export function useWorkspaceParticipants(workspaceId: string, open: boolean) {
  const session = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    enabled: open,
    retry: false,
  });
  const members = useQuery({
    queryKey: queryKeys.workspaceMembers(workspaceId),
    queryFn: () => conversations.listWorkspaceMembers(workspaceId),
    enabled: open,
  });
  const identities = useQuery({
    queryKey: queryKeys.identities(),
    queryFn: () => conversations.listIdentities(),
    enabled: open,
  });
  const participants = useMemo<WorkspaceParticipant[]>(() => {
    const identitiesById = new Map((identities.data ?? []).map((identity) => [identity.id, identity]));
    return (members.data ?? []).flatMap((member) => {
      const identity = identitiesById.get(member.identityId);
      return identity ? [{ identity, member }] : [];
    });
  }, [identities.data, members.data]);
  const currentMembership = session.data
    ? participants.find(({ member }) => member.identityId === session.data.identityId)?.member
    : undefined;
  const canAdminister = currentMembership?.status === "active"
    && (currentMembership.accessRole === "owner" || currentMembership.accessRole === "admin");
  return {
    session,
    members,
    identities,
    participants,
    currentMembership,
    canAdminister,
    pending: session.isPending || members.isPending || identities.isPending,
    error: session.error ?? members.error ?? identities.error,
  };
}

export function ParticipantChoices({
  participants,
  selected,
  currentHumanIdentityId,
  existingParticipantIds,
  onToggle,
  showHeading = true,
  minimal = false,
}: {
  showHeading?: boolean;
  minimal?: boolean;
  participants: WorkspaceParticipant[];
  selected: Set<string>;
  currentHumanIdentityId?: string;
  existingParticipantIds?: ReadonlySet<string>;
  onToggle(identityId: string): void;
}) {
  const choices = participants.filter(({ identity }) =>
    isConversationParticipantChoice(identity, currentHumanIdentityId, existingParticipantIds));
  return (
    <fieldset>
      <legend className={showHeading ? "text-xs font-medium" : "sr-only"}>Participants</legend>
      {!minimal ? <p className="mt-1 text-[11px] leading-4 text-[var(--muted)]">
        Choose existing Workspace agents. You are included automatically, and existing participants remain editable.
      </p> : null}
      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2">
        {choices.map(({ identity, member }) => {
          const available = identity.status === "active" && member.status === "active";
          const isCurrentHuman = identity.id === currentHumanIdentityId;
          return (
            <label
              key={identity.id}
              className={`flex items-center gap-3 rounded-md px-2.5 py-2 ${available && !isCurrentHuman ? "cursor-pointer hover:bg-[var(--hover)]" : ""} ${!available ? "opacity-50" : ""}`}
            >
              {isCurrentHuman ? (
                <span className="grid h-4 w-4 place-items-center text-[var(--success)]" aria-hidden="true"><Check className="h-3.5 w-3.5" /></span>
              ) : (
                <input
                  type="checkbox"
                  checked={selected.has(identity.id)}
                  disabled={!available}
                  onChange={() => onToggle(identity.id)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
              )}
              <span className="avatar" aria-hidden="true">
                {(identity.displayName ?? member.mentionHandle).slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{identity.displayName ?? `@${member.mentionHandle}`}</span>
                <span className="block truncate font-mono text-[11px] text-[var(--muted)]">
                  @{member.mentionHandle} · {identity.type}{!minimal && member.roleLabel ? ` · ${member.roleLabel}` : ""}
                </span>
                {isCurrentHuman ? <span className="mt-1 block text-[10px] text-[var(--muted)]">You are included automatically.</span> : null}
              </span>
              {!available ? <span className="text-[10px] uppercase text-[var(--muted)]">disabled</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
