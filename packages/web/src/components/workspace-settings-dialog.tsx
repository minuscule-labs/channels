import type {
  LocalWorkspaceAgentConfigurationSummary,
  LocalWorkspaceConfigurationSummary,
  UpdateLocalWorkspaceAgentConfigurationInput,
} from "@minu/channels-control/contracts";
import type { Identity, Workspace, WorkspaceMember } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, LoaderCircle, Settings, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { channels, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

function ConfigurationState({ configured, label }: { configured: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]"
      data-configured={configured}
    >
      <span className={`status-dot ${configured ? "" : "opacity-30"}`} />
      {label}: {configured ? "configured" : "not configured"}
    </span>
  );
}

function WorkspaceRootForm({
  workspaceId,
  summary,
}: {
  workspaceId: string;
  summary: LocalWorkspaceConfigurationSummary;
}) {
  const queryClient = useQueryClient();
  const [rootUri, setRootUri] = useState("");
  const mutation = useMutation({
    mutationFn: () => localControl.updateWorkspaceConfiguration(workspaceId, { rootUri }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.workspaceConfiguration(workspaceId), next);
      setRootUri("");
    },
  });

  return (
    <form
      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (rootUri.trim() && !mutation.isPending) mutation.mutate();
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Workspace source</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
            The source location used when starting new agent sessions. Existing sessions are unchanged.
          </p>
        </div>
        <ConfigurationState configured={summary.rootConfigured} label="Source" />
      </div>
      <label className="mt-4 block text-xs font-medium" htmlFor={`workspace-root-${workspaceId}`}>
        {summary.rootConfigured ? "Replace source location" : "Source location"}
      </label>
      <input
        id={`workspace-root-${workspaceId}`}
        value={rootUri}
        onChange={(event) => setRootUri(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="Path or URI"
        className="settings-input mt-1.5 font-mono"
      />
      <p className="mt-1.5 text-[10px] text-[var(--muted)]">
        The saved value is never read back into this form.
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Saved</span> : null}
        <button className="button-primary" type="submit" disabled={!rootUri.trim() || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
          Save source
        </button>
      </div>
    </form>
  );
}

function AgentConfigurationForm({
  workspaceId,
  agent,
  identity,
  member,
}: {
  workspaceId: string;
  agent: LocalWorkspaceAgentConfigurationSummary;
  identity?: Identity;
  member?: WorkspaceMember;
}) {
  const queryClient = useQueryClient();
  const [runtimeAdapter, setRuntimeAdapter] = useState("");
  const [personaPrompt, setPersonaPrompt] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">(
    agent.status === "disabled" ? "disabled" : "active",
  );
  useEffect(() => {
    setStatus(agent.status === "disabled" ? "disabled" : "active");
  }, [agent.status]);
  const statusChanged = agent.status !== "unconfigured" && status !== agent.status;
  const hasUpdate = Boolean(runtimeAdapter.trim() || personaPrompt.trim() || statusChanged);
  const mutation = useMutation({
    mutationFn: (input: UpdateLocalWorkspaceAgentConfigurationInput) =>
      localControl.updateWorkspaceAgentConfiguration(workspaceId, agent.identityId, input),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.workspaceConfiguration(workspaceId), next);
      setRuntimeAdapter("");
      setPersonaPrompt("");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasUpdate || mutation.isPending) return;
    const input: UpdateLocalWorkspaceAgentConfigurationInput = {};
    if (runtimeAdapter.trim()) input.runtimeAdapter = runtimeAdapter.trim();
    if (personaPrompt.trim()) input.personaPrompt = personaPrompt;
    if (statusChanged || agent.status === "unconfigured") input.status = status;
    mutation.mutate(input);
  };
  const label = identity?.displayName ?? `@${member?.mentionHandle ?? agent.identityId}`;

  return (
    <form className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4" onSubmit={submit}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{label}</h3>
          <p className="font-mono text-[11px] text-[var(--muted)]">
            @{member?.mentionHandle ?? agent.identityId} · {agent.boundChannelCount} bound {agent.boundChannelCount === 1 ? "Channel" : "Channels"}
          </p>
        </div>
        <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          {agent.status}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ConfigurationState configured={agent.runtimeConfigured} label="Runtime" />
        <ConfigurationState configured={agent.personaConfigured} label="Persona" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          {agent.runtimeConfigured ? "Replace Runtime preference" : "Runtime preference"}
          <input
            value={runtimeAdapter}
            onChange={(event) => setRuntimeAdapter(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Example: pi"
            className="settings-input mt-1.5 font-mono"
          />
        </label>
        <label className="block text-xs font-medium">
          Configuration status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as "active" | "disabled")}
            className="settings-input mt-1.5"
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </div>
      <label className="mt-3 block text-xs font-medium">
        {agent.personaConfigured ? "Replace persona" : "Persona"}
        <textarea
          value={personaPrompt}
          onChange={(event) => setPersonaPrompt(event.target.value)}
          rows={4}
          placeholder="Stable instructions for new sessions"
          className="settings-input mt-1.5 resize-y leading-5"
        />
      </label>
      <p className="mt-1.5 text-[10px] leading-4 text-[var(--muted)]">
        Saved values are not read back. Changes apply only when starting or explicitly replacing a session.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Saved</span> : null}
        <button className="button-primary" type="submit" disabled={!hasUpdate || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
          Save agent
        </button>
      </div>
    </form>
  );
}

