import { describe, expect, it } from "vitest";
import type { LocalRuntimeOptions } from "@minu/channels-control/contracts";
import {
  CHANNELS_PREFERRED_MODEL,
  CHANNELS_PREFERRED_REASONING,
  initialLaunchModel,
  initialLaunchModelForProvider,
  initialLaunchReasoning,
} from "../src/lib/launch-profile";

const options: LocalRuntimeOptions = {
  protocolVersion: 17,
  workspaceId: "workspace-test",
  models: [
    { provider: "opencode-go", id: "glm", name: "GLM", reasoning: true, enabled: true },
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, enabled: true },
  ],
  reasoningLevels: ["off", "low", "medium", "high"],
  modelPolicyConfigured: false,
  skills: [],
  defaultModel: { provider: "opencode-go", id: "glm" },
  defaultReasoningLevel: "high",
};

describe("Conversations launch preferences", () => {
  it("preselects codex Sol with medium reasoning ahead of Runtime defaults", () => {
    expect(CHANNELS_PREFERRED_MODEL).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    expect(CHANNELS_PREFERRED_REASONING).toBe("medium");
    const model = initialLaunchModel(options);
    expect(model?.id).toBe("gpt-5.6-sol");
    expect(initialLaunchReasoning(options, model)).toBe("medium");
    expect(initialLaunchModelForProvider(options, "openai-codex")?.id).toBe("gpt-5.6-sol");
  });

  it("preserves explicit selections and uses off for non-reasoning models", () => {
    const configured = initialLaunchModel(options, { provider: "opencode-go", id: "glm" });
    expect(configured?.id).toBe("glm");
    expect(initialLaunchReasoning(options, { reasoning: false })).toBe("off");
  });
});
