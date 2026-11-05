import type { ConversationSetup } from "@minu/channels-control/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { ParticipantChoices, type WorkspaceParticipant } from "./workspace-participants";

export function copySetup(setup: ConversationSetup): ConversationSetup {
  return { participants: setup.participants.map((entry) => ({ ...entry })),
    ...(setup.model ? { model: { ...setup.model } } : {}),
    ...(setup.reasoningLevel ? { reasoningLevel: setup.reasoningLevel } : {}),
    ...(setup.guidance ? { guidance: setup.guidance } : {}),
    ...(setup.turnTimeoutMs !== undefined ? { turnTimeoutMs: setup.turnTimeoutMs } : {}),
    ...(setup.idleSleepTimeoutMs !== undefined ? { idleSleepTimeoutMs: setup.idleSleepTimeoutMs } : {}) };
}

export function ConversationPresetPicker({ workspaceId, onChange }: { workspaceId: string; onChange(setup: ConversationSetup): void }) {
  const [selection, setSelection] = useState("");
  const presets = useQuery({ queryKey: queryKeys.conversationPresets(workspaceId), queryFn: () => localControl.listConversationPresets(workspaceId) });
  return <div>
    <label className="block text-xs font-medium">Preset (optional)
      <select aria-label="Preset (optional)" className="settings-input mt-1.5" value={selection} onChange={(event) => {
        setSelection(event.target.value);
        const preset = presets.data?.presets.find(({ id }) => id === event.target.value);
        onChange(preset ? copySetup(preset) : { participants: [] });
      }}>
        <option value="">Choose participants yourself</option>
        {presets.data?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
    </label>
    <p className="mt-2 text-xs text-[var(--muted)]">Presets fill in participants and saved defaults. You can adjust settings after creation. <Link className="text-[var(--accent)] underline" to="/app/workspaces/$workspaceId/settings/presets" params={{ workspaceId }}>Manage presets</Link></p>
    {presets.error ? <p role="alert" className="mt-2 text-xs">Presets couldn’t be loaded. <button type="button" className="underline" onClick={() => void presets.refetch()}>Retry presets</button></p> : null}
  </div>;
}

export function ConversationTimeoutFields({ setup, onChange }: { setup: ConversationSetup; onChange(setup: ConversationSetup): void }) {
  return <section aria-label="Timeouts" className="space-y-4 rounded-lg border border-[var(--border)] p-5">
    <div><h2 className="text-sm font-semibold">Timeouts</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Inherit Workspace defaults or set a policy for this Conversation. Turn changes apply to the next turn; idle sleep uses the saved policy immediately.</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-xs font-medium">Turn timeout
        <select aria-label="Turn timeout" className="settings-input mt-1.5" value={setup.turnTimeoutMs ?? ""} onChange={(event) => {
          const { turnTimeoutMs: _, ...rest } = setup;
          onChange({ ...rest, ...(event.target.value ? { turnTimeoutMs: Number(event.target.value) } : {}) });
        }}><option value="">Use Workspace default</option>{[1, 5, 10, 15, 30].map((minutes) => <option key={minutes} value={minutes * 60_000}>{minutes} {minutes === 1 ? "minute" : "minutes"}</option>)}</select>
      </label>
      <label className="text-xs font-medium">Idle agent sleep
        <select aria-label="Idle agent sleep" className="settings-input mt-1.5" value={setup.idleSleepTimeoutMs === null ? "off" : setup.idleSleepTimeoutMs ?? ""} onChange={(event) => {
          const { idleSleepTimeoutMs: _, ...rest } = setup;
          onChange({ ...rest, ...(event.target.value ? { idleSleepTimeoutMs: event.target.value === "off" ? null : Number(event.target.value) } : {}) });
        }}><option value="">Use Workspace default</option><option value="off">Off</option>{[15, 30, 60, 240, 1440].map((minutes) => <option key={minutes} value={minutes * 60_000}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hours`}</option>)}</select>
      </label>
    </div>
  </section>;
}

export function ConversationSetupFields({ workspaceId, setup, onChange, participants, editParticipants = true }: {
  workspaceId: string; setup: ConversationSetup; onChange(setup: ConversationSetup): void;
  participants: WorkspaceParticipant[]; editParticipants?: boolean;
}) {
  const configuration = useQuery({ queryKey: queryKeys.workspaceConfiguration(workspaceId), queryFn: () => localControl.getWorkspaceConfiguration(workspaceId) });
  const adapter = configuration.data?.agents.find((agent) => setup.participants.some(({ identityId }) => identityId === agent.identityId) && agent.runtimeAdapter)?.runtimeAdapter
    ?? configuration.data?.agents.find((agent) => agent.runtimeAdapter)?.runtimeAdapter;
  const runtimeOptions = useQuery({ queryKey: queryKeys.workspaceRuntimeOptions(workspaceId, adapter ?? ""), queryFn: () => localControl.getWorkspaceRuntimeOptions(workspaceId, adapter!), enabled: Boolean(adapter), retry: false });
  const agents = participants.filter(({ identity, member }) => identity.type === "agent" && identity.status === "active" && member.status === "active");
  const modelValue = setup.model ? JSON.stringify([setup.model.provider, setup.model.id]) : "";
  const models = runtimeOptions.data?.models.filter(({ enabled }) => enabled) ?? [];
  const selectedModel = models.find((model) => JSON.stringify([model.provider, model.id]) === modelValue);
  const effortLevels = selectedModel?.reasoning === false ? ["off"] : runtimeOptions.data?.reasoningLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return <div className="space-y-5">
    <section aria-label="Preset participants and roles" className="space-y-4 rounded-lg border border-[var(--border)] p-5">
      <h2 className="text-sm font-semibold">Participants & roles</h2>
      {editParticipants ? <ParticipantChoices participants={participants} selected={new Set(setup.participants.flatMap(({ identityId }) => identityId ? [identityId] : []))} onToggle={(identityId) => {
        const existing = setup.participants.some((entry) => entry.identityId === identityId);
        onChange({ ...setup, participants: existing ? setup.participants.filter((entry) => entry.identityId !== identityId)
          : [...setup.participants, { identityId, role: participants.find(({ identity }) => identity.id === identityId)?.member.roleLabel || "Collaborator" }] });
      }} /> : <p className="text-xs text-[var(--muted)]">Edit the roles for these agents. Change the roster in Participants above.</p>}
      {setup.participants.map((participant, index) => <div key={index} className="flex flex-wrap items-end gap-3 rounded-md bg-[var(--bg)] p-3">
        {editParticipants ? <label className="min-w-40 flex-1 text-xs">Agent for role {index + 1}
          <select aria-label={`Agent for role ${index + 1}`} className="settings-input mt-1.5" value={participant.identityId ?? ""} onChange={(event) => onChange({ ...setup, participants: setup.participants.map((entry, position) => position === index ? { role: entry.role, ...(event.target.value ? { identityId: event.target.value } : {}) } : entry) })}>
            <option value="">Choose a Workspace agent</option>
            {participant.identityId && !agents.some(({ identity }) => identity.id === participant.identityId) ? <option value={participant.identityId}>Unavailable agent — choose another</option> : null}
            {agents.map(({ identity, member }) => <option key={identity.id} value={identity.id} disabled={setup.participants.some((entry, position) => position !== index && entry.identityId === identity.id)}>{identity.displayName ?? `@${member.mentionHandle}`}</option>)}
          </select>
        </label> : <span className="flex-1 text-xs">{participants.find(({ identity }) => identity.id === participant.identityId)?.identity.displayName ?? participant.identityId}</span>}
        <label className="min-w-40 flex-1 text-xs">Role {index + 1}<input className="settings-input mt-1.5" value={participant.role} maxLength={100} onChange={(event) => onChange({ ...setup, participants: setup.participants.map((entry, position) => position === index ? { ...entry, role: event.target.value } : entry) })} /></label>
        {editParticipants ? <button type="button" className="button-secondary" aria-label={`Remove role ${index + 1}`} onClick={() => onChange({ ...setup, participants: setup.participants.filter((_, position) => position !== index) })}>Remove</button> : null}
      </div>)}
      {editParticipants ? <button type="button" className="button-secondary" disabled={setup.participants.length >= 16} onClick={() => onChange({ ...setup, participants: [...setup.participants, { role: "Collaborator" }] })}>Add role</button> : null}
    </section>
    <section aria-label="Session defaults" className="space-y-4 rounded-lg border border-[var(--border)] p-5">
      <div><h2 className="text-sm font-semibold">Session defaults</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Use each agent’s configuration or override it for new sessions in this Conversation.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-medium">Conversation model<select aria-label="Conversation model" className="settings-input mt-1.5" value={modelValue} onChange={(event) => {
          const model = models.find((candidate) => JSON.stringify([candidate.provider, candidate.id]) === event.target.value);
          const { model: _, ...rest } = setup;
          onChange({ ...rest, ...(model ? { model: { provider: model.provider, id: model.id }, ...(!model.reasoning ? { reasoningLevel: "off" as const } : {}) } : {}) });
        }}><option value="">Use each agent’s saved model</option>{modelValue && !selectedModel ? <option value={modelValue}>Unavailable: {setup.model!.provider}/{setup.model!.id}</option> : null}{models.map((model) => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.name} ({model.provider})</option>)}</select></label>
        <label className="text-xs font-medium">Conversation effort<select aria-label="Conversation effort" className="settings-input mt-1.5" value={setup.reasoningLevel ?? ""} onChange={(event) => {
          const { reasoningLevel: _, ...rest } = setup;
          onChange({ ...rest, ...(event.target.value ? { reasoningLevel: event.target.value as ConversationSetup["reasoningLevel"] } : {}) });
        }}><option value="" disabled={selectedModel?.reasoning === false}>Use each agent’s saved effort</option>{setup.reasoningLevel && !effortLevels.includes(setup.reasoningLevel) ? <option value={setup.reasoningLevel} disabled>{setup.reasoningLevel} (unavailable)</option> : null}{effortLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
      </div>
      {runtimeOptions.error ? <p className="text-xs text-[var(--muted)]">Model choices are unavailable. <button type="button" className="underline" onClick={() => void runtimeOptions.refetch()}>Retry models</button></p> : null}
    </section>
    <ConversationTimeoutFields setup={setup} onChange={onChange} />
    <section className="rounded-lg border border-[var(--border)] p-5" aria-label="Collaboration">
      <h2 className="mb-4 text-sm font-semibold">Collaboration</h2>
      <label className="block text-xs font-medium">Collaboration guidance (optional)<textarea className="settings-input mt-1.5 min-h-32" maxLength={16000} value={setup.guidance ?? ""} placeholder="For example, check in after investigation and before implementation." onChange={(event) => onChange({ ...setup, guidance: event.target.value })} /></label>
      <p className="mt-2 text-xs leading-5 text-[var(--muted)]">Guidance applies to new sessions. Check-ins are instructions to agents, not scheduled reminders.</p>
    </section>
  </div>;
}

export function ConversationCreationSettings({ conversationId }: { conversationId: string }) {
  const result = useQuery({ queryKey: queryKeys.conversationCreationSetup(conversationId), queryFn: () => localControl.getConversationCreationSetup(conversationId), retry: false });
  const setup = result.data?.setup;
  if (!setup) return null;
  return <details className="rounded-lg border border-[var(--border)] p-5"><summary className="cursor-pointer text-xs font-medium">Original creation settings</summary><div className="mt-3 space-y-2 text-xs text-[var(--muted)]">
    <p>Model: {setup.model ? `${setup.model.provider}/${setup.model.id}` : "Each agent’s saved model"} · Effort: {setup.reasoningLevel ?? "Each agent’s saved effort"}</p>
    <p>Roles: {setup.participants.map(({ role }) => role).join(", ") || "None"}</p>
    {setup.guidance ? <p className="whitespace-pre-wrap leading-5">{setup.guidance}</p> : null}
  </div></details>;
}
