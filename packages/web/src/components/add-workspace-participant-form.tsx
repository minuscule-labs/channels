import type { Identity, WorkspaceMember } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, UserPlus } from "lucide-react";
import { useState } from "react";
import { channels, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

function suggestedHandle(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function AddWorkspaceParticipantForm({
  workspaceId,
  existingMembers,
  onCreated,
  mode = "participant",
}: {
  workspaceId: string;
  existingMembers: WorkspaceMember[];
  onCreated?(identity: Identity, member: WorkspaceMember): void;
  mode?: "participant" | "agent";
}) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<Identity["type"]>("agent");
  const agentMode = mode === "agent";
  const [displayName, setDisplayName] = useState("");
  const [mentionHandle, setMentionHandle] = useState("");
  const [handleCustomized, setHandleCustomized] = useState(false);
  const [roleLabel, setRoleLabel] = useState("");
  const [runtimeAdapter, setRuntimeAdapter] = useState("pi");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState("");
  const [personaPrompt, setPersonaPrompt] = useState("");
  const normalizedHandle = mentionHandle.trim().replace(/^@+/, "").toLowerCase();
  const handleValid = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(normalizedHandle);
  const handleAvailable = !existingMembers.some(
    (member) => member.mentionHandle.toLowerCase() === normalizedHandle,
  );
  const executionIdentity = type === "agent" || type === "service";
  const runtimeOptions = useQuery({
    queryKey: queryKeys.workspaceRuntimeOptions(workspaceId, runtimeAdapter.trim()),
    queryFn: () => localControl.getWorkspaceRuntimeOptions(workspaceId, runtimeAdapter.trim()),
    enabled: executionIdentity && /^[a-zA-Z0-9._-]+$/.test(runtimeAdapter.trim()),
    retry: false,
    staleTime: 60_000,
  });
  const providers = [...new Set(runtimeOptions.data?.models
    .filter((model) => model.enabled)
    .map((model) => model.provider) ?? [])].sort();
  const selectedModel = runtimeOptions.data?.models.find((model) =>
    model.provider === selectedProvider
      && JSON.stringify([model.provider, model.id]) === selectedModelKey);
  const canSubmit = Boolean(
    displayName.trim()
      && handleValid
      && handleAvailable
      && (!executionIdentity || runtimeAdapter.trim()),
  );
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
      let configurationWarning: string | undefined;
      if (executionIdentity) {
        try {
          await localControl.updateWorkspaceAgentConfiguration(workspaceId, identity.id, {
            runtimeAdapter: runtimeAdapter.trim(),
            ...(selectedModel ? { modelProvider: selectedModel.provider, modelId: selectedModel.id } : {}),
            ...(reasoningLevel ? { reasoningLevel: reasoningLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } : {}),
            ...(personaPrompt.trim() ? { personaPrompt: personaPrompt.trim() } : {}),
            status: "active",
          });
        } catch (error) {
          configurationWarning = error instanceof Error ? error.message : "Agent configuration failed";
        }
      }
      return { identity, member, configurationWarning };
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
      onCreated?.(identity, member);
      setDisplayName("");
      setMentionHandle("");
      setHandleCustomized(false);
      setRoleLabel("");
      setRuntimeAdapter("pi");
      setSelectedProvider("");
      setSelectedModelKey("");
      setReasoningLevel("");
      setPersonaPrompt("");
      setType("agent");
    },
  });

  return (
    <form
      className={agentMode ? "" : "rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !mutation.isPending) mutation.mutate();
      }}
    >
      {!agentMode ? (
        <div className="flex items-start gap-3">
          <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
          <div>
            <h2 className="text-sm font-semibold">Create a participant</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Add a reusable identity to this Workspace and select it for this Channel.</p>
          </div>
        </div>
      ) : null}
      <div className={`${agentMode ? "" : "mt-4"} grid gap-3 sm:grid-cols-2`}>
        {!agentMode ? (
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
        ) : null}
        <label className={`block text-xs font-medium ${agentMode ? "sm:col-span-2" : ""}`}>
          Display name
          <input
            value={displayName}
            onChange={(event) => {
              const value = event.target.value;
              setDisplayName(value);
              if (!handleCustomized) setMentionHandle(suggestedHandle(value));
            }}
            maxLength={200}
            placeholder={type === "agent" ? "Reviewer" : "Name"}
            className="settings-input mt-1.5"
          />
        </label>
        {!agentMode ? (
          <label className="block text-xs font-medium">
            Mention handle
            <input
              value={mentionHandle}
              onChange={(event) => {
                setHandleCustomized(true);
                setMentionHandle(event.target.value.replace(/^@+/, ""));
              }}
              maxLength={64}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="reviewer"
              className="settings-input mt-1.5 font-mono"
            />
            {mentionHandle && (!handleValid || !handleAvailable) ? (
              <span className="mt-1 block text-[10px] text-[var(--danger)]">
                {handleAvailable ? "Use letters, numbers, underscores, or hyphens." : "That handle is already in use."}
              </span>
            ) : null}
          </label>
        ) : null}
        {!agentMode ? (
          <label className="block text-xs font-medium">
            Public role <span className="font-normal text-[var(--muted)]">(optional)</span>
            <input
              value={roleLabel}
              onChange={(event) => setRoleLabel(event.target.value)}
              maxLength={100}
              placeholder={executionIdentity ? "reviewer" : "member"}
              className="settings-input mt-1.5"
            />
          </label>
        ) : null}
      </div>
      {agentMode ? (
        <label className="mt-3 block text-xs font-medium">
          Agent instructions <span className="font-normal text-[var(--muted)]">(optional)</span>
          <textarea
            value={personaPrompt}
            onChange={(event) => setPersonaPrompt(event.target.value)}
            rows={4}
            placeholder="Responsibilities, behavior, and working style"
            className="settings-input mt-1.5 resize-y leading-5"
          />
          <span className="mt-1 block text-[10px] leading-4 text-[var(--muted)]">Private instructions added to this agent’s system prompt.</span>
        </label>
      ) : null}
      {executionIdentity ? (
        <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Harness</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium">
            Harness
            <input
              value={runtimeAdapter}
              onChange={(event) => {
                setRuntimeAdapter(event.target.value);
                setSelectedProvider("");
                setSelectedModelKey("");
                setReasoningLevel("");
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="pi"
              className="settings-input mt-1.5 font-mono"
            />
          </label>
          <label className="block text-xs font-medium">
            Provider
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
              <option value="">Use harness default</option>
              {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium">
            Model
            <select
              value={selectedModelKey}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedModelKey(value);
                const model = runtimeOptions.data?.models.find((candidate) =>
                  JSON.stringify([candidate.provider, candidate.id]) === value);
                if (model && !model.reasoning) setReasoningLevel("off");
              }}
              className="settings-input mt-1.5"
              disabled={!selectedProvider}
            >
              <option value="">Use provider default</option>
              {runtimeOptions.data?.models.filter((model) => model.enabled && model.provider === selectedProvider).map((model) => (
                <option key={`${model.provider}/${model.id}`} value={JSON.stringify([model.provider, model.id])}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium">
            Reasoning
            <select value={reasoningLevel} onChange={(event) => setReasoningLevel(event.target.value)} className="settings-input mt-1.5" disabled={!runtimeOptions.data}>
              <option value="">Use model default</option>
              {runtimeOptions.data?.reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          {runtimeOptions.isPending ? <p className="text-[10px] text-[var(--muted)] sm:col-span-2">Discovering harness providers and models…</p> : null}
          {runtimeOptions.error ? <p className="text-[10px] text-[var(--danger)] sm:col-span-2">Harness model discovery unavailable.</p> : null}
          {!agentMode ? (
            <label className="block text-xs font-medium sm:col-span-2">
              Agent instructions <span className="font-normal text-[var(--muted)]">(optional)</span>
              <textarea
                value={personaPrompt}
                onChange={(event) => setPersonaPrompt(event.target.value)}
                rows={3}
                placeholder="Responsibilities, behavior, and working style"
                className="settings-input mt-1.5 resize-y leading-5"
              />
            </label>
          ) : null}
          </div>
        </div>
      ) : null}
      {!agentMode ? (
        <p className="mt-3 text-[10px] leading-4 text-[var(--muted)]">
          Additional humans cannot sign in through the local single-human session yet.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.data?.configurationWarning ? (
          <span className="mr-auto text-xs text-[var(--warning)]">
            Participant added, but configuration needs attention: {mutation.data.configurationWarning}
          </span>
        ) : null}
        {mutation.isSuccess && !mutation.data.configurationWarning ? (
          <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]">
            <Check className="h-3 w-3" /> {agentMode ? "Agent created" : "Participant created and selected"}
          </span>
        ) : null}
        <button className="button-primary" type="submit" disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
          {agentMode ? "Create agent" : "Create participant"}
        </button>
      </div>
    </form>
  );
}
