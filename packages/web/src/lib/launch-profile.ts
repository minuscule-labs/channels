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
