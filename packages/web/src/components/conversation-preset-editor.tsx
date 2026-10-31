import { CONVERSATION_PRESET_STARTERS, type ConversationSetup, type ConversationPreset, type SaveConversationPresetInput } from "@minu/channels-control/contracts";
import type { Identity, WorkspaceMember } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { ErrorNotice } from "./ui/error-notice";

function createPresetId(): string {
  return `preset_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function ConversationPresetEditor({ workspaceId, setup, onChange, participants }: {
  workspaceId: string;
  setup: ConversationSetup;
  onChange(setup: ConversationSetup): void;
  participants: Array<{ identity: Identity; member: WorkspaceMember }>;
}) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState("");
  const [editing, setEditing] = useState<ConversationPreset>();
  const [presetName, setPresetName] = useState("");
  const newPresetId = useRef(createPresetId());
  const activeDraft = useRef(0);
  const presets = useQuery({ queryKey: queryKeys.conversationPresets(workspaceId),
    queryFn: () => localControl.listConversationPresets(workspaceId) });
  const configuration = useQuery({ queryKey: queryKeys.workspaceConfiguration(workspaceId),
    queryFn: () => localControl.getWorkspaceConfiguration(workspaceId) });
  const adapter = configuration.data?.agents.find((agent) =>
    setup.participants.some(({ identityId }) => identityId === agent.identityId) && agent.runtimeAdapter)?.runtimeAdapter
    ?? configuration.data?.agents.find((agent) => agent.runtimeAdapter)?.runtimeAdapter;
  const runtimeOptions = useQuery({ queryKey: queryKeys.workspaceRuntimeOptions(workspaceId, adapter ?? ""),
    queryFn: () => localControl.getWorkspaceRuntimeOptions(workspaceId, adapter!), enabled: Boolean(adapter), retry: false });
  const agents = participants.filter(({ identity, member }) => identity.type === "agent"
    && identity.status === "active" && member.status === "active");
  const save = useMutation({
    mutationFn: (request: { id: string; input: SaveConversationPresetInput; draft: number }) =>
      localControl.saveConversationPreset(workspaceId, request.id, request.input),
    onSuccess: (preset, request) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversationPresets(workspaceId) });
      if (activeDraft.current !== request.draft) return;
      setEditing(preset);
      setSelection(preset.id);
      setPresetName((current) => current.trim() === request.input.name ? preset.name : current);
      newPresetId.current = createPresetId();
    },
  });
  const savePreset = (asNew: boolean) => save.mutate({
    id: !asNew && editing ? editing.id : newPresetId.current,
    input: { ...setup, name: presetName.trim(), expectedRevision: !asNew && editing ? editing.revision : null },
    draft: activeDraft.current,
  });
  const remove = useMutation({
    mutationFn: (request: { id: string; revision: number; draft: number }) =>
      localControl.deleteConversationPreset(workspaceId, request.id, request.revision),
    onSuccess: (_, request) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversationPresets(workspaceId) });
      if (activeDraft.current !== request.draft) return;
      activeDraft.current += 1;
      newPresetId.current = createPresetId();
      setEditing(undefined); setSelection("");
    },
  });
  const reloadPresets = async () => {
    const draft = activeDraft.current;
    const pendingCreationId = newPresetId.current;
    const result = await presets.refetch();
    if (result.isError || activeDraft.current !== draft) return;
    // A save may have committed even when its response never reached the editor.
    const current = result.data?.presets.find((preset) => preset.id === pendingCreationId)
      ?? result.data?.presets.find((preset) => preset.id === editing?.id);
    if (editing || current) {
      activeDraft.current += 1;
      newPresetId.current = createPresetId();
      setEditing(current); setSelection(current?.id ?? "");
      if (current) {
        setPresetName(current.name);
        onChange({ participants: current.participants.map((participant) => ({ ...participant })),
          ...(current.model ? { model: { ...current.model } } : {}),
          ...(current.reasoningLevel ? { reasoningLevel: current.reasoningLevel } : {}),
          ...(current.guidance ? { guidance: current.guidance } : {}) });
      }
    }
    save.reset(); remove.reset();
  };
  const modelValue = setup.model ? JSON.stringify([setup.model.provider, setup.model.id]) : "";
  const models = runtimeOptions.data?.models.filter(({ enabled }) => enabled) ?? [];
  const selectedModel = models.find((model) => JSON.stringify([model.provider, model.id]) === modelValue);
  const effortLevels = selectedModel?.reasoning === false ? ["off"]
    : runtimeOptions.data?.reasoningLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const validPreset = Boolean(presetName.trim()) && setup.participants.every(({ role }) => role.trim()) && !save.isPending && !remove.isPending;
  return (
    <section aria-label="Conversation preset" className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
      <label className="block text-xs font-medium">Preset
        <select className="settings-input mt-1.5" value={selection} onChange={(event) => {
          const id = event.target.value;
          const preset = presets.data?.presets.find((candidate) => candidate.id === id);
          const starter = CONVERSATION_PRESET_STARTERS.find((candidate) => candidate.id === id);
          const next = preset ?? starter;
          activeDraft.current += 1;
          newPresetId.current = createPresetId();
          setSelection(id); setEditing(preset); setPresetName(next?.name ?? ""); save.reset(); remove.reset();
          onChange(next ? { participants: next.participants.map((participant) => ({ ...participant })),
            ...(next.model ? { model: { ...next.model } } : {}), ...(next.reasoningLevel ? { reasoningLevel: next.reasoningLevel } : {}),
            ...(next.guidance ? { guidance: next.guidance } : {}) } : { participants: [] });
        }}>
          <option value="">Start blank</option>
          <optgroup label="Starting points">{CONVERSATION_PRESET_STARTERS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</optgroup>
          {presets.data?.presets.length ? <optgroup label="Saved in this Workspace">{presets.data.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</optgroup> : null}
        </select>
      </label>
      <p className="text-[11px] leading-4 text-[var(--muted)]">Review and adjust every setting before creating. Changes here apply to this draft; save explicitly to reuse them.</p>
      {presets.error ? <p role="alert" className="text-xs">Could not load saved presets. <button type="button" onClick={() => void reloadPresets()} className="underline">Reload presets</button></p> : null}
      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-medium">Conversation roles</legend>
        {setup.participants.map((participant, index) => (
          <div key={index} className="space-y-2 rounded-md border border-[var(--border)] p-3">
            <label className="block text-xs">Role {index + 1}
              <input className="settings-input mt-1" maxLength={100} value={participant.role} onChange={(event) => onChange({ ...setup,
                participants: setup.participants.map((entry, position) => position === index ? { ...entry, role: event.target.value } : entry) })} />
            </label>
            <label className="block text-xs">Agent for role {index + 1}
              <select className="settings-input mt-1" value={participant.identityId ?? ""} onChange={(event) => onChange({ ...setup,
                participants: setup.participants.map((entry, position) => position === index
                  ? { role: entry.role, ...(event.target.value ? { identityId: event.target.value } : {}) } : entry) })}>
                <option value="">Choose a Workspace agent</option>
                {participant.identityId && !agents.some(({ identity }) => identity.id === participant.identityId)
                  ? <option value={participant.identityId}>Unavailable agent — choose another</option> : null}
                {agents.map(({ identity, member }) => <option key={identity.id} value={identity.id}
                  disabled={setup.participants.some((entry, position) => position !== index && entry.identityId === identity.id)}>
                  {identity.displayName ?? `@${member.mentionHandle}`}
                </option>)}
              </select>
            </label>
            <button type="button" className="text-xs text-[var(--muted)] underline" aria-label={`Remove role ${index + 1}`}
              onClick={() => onChange({ ...setup, participants: setup.participants.filter((_, position) => position !== index) })}>Remove role</button>
          </div>
        ))}
        <button type="button" className="button-secondary" disabled={setup.participants.length >= 16}
          onClick={() => onChange({ ...setup, participants: [...setup.participants, { role: "Collaborator" }] })}>Add role</button>
      </fieldset>
      <label className="block text-xs font-medium">Conversation model
        <select className="settings-input mt-1.5" value={modelValue} onChange={(event) => {
          const model = models.find((candidate) => JSON.stringify([candidate.provider, candidate.id]) === event.target.value);
          const { model: _, ...rest } = setup;
          onChange({ ...rest, ...(model ? { model: { provider: model.provider, id: model.id },
            ...(!model.reasoning ? { reasoningLevel: "off" as const } : {}) } : {}) });
        }}>
          <option value="">Use each agent’s saved model</option>
          {modelValue && !selectedModel ? <option value={modelValue}>Unavailable: {setup.model!.provider}/{setup.model!.id}</option> : null}
          {models.map((model) => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.name} ({model.provider})</option>)}
        </select>
      </label>
      {runtimeOptions.error ? <p className="text-xs text-[var(--muted)]">Model choices are unavailable. <button type="button" className="underline" onClick={() => void runtimeOptions.refetch()}>Retry models</button></p> : null}
      <label className="block text-xs font-medium">Conversation effort
        <select className="settings-input mt-1.5" value={setup.reasoningLevel ?? ""} onChange={(event) => {
          const { reasoningLevel: _, ...rest } = setup;
          onChange({ ...rest, ...(event.target.value ? { reasoningLevel: event.target.value as ConversationSetup["reasoningLevel"] } : {}) });
        }}>
          <option value="" disabled={selectedModel?.reasoning === false}>Use each agent’s saved effort</option>
          {setup.reasoningLevel && !effortLevels.includes(setup.reasoningLevel)
            ? <option value={setup.reasoningLevel} disabled>{setup.reasoningLevel} (unavailable)</option> : null}
          {effortLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium">Collaboration guidance (optional)
        <textarea className="settings-input mt-1.5 min-h-28" maxLength={16000} value={setup.guidance ?? ""}
          placeholder="For example, check in after investigation and before implementation."
          onChange={(event) => onChange({ ...setup, guidance: event.target.value })} />
      </label>
      <p className="text-[11px] leading-4 text-[var(--muted)]">Roles, model, effort, and guidance apply to new agent sessions in this Conversation. Check-ins are instructions to agents, not scheduled reminders.</p>
      <details>
        <summary className="cursor-pointer text-xs font-medium">Save or manage presets</summary>
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium">Preset name
            <input className="settings-input mt-1.5" maxLength={100} value={presetName} onChange={(event) => setPresetName(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="button-secondary" disabled={!validPreset} onClick={() => savePreset(true)}>Save as new preset</button>
            {editing ? <>
              <button type="button" className="button-secondary" disabled={!validPreset} onClick={() => savePreset(false)}>Save preset changes</button>
              <button type="button" className="button-secondary" disabled={save.isPending || remove.isPending}
                onClick={() => remove.mutate({ id: editing.id, revision: editing.revision, draft: activeDraft.current })}>Delete preset</button>
            </> : null}
          </div>
          {save.isSuccess ? <p role="status" className="text-xs text-[var(--success)]">Preset saved.</p> : null}
          {remove.isSuccess ? <p role="status" className="text-xs text-[var(--success)]">Preset deleted. Your draft is still available.</p> : null}
          {save.error || remove.error ? <ErrorNotice onDismiss={() => { save.reset(); remove.reset(); }}>{(save.error ?? remove.error)!.message} <button type="button" className="underline" onClick={() => void reloadPresets()}>Reload presets</button></ErrorNotice> : null}
        </div>
      </details>
    </section>
  );
}

export function ConversationCreationSettings({ conversationId }: { conversationId: string }) {
  const result = useQuery({ queryKey: queryKeys.conversationCreationSetup(conversationId),
    queryFn: () => localControl.getConversationCreationSetup(conversationId), retry: false });
  const setup = result.data?.setup;
  if (!setup) return null;
  return <section className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4" aria-label="Creation settings">
    <h3 className="text-xs font-medium">Creation settings</h3>
    <p className="text-xs text-[var(--muted)]">Model: {setup.model ? `${setup.model.provider}/${setup.model.id}` : "Each agent’s saved model"} · Effort: {setup.reasoningLevel ?? "Each agent’s saved effort"}</p>
    {setup.participants.length ? <p className="text-xs">Roles: {setup.participants.map(({ role }) => role).join(", ")}</p> : null}
    {setup.guidance ? <p className="whitespace-pre-wrap text-xs leading-5">{setup.guidance}</p> : null}
  </section>;
}
