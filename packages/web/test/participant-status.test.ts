import type { LocalConversationAgent } from "@minu/channels-control/contracts";
import { describe, expect, it } from "vitest";
import { activityLabel, runtimeStateLabel, runtimeStatusTone } from "../src/lib/participant-status";

function agent(state: LocalConversationAgent["state"]): LocalConversationAgent {
  return { workspaceId: "workspace", conversationId: "conversation", identityId: "agent", state,
    capabilities: { start: false, replace: false, stop: false, steer: false, interrupt: false, reconnect: false } };
}

describe("participant Runtime status", () => {
  it.each([
    ["idle", "idle", "Idle"],
    ["running", "working", "Working · activity unavailable"],
    ["starting", "attention", "Starting…"],
    ["disconnected", "attention", "Disconnected"],
    ["uncertain", "attention", "Connection uncertain"],
    ["offline", "inactive", "Offline"],
    ["disabled", "inactive", "Stopped"],
    ["unbound", "inactive", "Not started"],
  ] as const)("maps %s without inferring an error", (state, tone, label) => {
    expect(runtimeStatusTone(agent(state))).toBe(tone);
    expect(runtimeStateLabel(agent(state))).toBe(label);
  });

  it("treats a missing Runtime observation as unverified, not healthy or failed", () => {
    expect(runtimeStatusTone()).toBe("attention");
    expect(activityLabel()).toBeUndefined();
  });

  it("reports retrying in amber with the actual attempt", () => {
    const value = agent("running");
    value.activity = { phase: "retrying", retryAttempt: 3, triggerMessageId: "message", triggerSequence: 1, startedAt: new Date().toISOString(), queuedTurns: 0, queuedTurnsExact: true };
    expect(runtimeStatusTone(value)).toBe("attention");
    expect(runtimeStateLabel(value)).toBe("Retrying (attempt 3)");
    expect(activityLabel(value)).toBe("Retrying (attempt 3)");
  });

  it.each([
    ["running", "Working…"], ["using_tools", "Using tools…"], ["responding", "Responding…"], ["canceling", "Canceling…"],
  ] as const)("preserves the reported %s activity without inventing Thinking", (phase, label) => {
    const value = agent("running");
    value.activity = { phase, triggerMessageId: "message", triggerSequence: 1, startedAt: new Date().toISOString(), queuedTurns: 0, queuedTurnsExact: true };
    expect(activityLabel(value)).toBe(label);
    expect(runtimeStatusTone(value)).toBe("working");
  });
});
