import type {
  LocalWorkspaceAgentConfigurationSummary,
  UpdateLocalWorkspaceAgentConfigurationInput,
} from "@minu/channels-control/contracts";
import type { Identity, WorkspaceMember } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertCircle, Bot, Check, LoaderCircle } from "lucide-react";
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

function PublicAgentProfileForm({
  workspaceId,
  actorIdentityId,
  identity,
  member,
}: {
  workspaceId: string;
  actorIdentityId: string;
  identity: Identity;
  member: WorkspaceMember;
}) {
  const queryClient = useQueryClient();
  const [mentionHandle, setMentionHandle] = useState(member.mentionHandle);
  const [roleLabel, setRoleLabel] = useState(member.roleLabel ?? "");
  const [delegationProfile, setDelegationProfile] = useState(
    member.profileOverride ?? identity.publicProfile ?? "",
  );
  useEffect(() => {
    setMentionHandle(member.mentionHandle);
    setRoleLabel(member.roleLabel ?? "");
    setDelegationProfile(member.profileOverride ?? identity.publicProfile ?? "");
  }, [identity.publicProfile, member]);
  const normalizedHandle = mentionHandle.trim().replace(/^@+/, "").toLowerCase();
  const changed = normalizedHandle !== member.mentionHandle
    || roleLabel.trim() !== (member.roleLabel ?? "")
    || delegationProfile.trim() !== (member.profileOverride ?? identity.publicProfile ?? "");
  const mutation = useMutation({
    mutationFn: () => channels.updateWorkspaceMember(workspaceId, identity.id, {
      actorIdentityId,
      mentionHandle: normalizedHandle,
      roleLabel: roleLabel.trim() || null,
      profileOverride: delegationProfile.trim() || null,
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData<WorkspaceMember[]>(queryKeys.workspaceMembers(workspaceId), (current = []) =>
        current.map((candidate) => candidate.identityId === updated.identityId ? updated : candidate));
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceChannels(workspaceId) });
    },
  });

  return (
    <form
      className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && normalizedHandle && !mutation.isPending) mutation.mutate();
      }}
    >
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Public Workspace profile</h3>
        <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">
          Visible to collaborators and supplied to agents as routing and delegation guidance.
        </p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          Mention handle
          <div className="relative mt-1.5">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-xs text-[var(--muted)]">@</span>
            <input
              value={mentionHandle}
              onChange={(event) => setMentionHandle(event.target.value.replace(/^@+/, ""))}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={63}
              className="settings-input pl-7 font-mono"
            />
          </div>
        </label>
        <label className="block text-xs font-medium">
          Public role
          <input
            value={roleLabel}
            onChange={(event) => setRoleLabel(event.target.value)}
            maxLength={100}
            placeholder="builder"
            className="settings-input mt-1.5"
          />
        </label>
      </div>
      <label className="mt-3 block text-xs font-medium">
        Delegation guidance
        <textarea
          value={delegationProfile}
          onChange={(event) => setDelegationProfile(event.target.value)}
          rows={3}
          maxLength={1_000}
          placeholder="What should collaborators ask this agent to do?"
          className="settings-input mt-1.5 resize-y leading-5"
        />
      </label>
      {!member.profileOverride && identity.publicProfile ? (
        <p className="mt-1.5 text-[10px] text-[var(--muted)]">
          Currently inherited from the global identity. Saving creates a Workspace-specific profile.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Public profile saved</span> : null}
        <button className="button-primary" type="submit" disabled={!changed || !normalizedHandle || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
          Save public profile
        </button>
      </div>
    </form>
  );
}

