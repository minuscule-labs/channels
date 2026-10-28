import { describe, expect, test } from "vitest";
import { LocalControlClientError } from "@minu/channels-control/client";
import { agentActionLabel, agentStatusRequestError, pendingAgentInspection, statusSnapshotIsStale, type AgentSessionAction, type PendingAgentActions } from "../src/lib/agent-diagnostics";

describe("browser-only agent inspection", () => {
  test.each<[AgentSessionAction, string]>([
    ["start", "Start agent"], ["start-fresh", "Fresh session"], ["reconnect", "Reconnect"],
    ["replace", "New session with context"], ["replace-fresh", "Fresh session"],
    ["stop", "Stop agent"], ["cancel", "Cancel current"],
  ])("labels %s without claiming host acceptance", (action, label) => {
    expect(agentActionLabel(action)).toBe(label);
    expect(pendingAgentInspection("agent", { individuals: new Map([["agent", { action, identityId: "agent", requestedAt: 123 }]]) }))
      .toEqual({ label, requestedAt: 123 });
  });

  test("does not attribute another participant's request or an untargeted bulk request", () => {
    const pending: PendingAgentActions = {
      individuals: new Map([["one", { action: "stop", identityId: "one", requestedAt: 10 }]]),
      bulk: { action: "start", requestedAt: 20, identityIds: new Set(["two"]) },
    };
    expect(pendingAgentInspection("one", pending)).toEqual({ label: "Stop agent", requestedAt: 10 });
    expect(pendingAgentInspection("two", pending)).toEqual({ label: "Bulk Start eligible agents", requestedAt: 20 });
    expect(pendingAgentInspection("three", pending)).toBeUndefined();
    expect(pendingAgentInspection("one", {})).toBeUndefined();
    expect(pendingAgentInspection("two", { bulk: { action: "stop", requestedAt: 30, identityIds: new Set(["two"]) } }))
      .toEqual({ label: "Bulk Stop active agents", requestedAt: 30 });
  });

  test("distinguishes status request failures without exposing raw errors or asserting agents are offline", () => {
    expect(agentStatusRequestError(new LocalControlClientError("PRIVATE_SESSION_SECRET", 401))).toContain("session is missing or expired");
    expect(agentStatusRequestError(new LocalControlClientError("PRIVATE_SESSION_SECRET", 403))).toContain("not authorized");
    expect(agentStatusRequestError(new LocalControlClientError("PRIVATE_DATABASE_PATH", 502))).toBe("Local control status request failed (HTTP 502).");
    expect(agentStatusRequestError(new DOMException("PRIVATE_URL", "AbortError"))).toContain("timed out");
    expect(agentStatusRequestError(new DOMException("PRIVATE_URL", "TimeoutError"))).toContain("timed out");
    expect(agentStatusRequestError(new TypeError("PRIVATE_URL"))).not.toMatch(/PRIVATE|offline/);
  });

  test("only labels an actual old snapshot stale, allowing a few normal five-second polls", () => {
    expect(statusSnapshotIsStale(0, 100_000)).toBe(false);
    expect(statusSnapshotIsStale(1_000, 16_000)).toBe(false);
    expect(statusSnapshotIsStale(1_000, 16_001)).toBe(true);
    expect(statusSnapshotIsStale(10_000, 9_000)).toBe(false);
  });
});