function AddWorkspaceParticipantForm({
  workspaceId,
  existingMembers,
}: {
  workspaceId: string;
  existingMembers: WorkspaceMember[];
}) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<Identity["type"]>("agent");
  const [displayName, setDisplayName] = useState("");
  const [mentionHandle, setMentionHandle] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const normalizedHandle = mentionHandle.trim().toLowerCase();
  const handleValid = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(mentionHandle.trim());
  const handleAvailable = !existingMembers.some(
    (member) => member.mentionHandle.toLowerCase() === normalizedHandle,
  );
  const canSubmit = Boolean(displayName.trim() && handleValid && handleAvailable);
  const mutation = useMutation({
    mutationFn: async () => {
      const identity = await channels.createIdentity({
        type,
        displayName: displayName.trim(),
      });
      const member = await channels.addWorkspaceMember(workspaceId, {
        identityId: identity.id,
        mentionHandle: normalizedHandle,
        roleLabel: roleLabel.trim() || undefined,
      });
      return { identity, member };
    },
    onSuccess: ({ identity, member }) => {
      queryClient.setQueryData<Identity[]>(queryKeys.identities(), (current = []) => [
        ...current.filter(({ id }) => id !== identity.id),
        identity,
      ]);
      queryClient.setQueryData<WorkspaceMember[]>(queryKeys.workspaceMembers(workspaceId), (current = []) => [
        ...current.filter(({ identityId }) => identityId !== member.identityId),
        member,
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfiguration(workspaceId) });
      setDisplayName("");
      setMentionHandle("");
      setRoleLabel("");
      setType("agent");
    },
  });

  return (
    <form
      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !mutation.isPending) mutation.mutate();
      }}
    >
      <div className="flex items-start gap-3">
        <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div>
          <h2 className="text-sm font-semibold">Add a Workspace participant</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
            Create a reusable identity. Add it to individual Channels through Manage participants.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          Participant type
          <select
            value={type}
            onChange={(event) => setType(event.target.value as Identity["type"])}
            className="settings-input mt-1.5"
          >
            <option value="agent">Agent</option>
            <option value="human">Human</option>
            <option value="service">Service</option>
          </select>
        </label>
        <label className="block text-xs font-medium">
          Display name
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={200}
            placeholder={type === "agent" ? "Reviewer" : "Name"}
            className="settings-input mt-1.5"
          />
        </label>
        <label className="block text-xs font-medium">
          Mention handle
          <div className="relative mt-1.5">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-xs text-[var(--muted)]">@</span>
            <input
              value={mentionHandle}
              onChange={(event) => setMentionHandle(event.target.value)}
              maxLength={63}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="reviewer"
              className="settings-input pl-7 font-mono"
            />
          </div>
          {mentionHandle && (!handleValid || !handleAvailable) ? (
            <span className="mt-1 block text-[10px] text-[var(--danger)]">
              {handleAvailable ? "Use letters, numbers, underscores, or hyphens." : "That handle is already in use."}
            </span>
          ) : null}
        </label>
        <label className="block text-xs font-medium">
          Public role <span className="font-normal text-[var(--muted)]">(optional)</span>
          <input
            value={roleLabel}
            onChange={(event) => setRoleLabel(event.target.value)}
            maxLength={100}
            placeholder={type === "agent" ? "reviewer" : "member"}
            className="settings-input mt-1.5"
          />
        </label>
      </div>
      <p className="mt-3 text-[10px] leading-4 text-[var(--muted)]">
        New agents must be configured below before they can start. Additional humans cannot sign in through the local single-human session yet.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Participant added</span> : null}
        <button className="button-primary" type="submit" disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
          Add participant
        </button>
      </div>
    </form>
  );
}

