import type {
  LocalWorkspaceAgentConfigurationSummary,
  UpdateLocalWorkspaceAgentConfigurationInput,
} from "@minu/channels-control/contracts";
import type { Identity, WorkspaceMember } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, ArrowLeft, Bot, Check, ChevronRight, LoaderCircle, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { channels, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { AddWorkspaceParticipantForm } from "./add-workspace-participant-form";

function modelKey(model: { provider: string; id: string }): string {
  return JSON.stringify([model.provider, model.id]);
}

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

function AgentIdentityForm({
  workspaceId,
  actorIdentityId,
  member,
}: {
  workspaceId: string;
  actorIdentityId: string;
  member: WorkspaceMember;
}) {
  const queryClient = useQueryClient();
  const [mentionHandle, setMentionHandle] = useState(member.mentionHandle);
  useEffect(() => setMentionHandle(member.mentionHandle), [member.mentionHandle]);
  const normalizedHandle = mentionHandle.trim().replace(/^@+/, "").toLowerCase();
  const changed = normalizedHandle !== member.mentionHandle;
  const mutation = useMutation({
    mutationFn: () => channels.updateWorkspaceMember(workspaceId, member.identityId, {
      actorIdentityId,
      mentionHandle: normalizedHandle,
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Identity</h3>
        <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">The name identifies the agent; the handle is used for mentions.</p>
      </div>
      <label className="mt-3 block text-xs font-medium">
        Mention handle
        <div className="mt-1.5">
          <input
            value={mentionHandle}
            onChange={(event) => setMentionHandle(event.target.value.replace(/^@+/, ""))}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={63}
            className="settings-input font-mono"
          />
        </div>
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Identity saved</span> : null}
        <button className="button-primary" type="submit" disabled={!changed || !normalizedHandle || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
          Save identity
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
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState("");
  const [personaPrompt, setPersonaPrompt] = useState("");
  const [skillIds, setSkillIds] = useState<string[] | null>(null);
  const [enabledModelKeys, setEnabledModelKeys] = useState<string[] | null>(null);
  const [status, setStatus] = useState<"active" | "disabled">(
    agent.status === "disabled" ? "disabled" : "active",
  );
  const configuredRuntimeOptions = useQuery({
    queryKey: queryKeys.agentRuntimeOptions(workspaceId, agent.identityId),
    queryFn: () => localControl.getAgentRuntimeOptions(workspaceId, agent.identityId),
    enabled: agent.runtimeConfigured,
    retry: false,
    staleTime: 60_000,
  });
  const replacementRuntimeOptions = useQuery({
    queryKey: queryKeys.workspaceRuntimeOptions(workspaceId, runtimeAdapter.trim()),
    queryFn: () => localControl.getWorkspaceRuntimeOptions(workspaceId, runtimeAdapter.trim()),
    enabled: /^[a-zA-Z0-9._-]+$/.test(runtimeAdapter.trim()),
    retry: false,
    staleTime: 60_000,
  });
  const runtimeOptions = runtimeAdapter.trim() ? replacementRuntimeOptions : configuredRuntimeOptions;
  useEffect(() => setStatus(agent.status === "disabled" ? "disabled" : "active"), [agent.status]);
  useEffect(() => {
    if (configuredRuntimeOptions.data) {
      setEnabledModelKeys(configuredRuntimeOptions.data.models.filter((model) => model.enabled).map(modelKey));
      setSkillIds(configuredRuntimeOptions.data.skillSelectionConfigured
        ? [...configuredRuntimeOptions.data.selectedSkillIds]
        : null);
    }
  }, [configuredRuntimeOptions.data]);
  const savedEnabledModelKeys = configuredRuntimeOptions.data?.models.filter((model) => model.enabled).map(modelKey) ?? [];
  const modelPolicyChanged = enabledModelKeys !== null
    && JSON.stringify([...enabledModelKeys].sort()) !== JSON.stringify([...savedEnabledModelKeys].sort());
  const statusChanged = agent.status !== "unconfigured" && status !== agent.status;
  const savedSkillIds = configuredRuntimeOptions.data?.skillSelectionConfigured
    ? configuredRuntimeOptions.data.selectedSkillIds
    : configuredRuntimeOptions.data?.skills.map(({ id }) => id) ?? [];
  const skillsChanged = skillIds !== null && configuredRuntimeOptions.data !== undefined
    && JSON.stringify([...skillIds].sort()) !== JSON.stringify([...savedSkillIds].sort());
  const providers = [...new Set(runtimeOptions.data?.models
    .filter((model) => model.enabled)
    .map((model) => model.provider) ?? [])].sort();
  const selectedModel = runtimeOptions.data?.models.find(
    (model) => model.provider === selectedProvider
      && JSON.stringify([model.provider, model.id]) === selectedModelKey,
  );
  const hasUpdate = Boolean(
    runtimeAdapter.trim() || selectedModel || reasoningLevel || personaPrompt.trim() || statusChanged || skillsChanged,
  );
  const modelPolicyMutation = useMutation({
    mutationFn: () => localControl.updateAgentRuntimeModelPolicy(workspaceId, agent.identityId, {
      enabledModels: configuredRuntimeOptions.data?.models
        .filter((model) => enabledModelKeys?.includes(modelKey(model)))
        .map(({ provider, id }) => ({ provider, id })) ?? [],
    }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.agentRuntimeOptions(workspaceId, agent.identityId), next);
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey[0] === "workspace"
          && queryKey[1] === workspaceId
          && ((queryKey[2] === "agent"
            && queryKey.at(-1) === "runtime-options"
            && queryKey[3] !== agent.identityId)
            || (queryKey[2] === "runtime" && queryKey.at(-1) === "options")),
      });
    },
  });
  const mutation = useMutation({

    mutationFn: (input: UpdateLocalWorkspaceAgentConfigurationInput) =>
      localControl.updateWorkspaceAgentConfiguration(workspaceId, agent.identityId, input),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.workspaceConfiguration(workspaceId), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentRuntimeOptions(workspaceId, agent.identityId) });
      setRuntimeAdapter("");
      setSelectedProvider("");
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
    if (runtimeAdapter.trim() && replacementRuntimeOptions.data) {
      input.skillIds = skillIds ?? replacementRuntimeOptions.data.skills.map(({ id }) => id);
    } else if (skillsChanged && skillIds) input.skillIds = skillIds;
    if (statusChanged || agent.status === "unconfigured") input.status = status;
    mutation.mutate(input);
  };

  return (
    <form className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4" onSubmit={submit}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Private launch profile</h3>
          <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">
            Agent instructions and launch selections are private configuration and are never read back after save.
          </p>
        </div>
        <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">{agent.status}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ConfigurationState configured={agent.runtimeConfigured} label="Harness" />
        <ConfigurationState configured={agent.modelConfigured} label="Model" />
        <ConfigurationState configured={agent.reasoningConfigured} label="Reasoning" />
        <ConfigurationState configured={agent.skillsConfigured} label={`Skills (${agent.selectedSkillCount})`} />
        <ConfigurationState configured={agent.personaConfigured} label="Agent instructions" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          {agent.runtimeConfigured ? "Replace harness" : "Harness"}
          <input
            value={runtimeAdapter}
            onChange={(event) => {
              setRuntimeAdapter(event.target.value);
              setSelectedProvider("");
              setSelectedModelKey("");
              setReasoningLevel("");
              setSkillIds(null);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="pi"
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
          {agent.modelConfigured ? "Replace provider" : "Provider"}
          <select
            value={selectedProvider}
            onChange={(event) => {
              setSelectedProvider(event.target.value);
              setSelectedModelKey("");
              setReasoningLevel("");
            }}
            className="settings-input mt-1.5"
            disabled={!runtimeOptions.data}
          >
            <option value="">{agent.modelConfigured ? "Keep configured provider" : "Use harness default"}</option>
            {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
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
            disabled={!selectedProvider}
          >
            <option value="">{agent.modelConfigured ? "Keep configured model" : "Use provider default"}</option>
            {runtimeOptions.data?.models.filter((model) => model.enabled && model.provider === selectedProvider).map((model) => (
              <option key={`${model.provider}/${model.id}`} value={JSON.stringify([model.provider, model.id])}>
                {model.name}
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
      {runtimeOptions.data?.skills.length ? (
        <fieldset className="mt-3">
          <legend className="text-xs font-medium">Skills</legend>
          <p className="mt-1 text-[10px] text-[var(--muted)]">Changes apply when starting fresh.</p>
          <div className="mt-2 grid max-h-48 gap-1 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 sm:grid-cols-2">
            {runtimeOptions.data.skills.map((skill) => (
              <label key={skill.id} className="flex items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--hover)]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={skillIds?.includes(skill.id) ?? (runtimeAdapter.trim() || !configuredRuntimeOptions.data?.skillSelectionConfigured
                    ? true
                    : configuredRuntimeOptions.data.selectedSkillIds.includes(skill.id))}
                  onChange={(event) => setSkillIds((current) => {
                    const selected = current ?? (runtimeAdapter.trim()
                      ? runtimeOptions.data!.skills.map(({ id }) => id)
                      : savedSkillIds);
                    return event.target.checked
                      ? [...new Set([...selected, skill.id])]
                      : selected.filter((id) => id !== skill.id);
                  })}
                />
                <span><span className="block font-medium">{skill.name}</span><span className="block text-[10px] leading-4 text-[var(--muted)]">{skill.description}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {runtimeOptions.isPending ? <p className="mt-1.5 text-[10px] text-[var(--muted)]">Discovering configured harness providers, models, and skills…</p> : null}
      {runtimeOptions.error ? <p className="mt-1.5 text-[10px] text-[var(--danger)]">Harness model discovery unavailable.</p> : null}
      {configuredRuntimeOptions.data ? (
        <details className="mt-3 rounded-md border border-[var(--border)] bg-[var(--panel)] p-3">
          <summary className="cursor-pointer text-xs font-medium">Manage available provider models</summary>
          <p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
            This harness-scoped allowlist applies to every Workspace agent using the same harness. Provider credentials remain managed by the harness.
          </p>
          <div className="mt-2 grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
            {configuredRuntimeOptions.data.models.map((model) => {
              const key = modelKey(model);
              return (
                <label key={key} className="flex items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--hover)]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    aria-label={`Enable ${model.name}`}
                    checked={enabledModelKeys?.includes(key) ?? false}
                    onChange={(event) => setEnabledModelKeys((current) => event.target.checked
                      ? [...new Set([...(current ?? []), key])]
                      : (current ?? []).filter((candidate) => candidate !== key))}
                  />
                  <span><span className="block">{model.name}</span><span className="font-mono text-[10px] text-[var(--muted)]">{model.provider}/{model.id}</span></span>
                </label>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            {modelPolicyMutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{modelPolicyMutation.error.message}</span> : null}
            {modelPolicyMutation.isSuccess && !modelPolicyChanged ? <span className="mr-auto text-xs text-[var(--success)]">Model access saved</span> : null}
            <button type="button" className="button-secondary" disabled={!modelPolicyChanged || modelPolicyMutation.isPending} onClick={() => modelPolicyMutation.mutate()}>
              Save available models
            </button>
          </div>
        </details>
      ) : null}
      <label className="mt-3 block text-xs font-medium">
        {agent.personaConfigured ? "Replace agent instructions" : "Agent instructions"}
        <textarea value={personaPrompt} onChange={(event) => setPersonaPrompt(event.target.value)} rows={4} placeholder="Private responsibilities, behavior, and working style" className="settings-input mt-1.5 resize-y leading-5" />
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

function useAgentManagementData(workspaceId: string) {
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
  return {
    workspace,
    session,
    configuration,
    members,
    identities,
    workspaceChannels,
    agents,
    error: workspace.error ?? session.error ?? configuration.error ?? members.error ?? identities.error ?? workspaceChannels.error,
    pending: workspace.isPending || session.isPending || members.isPending || identities.isPending
      || workspaceChannels.isPending || (session.isSuccess && configuration.isPending),
  };
}

function AgentPageError({ error }: { error: unknown }) {
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

function AddAgentDialog({ workspaceId, members }: { workspaceId: string; members: WorkspaceMember[] }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="button-primary"><Plus className="h-3.5 w-3.5" /> Add agent</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[71] flex max-h-[min(46rem,94vh)] w-[min(38rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">Add Workspace agent</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-[var(--muted)]">Create an agent or service, then configure it from its detail page.</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button inline-flex" aria-label="Close Add Workspace agent"><X className="h-4 w-4" /></Dialog.Close>
          </header>
          <div className="minu-scroll min-h-0 flex-1 overflow-y-auto p-5">
            <AddWorkspaceParticipantForm
              workspaceId={workspaceId}
              existingMembers={members}
              mode="agent"
              onCreated={(identity) => {
                setOpen(false);
                void navigate({
                  to: "/app/workspaces/$workspaceId/agents/$agentId",
                  params: { workspaceId, agentId: identity.id },
                });
              }}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AgentManagementPage() {
  const { workspaceId } = useParams({ from: "/app/workspaces/$workspaceId/agents" });
  const data = useAgentManagementData(workspaceId);
  if (data.pending) return <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading Workspace agents…</div>;
  if (data.error || !data.workspace.data || !data.session.data || !data.configuration.data) return <AgentPageError error={data.error} />;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 pl-14 md:pl-5">
        <Bot className="hidden h-4 w-4 text-[var(--accent)] sm:block" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{data.workspace.data.name} agents</h1>
          <p className="truncate text-[11px] text-[var(--muted)]">Reusable agents and harness launch profiles</p>
        </div>
      </header>
      <div className="minu-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg)] p-4 md:p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Workspace agents</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--muted)]">Select an agent to view or edit its instructions and harness configuration.</p>
            </div>
            <AddAgentDialog workspaceId={workspaceId} members={data.members.data ?? []} />
          </div>
          {data.agents.length ? (
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]">
              {data.agents.map(({ identity, member, config }, index) => {
                const assignedChannels = (data.workspaceChannels.data ?? []).filter((channel) =>
                  channel.participants.some((participant) => participant.id === identity.id));
                return (
                  <Link
                    key={identity.id}
                    to="/app/workspaces/$workspaceId/agents/$agentId"
                    params={{ workspaceId, agentId: identity.id }}
                    className={`flex items-center gap-3 p-4 hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[var(--accent)] ${index ? "border-t border-[var(--border)]" : ""}`}
                  >
                    <span className="avatar shrink-0">{(identity.displayName ?? member.mentionHandle).slice(0, 1).toUpperCase()}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="truncate text-sm font-semibold">{identity.displayName ?? `@${member.mentionHandle}`}</h3>
                        <span className="font-mono text-[10px] text-[var(--muted)]">@{member.mentionHandle}</span>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-[var(--muted)]">
                        {member.profileOverride ?? identity.publicProfile ?? member.roleLabel ?? identity.type} · {assignedChannels.length} {assignedChannels.length === 1 ? "Channel" : "Channels"} · {config.boundChannelCount} active {config.boundChannelCount === 1 ? "binding" : "bindings"}
                      </p>
                    </div>
                    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">{config.status}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="empty-state"><p>No agents belong to this Workspace yet.</p><AddAgentDialog workspaceId={workspaceId} members={data.members.data ?? []} /></div>
          )}
        </div>
      </div>
    </section>
  );
}

export function AgentDetailPage() {
  const { workspaceId, agentId } = useParams({ from: "/app/workspaces/$workspaceId/agents/$agentId" });
  const data = useAgentManagementData(workspaceId);
  if (data.pending || (!data.agents.some(({ identity }) => identity.id === agentId) && data.configuration.isFetching)) {
    return <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading agent…</div>;
  }
  if (data.error || !data.workspace.data || !data.session.data || !data.configuration.data) return <AgentPageError error={data.error} />;
  const agent = data.agents.find(({ identity }) => identity.id === agentId);
  if (!agent) return <AgentPageError error={new Error("Agent does not belong to this Workspace.")} />;
  const assignedChannels = (data.workspaceChannels.data ?? []).filter((channel) =>
    channel.participants.some((participant) => participant.id === agent.identity.id));

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 pl-14 md:pl-5">
        <Bot className="hidden h-4 w-4 text-[var(--accent)] sm:block" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{agent.identity.displayName ?? `@${agent.member.mentionHandle}`}</h1>
          <p className="truncate font-mono text-[11px] text-[var(--muted)]">@{agent.member.mentionHandle} · {data.workspace.data.name}</p>
        </div>
      </header>
      <div className="minu-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg)] p-4 md:p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          <Link to="/app/workspaces/$workspaceId/agents" params={{ workspaceId }} className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)]"><ArrowLeft className="h-3.5 w-3.5" /> All agents</Link>
          <article className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="avatar shrink-0">{(agent.identity.displayName ?? agent.member.mentionHandle).slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{agent.identity.displayName ?? `@${agent.member.mentionHandle}`}</h2>
                  <p className="truncate font-mono text-[11px] text-[var(--muted)]">@{agent.member.mentionHandle} · {agent.identity.type} · {agent.member.status}</p>
                </div>
              </div>
              <span className="text-[11px] text-[var(--muted)]">{agent.config.boundChannelCount} active Runtime {agent.config.boundChannelCount === 1 ? "binding" : "bindings"}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {assignedChannels.length
                ? assignedChannels.map((channel) => <span key={channel.id} className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]">#{channel.name}</span>)
                : <span className="text-[11px] text-[var(--muted)]">Not assigned to a Channel</span>}
            </div>
            <AgentIdentityForm workspaceId={workspaceId} actorIdentityId={data.session.data.identityId} member={agent.member} />
            <AgentLaunchProfileForm workspaceId={workspaceId} agent={agent.config} />
          </article>
        </div>
      </div>
    </section>
  );
}
