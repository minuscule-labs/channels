import type {
  ChannelMetadata,
  Identity,
  Workspace,
  WorkspaceMember,
} from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, LoaderCircle, Plus, UserRoundCog, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { channels, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { AddWorkspaceParticipantForm } from "./add-workspace-participant-form";

interface WorkspaceParticipant {
  identity: Identity;
  member: WorkspaceMember;
}

function useWorkspaceParticipants(workspaceId: string, open: boolean) {
  const session = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    enabled: open,
    retry: false,
  });
  const members = useQuery({
    queryKey: queryKeys.workspaceMembers(workspaceId),
    queryFn: () => channels.listWorkspaceMembers(workspaceId),
    enabled: open,
  });
  const identities = useQuery({
    queryKey: queryKeys.identities(),
    queryFn: () => channels.listIdentities(),
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

function ParticipantChoices({
  participants,
  selected,
  currentHumanIdentityId,
  onToggle,
}: {
  participants: WorkspaceParticipant[];
  selected: Set<string>;
  currentHumanIdentityId?: string;
  onToggle(identityId: string): void;
}) {
  return (
    <fieldset>
      <legend className="text-xs font-medium">Participants</legend>
      <p className="mt-1 text-[11px] leading-4 text-[var(--muted)]">
        Select active Workspace members. Agents receive an isolated Runtime session for this Channel when bound.
      </p>
      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2">
        {participants.map(({ identity, member }) => {
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
                  @{member.mentionHandle} · {identity.type}{member.roleLabel ? ` · ${member.roleLabel}` : ""}
                </span>
              </span>
              {isCurrentHuman ? <span className="text-[10px] text-[var(--muted)]">You are included automatically.</span> : null}
              {!available ? <span className="text-[10px] uppercase text-[var(--muted)]">disabled</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function AdministrationDialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[71] flex max-h-[min(46rem,94vh)] w-[min(36rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-[var(--muted)]">{description}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button inline-flex" aria-label={`Close ${title}`}>
              <X className="h-4 w-4" />
            </Dialog.Close>
          </header>
          <div className="minu-scroll min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function QueryState({
  pending,
  error,
  canAdminister,
  children,
}: {
  pending: boolean;
  error: Error | null;
  canAdminister: boolean | undefined;
  children: ReactNode;
}) {
  if (pending) return <div className="empty-state"><p>Loading Workspace members…</p></div>;
  if (error) return <div className="empty-state"><p>{error.message}</p></div>;
  if (!canAdminister) {
    return (
      <div className="empty-state">
        <h2 className="text-sm font-semibold text-[var(--text)]">Administration unavailable</h2>
        <p>An active Workspace owner or admin is required.</p>
      </div>
    );
  }
  return children;
}

export function CreateChannelDialog({
  workspace,
  onNavigate,
}: {
  workspace: Workspace;
  onNavigate?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initializedFor, setInitializedFor] = useState<string>();
  const data = useWorkspaceParticipants(workspace.id, open);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) {
      setInitializedFor(undefined);
      return;
    }
    const identityId = data.session.data?.identityId;
    if (identityId && initializedFor !== identityId) {
      const current = data.participants.find(({ identity }) => identity.id === identityId);
      setSelected(current && current.member.status === "active" ? new Set([identityId]) : new Set());
      setInitializedFor(identityId);
    }
  }, [data.participants, data.session.data?.identityId, initializedFor, open]);
  const mutation = useMutation({
    mutationFn: () => channels.createChannel({
      workspaceId: workspace.id,
      name: name.trim(),
      participantIds: [...new Set([...selected, data.session.data!.identityId])],
      actorIdentityId: data.session.data!.identityId,
    }),
    onSuccess: (channel) => {
      queryClient.setQueryData<ChannelMetadata[]>(
        queryKeys.workspaceChannels(workspace.id),
        (current = []) => [...current.filter(({ id }) => id !== channel.id), channel],
      );
      queryClient.setQueryData(queryKeys.channel(channel.id), channel);
      setName("");
      setSelected(new Set());
      setOpen(false);
      onNavigate?.();
      void navigate({
        to: "/app/workspaces/$workspaceId/channels/$channelId",
        params: { workspaceId: workspace.id, channelId: channel.id },
      });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && selected.size > 0 && data.session.data && !mutation.isPending) mutation.mutate();
  };

  return (
    <AdministrationDialog
      open={open}
      onOpenChange={setOpen}
      title={`Create a Channel in ${workspace.name}`}
      description="Name the conversation and choose its initial participants."
      trigger={(
        <button type="button" className="icon-button inline-flex min-h-8 min-w-8" aria-label={`Create Channel in ${workspace.name}`} title="Create Channel">
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    >
      <QueryState pending={data.pending} error={data.error} canAdminister={data.canAdminister}>
        <form className="space-y-5" onSubmit={submit}>
          <label className="block text-xs font-medium">
            Channel name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              autoFocus
              placeholder="implementation"
              className="settings-input mt-1.5"
            />
          </label>
          <ParticipantChoices
            participants={data.participants}
            selected={selected}
            currentHumanIdentityId={data.session.data?.identityId}
            onToggle={(identityId) => setSelected((current) => {
              const next = new Set(current);
              if (next.has(identityId)) next.delete(identityId);
              else next.add(identityId);
              return next;
            })}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
            <Dialog.Close asChild><button className="button-secondary" type="button">Cancel</button></Dialog.Close>
            <button className="button-primary" type="submit" disabled={!name.trim() || selected.size === 0 || mutation.isPending}>
              {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Create Channel
            </button>
          </div>
        </form>
      </QueryState>
    </AdministrationDialog>
  );
}

export function EditChannelParticipantsDialog({ channel }: { channel: ChannelMetadata }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(channel.name);
  const [selected, setSelected] = useState<Set<string>>(new Set(channel.participants.map(({ id }) => id)));
  const data = useWorkspaceParticipants(channel.workspaceId, open);
  const queryClient = useQueryClient();
  const renameMutation = useMutation({
    mutationFn: () => channels.updateChannel(channel.id, {
      actorIdentityId: data.session.data!.identityId,
      name: name.trim(),
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.channel(channel.id), updated);
      queryClient.setQueryData<ChannelMetadata[]>(
        queryKeys.workspaceChannels(channel.workspaceId),
        (current = []) => current.map((candidate) => candidate.id === updated.id ? updated : candidate),
      );
      setName(updated.name);
    },
  });
  const mutation = useMutation({
    mutationFn: () => channels.updateChannelParticipants(channel.id, {
      actorIdentityId: data.session.data!.identityId,
      participantIds: [...new Set([...selected, data.session.data!.identityId])],
      expectedRosterRevision: channel.rosterRevision,
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.channel(channel.id), updated);
      queryClient.setQueryData<ChannelMetadata[]>(
        queryKeys.workspaceChannels(channel.workspaceId),
        (current = []) => current.map((candidate) => candidate.id === updated.id ? updated : candidate),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.localChannelAgents(channel.id) });
      setOpen(false);
    },
  });
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setName(channel.name);
      setSelected(new Set([
        ...channel.participants.filter(({ status }) => status === "active").map(({ id }) => id),
        ...(data.session.data ? [data.session.data.identityId] : []),
      ]));
      renameMutation.reset();
      mutation.reset();
    }
  };

  return (
    <AdministrationDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`Manage #${channel.name}`}
      description={`Choose participants for roster revision ${channel.rosterRevision + 1}. Historical messages retain their author identity.`}
      trigger={(
        <button type="button" className="icon-button inline-flex" aria-label="Manage Channel participants" title="Manage participants">
          <UserRoundCog className="h-4 w-4" />
        </button>
      )}
    >
      <QueryState pending={data.pending} error={data.error} canAdminister={data.canAdminister}>
        <div className="space-y-5">
          <form
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && name.trim() !== channel.name && data.session.data && !renameMutation.isPending) {
                renameMutation.mutate();
              }
            }}
          >
            <label className="block text-xs font-medium">
              Channel name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                className="settings-input mt-1.5"
              />
            </label>
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {renameMutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{renameMutation.error.message}</span> : null}
              {renameMutation.isSuccess && name === channel.name ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Name saved</span> : null}
              <button
                className="button-secondary"
                type="submit"
                disabled={!name.trim() || name.trim() === channel.name || renameMutation.isPending}
              >
                {renameMutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                Save name
              </button>
            </div>
          </form>
          <ParticipantChoices
            participants={data.participants}
            selected={selected}
            currentHumanIdentityId={data.session.data?.identityId}
            onToggle={(identityId) => setSelected((current) => {
              const next = new Set(current);
              if (next.has(identityId)) next.delete(identityId);
              else next.add(identityId);
              return next;
            })}
          />
          <AddWorkspaceParticipantForm
            workspaceId={channel.workspaceId}
            existingMembers={data.members.data ?? []}
            onCreated={(identity) => setSelected((current) => new Set([...current, identity.id]))}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {mutation.error ? (
              <span className="mr-auto text-xs text-[var(--danger)]">
                {mutation.error.message}
                {/reload and retry/i.test(mutation.error.message) ? (
                  <button
                    className="ml-2 underline"
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      void queryClient.invalidateQueries({ queryKey: queryKeys.channel(channel.id) });
                    }}
                  >Reload roster</button>
                ) : null}
              </span>
            ) : null}
            {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Saved</span> : null}
            <Dialog.Close asChild><button className="button-secondary" type="button">Cancel</button></Dialog.Close>
            <button
              className="button-primary"
              type="button"
              disabled={selected.size === 0 || mutation.isPending}
              onClick={() => {
                if (selected.size > 0 && data.session.data && !mutation.isPending) mutation.mutate();
              }}
            >
              {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
              Save participants
            </button>
          </div>
        </div>
      </QueryState>
    </AdministrationDialog>
  );
}
