import type {
  LocalReasoningLevel,
  LocalRuntimeModelOption,
  LocalRuntimeOptions,
} from "@minu/channels-control/contracts";

export const CHANNELS_PREFERRED_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
} as const;

export const CHANNELS_PREFERRED_REASONING: LocalReasoningLevel = "medium";

export function initialLaunchModel(
  options: LocalRuntimeOptions,
  configured?: { provider: string; id: string },
): LocalRuntimeModelOption | undefined {
  const available = (selection: { provider: string; id: string } | undefined) => selection
    ? options.models.find((model) => model.enabled
      && model.provider === selection.provider
      && model.id === selection.id)
    : undefined;
  return available(configured)
    ?? available(CHANNELS_PREFERRED_MODEL)
    ?? available(options.defaultModel)
    ?? options.models.find((model) => model.enabled);
}

export function initialLaunchModelForProvider(
  options: LocalRuntimeOptions,
  provider: string,
): LocalRuntimeModelOption | undefined {
  const models = options.models.filter((model) => model.enabled && model.provider === provider);
  return models.find((model) => model.provider === CHANNELS_PREFERRED_MODEL.provider
      && model.id === CHANNELS_PREFERRED_MODEL.id)
    ?? models.find((model) => model.provider === options.defaultModel?.provider
      && model.id === options.defaultModel?.id)
    ?? models[0];
}

export function initialLaunchReasoning(
  options: LocalRuntimeOptions,
  model: Pick<LocalRuntimeModelOption, "reasoning"> | undefined,
): LocalReasoningLevel | undefined {
  if (model && !model.reasoning) return "off";
  if (options.reasoningLevels.includes(CHANNELS_PREFERRED_REASONING)) {
    return CHANNELS_PREFERRED_REASONING;
  }
  return options.defaultReasoningLevel ?? options.reasoningLevels[0];
}

/** Codex skill ids change when a plugin updates, so an agent keeping every skill saves no list. Codex then uses its own current skills. */
export function launchSkillIds(
  runtimeAdapter: string,
  options: Pick<LocalRuntimeOptions, "skills">,
  selected: string[] | null,
): string[] | undefined {
  const available = options.skills.map(({ id }) => id);
  if (selected === null || available.every((id) => selected.includes(id))) {
    return runtimeAdapter === "codex" ? undefined : selected ?? available;
  }
  return selected;
}

/** Selected skills this harness no longer reports for the Workspace source folder. */
export function missingSkillIds(options: Pick<LocalRuntimeOptions, "skills">, selected: readonly string[]): string[] {
  return selected.filter((id) => !options.skills.some((skill) => skill.id === id));
}

/** Pi leaves a missing skill out. Codex and Claude Code refuse, because one that loads late looks the same. */
export function missingSkillsMessage(runtimeAdapter: string, ids: readonly string[]): string {
  const names = ids.filter((id) => !/^codex-skill-[a-f0-9]{64}$/.test(id)).map((id) => id.replace(/^skill:/, ""));
  const one = ids.length === 1;
  const found = `${ids.length} saved ${one ? "skill was" : "skills were"} not found in the Workspace source folder${names.length ? `: ${names.join(", ")}` : ""}.`;
  return runtimeAdapter === "pi"
    ? `${found} Sessions there start without ${one ? "it" : "them"}.`
    : `${found} Sessions may not start until ${one ? "it is" : "they are"} removed.`;
}