export function WorkspaceSettingsDialog({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const session = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    enabled: open,
    retry: false,
  });
  const configuration = useQuery({
    queryKey: queryKeys.workspaceConfiguration(workspace.id),
    queryFn: () => localControl.getWorkspaceConfiguration(workspace.id),
    enabled: open && session.isSuccess,
    retry: false,
  });
  const members = useQuery({
    queryKey: queryKeys.workspaceMembers(workspace.id),
    queryFn: () => channels.listWorkspaceMembers(workspace.id),
    enabled: open,
  });
  const identities = useQuery({
    queryKey: queryKeys.identities(),
    queryFn: () => channels.listIdentities(),
    enabled: open,
  });
  const identitiesById = useMemo(
    () => new Map((identities.data ?? []).map((identity) => [identity.id, identity])),
    [identities.data],
  );
  const membersById = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.identityId, member])),
    [members.data],
  );
  const currentMembership = session.data
    ? membersById.get(session.data.identityId)
    : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="icon-button inline-flex min-h-8 min-w-8"
          aria-label={`Configure Workspace ${workspace.name}`}
          title="Workspace configuration"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[71] flex max-h-[min(52rem,92vh)] w-[min(48rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">{workspace.name} configuration</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-[var(--muted)]">
                Add participants and configure agent startup without placing restricted configuration in conversations.
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button inline-flex" aria-label="Close Workspace configuration">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </header>
          <div className="minu-scroll min-h-0 flex-1 overflow-y-auto p-5">
            {currentMembership ? (
              <p className="mb-4 text-[11px] text-[var(--muted)]">
                Signed in as <strong className="font-mono text-[var(--text)]">@{currentMembership.mentionHandle}</strong> · {currentMembership.accessRole}
              </p>
            ) : null}
            {session.isPending || members.isPending || identities.isPending
              || (session.isSuccess && configuration.isPending) ? (
              <div className="empty-state"><p>Loading Workspace configuration…</p></div>
            ) : session.error || configuration.error || members.error || identities.error ? (
              <div className="empty-state">
                <h2 className="text-sm font-semibold text-[var(--text)]">Configuration unavailable</h2>
                <p>{(session.error ?? configuration.error ?? members.error ?? identities.error)?.message}</p>
                <button className="button-secondary w-fit" type="button" onClick={() => {
                  void session.refetch();
                  void configuration.refetch();
                  void members.refetch();
                  void identities.refetch();
                }}>Retry</button>
              </div>
            ) : configuration.data ? (
              <div className="space-y-4">
                <AddWorkspaceParticipantForm workspaceId={workspace.id} existingMembers={members.data ?? []} />
                <WorkspaceRootForm workspaceId={workspace.id} summary={configuration.data} />
                <section>
                  <div className="mb-2">
                    <h2 className="text-sm font-semibold">Workspace agents</h2>
                    <p className="mt-1 text-xs text-[var(--muted)]">Reusable configuration; each Channel still receives an isolated Runtime session.</p>
                  </div>
                  {configuration.data.agents.length ? (
                    <div className="space-y-3">
                      {configuration.data.agents.map((agent) => (
                        <AgentConfigurationForm
                          key={agent.identityId}
                          workspaceId={workspace.id}
                          agent={agent}
                          identity={identitiesById.get(agent.identityId)}
                          member={membersById.get(agent.identityId)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state"><p>No agents belong to this Workspace yet.</p></div>
                  )}
                </section>
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
