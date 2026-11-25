import { describe, expect, it } from "vitest";
import type { LocalRuntimeOptions } from "@minu/channels-control/contracts";
import {
  CHANNELS_PREFERRED_MODEL,
  CHANNELS_PREFERRED_REASONING,
  initialLaunchModel,
  initialLaunchModelForProvider,
  initialLaunchReasoning,
  launchSkillIds,
  missingSkillIds,
  missingSkillsMessage,
} from "../src/lib/launch-profile";

const options: LocalRuntimeOptions = {
  protocolVersion: 25,
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

describe("launchSkillIds", () => {
  const skills = ["a", "b"].map((id) => ({ id, name: id, description: "" }));

  it("saves no list for a Codex agent that keeps every skill", () => {
    expect(launchSkillIds("codex", { skills }, null)).toBeUndefined();
    expect(launchSkillIds("codex", { skills }, ["b", "a"])).toBeUndefined();
    expect(launchSkillIds("codex", { skills: [] }, null)).toBeUndefined();
  });

  it("saves exactly the chosen Codex skills, including none", () => {
    expect(launchSkillIds("codex", { skills }, ["a"])).toEqual(["a"]);
    expect(launchSkillIds("codex", { skills }, [])).toEqual([]);
  });

  it("keeps saving the full list for the other harnesses", () => {
    for (const adapter of ["pi", "claude-code"]) {
      expect(launchSkillIds(adapter, { skills }, null)).toEqual(["a", "b"]);
      expect(launchSkillIds(adapter, { skills }, ["b"])).toEqual(["b"]);
    }
  });
});

describe("missing skills", () => {
  it("names the selected skills that are gone, without Codex identifiers", () => {
    const skills = [{ id: "skill:review", name: "review", description: "" }];
    expect(missingSkillIds({ skills }, ["skill:review"])).toEqual([]);
    expect(missingSkillIds({ skills }, ["skill:review", "skill:gone"])).toEqual(["skill:gone"]);
    expect(missingSkillsMessage(["skill:gone"])).toBe("1 saved skill is no longer available: gone. New sessions start without it.");
    expect(missingSkillsMessage(["skill:gone", "deploy"])).toBe("2 saved skills are no longer available: gone, deploy. New sessions start without them.");
    expect(missingSkillsMessage([`codex-skill-${"a".repeat(64)}`])).toBe("1 saved skill is no longer available. New sessions start without it.");
  });
});
