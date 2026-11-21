import type { LocalAccountLibraryItem, WorkspacePresetDefinition, WorkspaceCompositionPlan } from "@minu/channels-control/contracts";

type Definition = WorkspacePresetDefinition | WorkspaceCompositionPlan;
export const emptyWorkspacePreset = (): WorkspacePresetDefinition => ({ agents: [], conversationPresets: [], instructions: "" });
export function WorkspacePresetFields({ value, onChange, library }: { value: Definition; onChange(value: Definition): void; library: LocalAccountLibraryItem[] }) {
  const templates = library.filter((item): item is Extract<LocalAccountLibraryItem, { kind: "agent-template" }> => item.kind === "agent-template" && (item.state === "active" || value.agents.some(agent => agent.templateId === item.id)));
  const addTemplate = templates.find(item => item.state === "active");
  const skills = library.filter(item => item.kind === "skill");
  const resolved = "presetId" in value;
  const changeAgent = (index: number, update: Partial<Definition["agents"][number]>) => onChange({ ...value, agents: value.agents.map((agent, i) => i === index ? { ...agent, ...update } : agent) } as Definition);
  const configure = (index: number, key: string, text: string) => {
    const agent = value.agents[index]!;
    if (!("configuration" in agent)) return;
    const configuration = { ...agent.configuration } as Record<string, unknown>;
    if (text) configuration[key] = text; else delete configuration[key];
    changeAgent(index, { configuration } as Partial<WorkspaceCompositionPlan["agents"][number]>);
  };
  return <div className="space-y-5">
    <fieldset className="min-w-0 space-y-3"><legend className="mb-2 font-medium">Starter agents</legend>
      {value.agents.map((agent, index) => {
        const template = templates.find(item => item.id === agent.templateId);
        const selected = "configuration" in agent ? agent.configuration.accountSkillIds ?? [] : agent.accountSkillIds ?? template?.configuration.accountSkillIds ?? [];
        return <section key={agent.key} aria-label={`Starter agent ${index + 1}`} className="space-y-3 rounded border border-[var(--border)] p-3">
          <label className="block text-xs">Agent template<select aria-label="Agent template" className="settings-input mt-1" value={agent.templateId} onChange={event => {
            const next = templates.find(item => item.id === event.target.value);
            if (next) changeAgent(index, { templateId: next.id, ...("configuration" in agent ? { configuration: { ...next.configuration }, templateVersion: next.version } : { accountSkillIds: [...(next.configuration.accountSkillIds ?? [])] }) });
          }}>{templates.map(item => <option key={item.id} value={item.id} disabled={item.state !== "active"}>{item.name}{item.state === "archived" ? " (Archived)" : ""}</option>)}</select></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs">Display name<input required className="settings-input mt-1" value={agent.displayName} onChange={event => changeAgent(index, { displayName: event.target.value })} /></label>
            <label className="block text-xs">Mention handle<input required className="settings-input mt-1" value={agent.mentionHandle} onChange={event => changeAgent(index, { mentionHandle: event.target.value })} /></label></div>
          {"configuration" in agent ? <>
            <label className="block text-xs">Agent instructions<textarea aria-label="Agent instructions" className="settings-input mt-1 min-h-24" value={agent.configuration.personaPrompt ?? ""} onChange={event => configure(index, "personaPrompt", event.target.value)} /></label>
            <div className="grid gap-3 sm:grid-cols-2">{(["runtimeAdapter", "modelProvider", "modelId"] as const).map(key => <label key={key} className="block text-xs">{key === "runtimeAdapter" ? "Runtime adapter" : key === "modelProvider" ? "Model provider" : "Model ID"}<input className="settings-input mt-1" value={agent.configuration[key] ?? ""} onChange={event => configure(index, key, event.target.value)} /></label>)}
              <label className="block text-xs">Reasoning level<select aria-label="Reasoning level" className="settings-input mt-1" value={agent.configuration.reasoningLevel ?? ""} onChange={event => configure(index, "reasoningLevel", event.target.value)}><option value="">Default</option>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => <option key={level}>{level}</option>)}</select></label></div>
          </> : null}
          <fieldset className="space-y-1"><legend className="mb-1 text-xs">Shared account skills</legend>{skills.filter(skill => skill.state === "active" || selected.includes(skill.id)).map(skill => <label key={skill.id} className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={skill.name} checked={selected.includes(skill.id)} onChange={event => {
            const ids = event.target.checked ? [...selected, skill.id] : selected.filter(id => id !== skill.id);
            changeAgent(index, "configuration" in agent ? { configuration: { ...agent.configuration, accountSkillIds: ids } } : { accountSkillIds: ids });
          }} />{skill.name}{skill.state === "archived" ? " (Archived)" : ""}</label>)}</fieldset>
          <button type="button" className="button-secondary" onClick={() => onChange({ ...value, agents: value.agents.filter((_, i) => i !== index), conversationPresets: value.conversationPresets.map(preset => ({ ...preset, agentKeys: preset.agentKeys.filter(key => key !== agent.key) })) } as Definition)}>Remove starter agent</button>
        </section>;
      })}
      <button type="button" className="button-secondary" disabled={!addTemplate || value.agents.length >= 16} onClick={() => {
        const template = addTemplate!;
        const base = { key: crypto.randomUUID(), templateId: template.id, displayName: template.name, mentionHandle: `agent-${value.agents.length + 1}` };
        onChange({ ...value, agents: [...value.agents, resolved ? { ...base, templateVersion: template.version, configuration: { ...template.configuration } } : base] } as Definition);
      }}>Add starter agent</button>
    </fieldset>
    <label className="block text-xs font-medium">Workspace instructions<textarea aria-label="Workspace instructions" className="settings-input mt-1 min-h-28" value={value.instructions} onChange={event => onChange({ ...value, instructions: event.target.value })} /></label>
    <div className="grid gap-3 sm:grid-cols-2">{(["idleSleepTimeoutMs", "turnTimeoutMs"] as const).map(key => <label key={key} className="block text-xs font-medium">{key === "idleSleepTimeoutMs" ? "Idle sleep timeout" : "Turn timeout"}<select aria-label={key === "idleSleepTimeoutMs" ? "Idle sleep timeout" : "Turn timeout"} className="settings-input mt-1" value={value[key] ?? ""} onChange={event => {
      const next = { ...value }; if (event.target.value) next[key] = Number(event.target.value); else delete next[key]; onChange(next);
    }}><option value="">Default</option>{(key === "idleSleepTimeoutMs" ? [15, 30, 60, 240, 1440] : [30, 60, 120]).map(minutes => <option key={minutes} value={minutes * 60_000}>{minutes} minutes</option>)}</select></label>)}</div>
    <fieldset className="min-w-0 space-y-3"><legend className="mb-2 font-medium">Conversation presets</legend>
      {value.conversationPresets.map((preset, index) => <section key={index} aria-label={`Conversation preset ${index + 1}`} className="space-y-3 rounded border border-[var(--border)] p-3">
        <label className="block text-xs">Preset name<input required className="settings-input mt-1" value={preset.name} onChange={event => onChange({ ...value, conversationPresets: value.conversationPresets.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry) })} /></label>
        <label className="block text-xs">Guidance<textarea aria-label="Guidance" className="settings-input mt-1" value={preset.guidance ?? ""} onChange={event => onChange({ ...value, conversationPresets: value.conversationPresets.map((entry, i) => i === index ? { ...entry, guidance: event.target.value } : entry) })} /></label>
        <fieldset><legend className="mb-1 text-xs">Agents</legend>{value.agents.map(agent => <label key={agent.key} className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={agent.displayName} checked={preset.agentKeys.includes(agent.key)} onChange={event => onChange({ ...value, conversationPresets: value.conversationPresets.map((entry, i) => i === index ? { ...entry, agentKeys: event.target.checked ? [...entry.agentKeys, agent.key] : entry.agentKeys.filter(key => key !== agent.key) } : entry) })} />{agent.displayName}</label>)}</fieldset>
        <button type="button" className="button-secondary" onClick={() => onChange({ ...value, conversationPresets: value.conversationPresets.filter((_, i) => i !== index) })}>Remove conversation preset</button>
      </section>)}
      <button type="button" className="button-secondary" disabled={value.conversationPresets.length >= 16} onClick={() => onChange({ ...value, conversationPresets: [...value.conversationPresets, { name: "", agentKeys: [] }] })}>Add conversation preset</button>
    </fieldset>
  </div>;
}
