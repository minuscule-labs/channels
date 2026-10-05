import type { LocalConversationAgent, LocalLiveCapabilityState } from "@minu/channels-control/contracts";

export function runtimeStateLabel(agent: LocalConversationAgent): string {
  switch (agent.state) {
    case "running": return agent.activity?.phase === "retrying"
      ? `Retrying (attempt ${agent.activity.retryAttempt ?? 1})`
      : agent.activity && agent.diagnostics?.capabilities.safeActivityEvents === "available"
        ? "Working" : "Working · activity unavailable";
    case "idle": return "Idle";
    case "unbound": return "Not started";
    case "starting": return "Starting…";
    case "disconnected": return "Disconnected";
    case "uncertain": return "Connection uncertain";
    case "offline": return "Offline";
    case "disabled": return "Stopped";
  }
}

export function runtimeStatusTone(agent?: LocalConversationAgent): "idle" | "working" | "attention" | "inactive" {
  if (!agent) return "attention";
  switch (agent.state) {
    case "idle": return "idle";
    case "running": return agent.activity?.phase === "retrying" ? "attention" : "working";
    case "starting":
    case "disconnected":
    case "uncertain": return "attention";
    case "offline":
    case "disabled":
    case "unbound": return "inactive";
  }
}

export function activityLabel(agent?: LocalConversationAgent): string | undefined {
  if (!agent?.activity) return undefined;
  switch (agent.activity.phase) {
    case "retrying": return `Retrying (attempt ${agent.activity.retryAttempt ?? 1})`;
    case "canceling": return "Canceling…";
    case "using_tools": return "Using tools…";
    case "responding": return "Responding…";
    case "running": return "Working…";
  }
}

export function liveCapabilityLabel(state: LocalLiveCapabilityState): string {
  switch (state) {
    case "available": return "Available";
    case "unavailable": return "Unavailable";
    case "not_verified": return "Not verified";
  }
}

export function elapsedLabel(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