function AgentLaunchProfileForm({
  workspaceId,
  agent,
}: {
  workspaceId: string;
  agent: LocalWorkspaceAgentConfigurationSummary;
}) {
  const queryClient = useQueryClient();
  const [runtimeAdapter, setRuntimeAdapter] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState("");
  const [personaPrompt, setPersonaPrompt] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">(
    agent.status === "disabled" ? "disabled" : "active",
  );
  const runtimeOptions = useQuery({
    queryKey: queryKeys.agentRuntimeOptions(workspaceId, agent.identityId),
    queryFn: () => localControl.getAgentRuntimeOptions(workspaceId, agent.identityId),
    enabled: agent.runtimeConfigured,
    retry: false,
    staleTime: 60_000,
  });
  useEffect(() => setStatus(agent.status === "disabled" ? "disabled" : "active"), [agent.status]);
  const statusChanged = agent.status !== "unconfigured" && status !== agent.status;
  const selectedModel = runtimeOptions.data?.models.find(
    (model) => JSON.stringify([model.provider, model.id]) === selectedModelKey,
  );
  const hasUpdate = Boolean(
    runtimeAdapter.trim() || selectedModel || reasoningLevel || personaPrompt.trim() || statusChanged,
  );
  const mutation = useMutation({
    mutationFn: (input: UpdateLocalWorkspaceAgentConfigurationInput) =>
      localControl.updateWorkspaceAgentConfiguration(workspaceId, agent.identityId, input),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.workspaceConfiguration(workspaceId), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentRuntimeOptions(workspaceId, agent.identityId) });
      setRuntimeAdapter("");
      setSelectedModelKey("");
      setReasoningLevel("");
      setPersonaPrompt("");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasUpdate || mutation.isPending) return;
    const input: UpdateLocalWorkspaceAgentConfigurationInput = {};
    if (runtimeAdapter.trim()) input.runtimeAdapter = runtimeAdapter.trim();
    if (selectedModel) {
      input.modelProvider = selectedModel.provider;
      input.modelId = selectedModel.id;
    }
    if (reasoningLevel) {
      input.reasoningLevel = reasoningLevel as UpdateLocalWorkspaceAgentConfigurationInput["reasoningLevel"];
    }
    if (personaPrompt.trim()) input.personaPrompt = personaPrompt;
    if (statusChanged || agent.status === "unconfigured") input.status = status;
    mutation.mutate(input);
  };

  return (
    <form className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4" onSubmit={submit}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Private launch profile</h3>
          <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">
            Persona and launch selections are restricted configuration and are never read back after save.
          </p>
        </div>
        <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">{agent.status}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ConfigurationState configured={agent.runtimeConfigured} label="Runtime" />
        <ConfigurationState configured={agent.modelConfigured} label="Model" />
        <ConfigurationState configured={agent.reasoningConfigured} label="Reasoning" />
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
          <select value={status} onChange={(event) => setStatus(event.target.value as "active" | "disabled")} className="settings-input mt-1.5">
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label className="block text-xs font-medium">
          {agent.modelConfigured ? "Replace model" : "Model"}
          <select
            value={selectedModelKey}
            onChange={(event) => {
              const value = event.target.value;
              setSelectedModelKey(value);
              const model = runtimeOptions.data?.models.find(
                (candidate) => JSON.stringify([candidate.provider, candidate.id]) === value,
              );
              if (model && !model.reasoning) setReasoningLevel("off");
            }}
            className="settings-input mt-1.5"
            disabled={!runtimeOptions.data?.models.length}
          >
            <option value="">{agent.modelConfigured ? "Keep configured model" : "Use Runtime default"}</option>
            {runtimeOptions.data?.models.map((model) => (
              <option key={`${model.provider}/${model.id}`} value={JSON.stringify([model.provider, model.id])}>
                {model.name} · {model.provider}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium">
          {agent.reasoningConfigured ? "Replace reasoning" : "Reasoning"}
          <select value={reasoningLevel} onChange={(event) => setReasoningLevel(event.target.value)} className="settings-input mt-1.5" disabled={!runtimeOptions.data}>
            <option value="">{agent.reasoningConfigured ? "Keep configured level" : "Use model default"}</option>
            {runtimeOptions.data?.reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
      </div>
      {runtimeOptions.isPending ? <p className="mt-1.5 text-[10px] text-[var(--muted)]">Discovering configured Runtime models…</p> : null}
      {runtimeOptions.error ? <p className="mt-1.5 text-[10px] text-[var(--danger)]">Runtime model discovery unavailable.</p> : null}
      <label className="mt-3 block text-xs font-medium">
        {agent.personaConfigured ? "Replace persona" : "Persona"}
        <textarea value={personaPrompt} onChange={(event) => setPersonaPrompt(event.target.value)} rows={4} placeholder="Stable private instructions for new sessions" className="settings-input mt-1.5 resize-y leading-5" />
      </label>
      <p className="mt-1.5 text-[10px] leading-4 text-[var(--muted)]">
        Changes apply only when starting or explicitly replacing a session.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Launch profile saved</span> : null}
        <button className="button-primary" type="submit" disabled={!hasUpdate || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
          Save launch profile
        </button>
      </div>
    </form>
  );
}

export function AgentManagementPage() {
  const { workspaceId } = useParams({ from: "/app/workspaces/$workspaceId/agents" });
  const workspace = useQuery({ queryKey: queryKeys.workspace(workspaceId), queryFn: () => channels.getWorkspace(workspaceId) });
  const session = useQuery({ queryKey: queryKeys.localCurrentSession(), queryFn: () => localControl.currentSession(), retry: false });
  const configuration = useQuery({
    queryKey: queryKeys.workspaceConfiguration(workspaceId),
    queryFn: () => localControl.getWorkspaceConfiguration(workspaceId),
    enabled: session.isSuccess,
    retry: false,
  });
  const members = useQuery({ queryKey: queryKeys.workspaceMembers(workspaceId), queryFn: () => channels.listWorkspaceMembers(workspaceId) });
  const identities = useQuery({ queryKey: queryKeys.identities(), queryFn: () => channels.listIdentities() });
  const workspaceChannels = useQuery({ queryKey: queryKeys.workspaceChannels(workspaceId), queryFn: () => channels.listWorkspaceChannels(workspaceId) });
  const identitiesById = useMemo(() => new Map((identities.data ?? []).map((identity) => [identity.id, identity])), [identities.data]);
  const agentConfigs = useMemo(() => new Map((configuration.data?.agents ?? []).map((agent) => [agent.identityId, agent])), [configuration.data]);
  const agents = (members.data ?? []).flatMap((member) => {
    const identity = identitiesById.get(member.identityId);
    const config = agentConfigs.get(member.identityId);
    return identity && config && (identity.type === "agent" || identity.type === "service")
      ? [{ identity, member, config }]
      : [];
  });
  const error = workspace.error ?? session.error ?? configuration.error ?? members.error ?? identities.error ?? workspaceChannels.error;
  const pending = workspace.isPending || session.isPending || members.isPending || identities.isPending
    || workspaceChannels.isPending || (session.isSuccess && configuration.isPending);

  if (pending) return <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading Workspace agents…</div>;
  if (error || !workspace.data || !session.data || !configuration.data) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="empty-state max-w-lg">
          <AlertCircle className="h-5 w-5 text-[var(--danger)]" />
          <h1 className="font-semibold">Unable to open agent management</h1>
          <p>{error instanceof Error ? error.message : "Workspace agent configuration is unavailable."}</p>
        </div>
      </div>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 pl-14 md:pl-5">
        <Bot className="hidden h-4 w-4 text-[var(--accent)] sm:block" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{workspace.data.name} agents</h1>
          <p className="truncate text-[11px] text-[var(--muted)]">Public delegation profiles and private Runtime launch configuration</p>
        </div>
      </header>
      <div className="minu-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg)] p-4 md:p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          <div>
            <h2 className="text-lg font-semibold">Workspace agents</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
              Agents are reusable across Channels, while every Channel receives an isolated Runtime session.
            </p>
          </div>
          {agents.length ? agents.map(({ identity, member, config }) => {
            const assignedChannels = (workspaceChannels.data ?? []).filter((channel) =>
              channel.participants.some((participant) => participant.id === identity.id));
            return (
              <article key={identity.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 md:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="avatar shrink-0">{(identity.displayName ?? member.mentionHandle).slice(0, 1).toUpperCase()}</span>
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold">{identity.displayName ?? `@${member.mentionHandle}`}</h2>
                      <p className="truncate font-mono text-[11px] text-[var(--muted)]">@{member.mentionHandle} · {identity.type} · {member.status}</p>
                    </div>
                  </div>
                  <span className="text-[11px] text-[var(--muted)]">{config.boundChannelCount} active Runtime {config.boundChannelCount === 1 ? "binding" : "bindings"}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {assignedChannels.length
                    ? assignedChannels.map((channel) => <span key={channel.id} className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]">#{channel.name}</span>)
                    : <span className="text-[11px] text-[var(--muted)]">Not assigned to a Channel</span>}
                </div>
                <PublicAgentProfileForm workspaceId={workspaceId} actorIdentityId={session.data.identityId} identity={identity} member={member} />
                <AgentLaunchProfileForm workspaceId={workspaceId} agent={config} />
              </article>
            );
          }) : (
            <div className="empty-state"><p>No agents belong to this Workspace. Create one from Manage Channel participants.</p></div>
          )}
        </div>
      </div>
    </section>
  );
}
