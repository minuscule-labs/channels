import { LocalControlClientError } from "@minu/channels-control/client";

export type AgentSessionAction = "start" | "start-fresh" | "reconnect" | "replace" | "replace-fresh" | "stop" | "cancel";

/** Pending lifecycle requests, kept separate from observed Runtime activity. */
export interface PendingAgentActions {
  individuals?: ReadonlyMap<string, { action: AgentSessionAction; identityId: string; requestedAt: number }>;
  bulk?: { action: "start" | "stop"; requestedAt: number; identityIds: ReadonlySet<string> };
}

export interface PendingAgentInspection {
  label: string;
  requestedAt: number;
}

export interface AgentDiagnosticsSnapshot {
  receivedAt: number;
  refreshing: boolean;
  refreshFailed: boolean;
  refreshError?: string;
  refresh(): void;
}

export function agentActionLabel(action: AgentSessionAction): string {
  switch (action) {
    case "start": return "Start agent";
    case "start-fresh": return "Fresh session";
    case "reconnect": return "Reconnect";
    case "replace": return "New session with context";
    case "replace-fresh": return "Fresh session";
    case "stop": return "Stop agent";
    case "cancel": return "Cancel current";
  }
}

export function pendingAgentInspection(identityId: string, pending: PendingAgentActions): PendingAgentInspection | undefined {
  const individual = pending.individuals?.get(identityId);
  if (individual) {
    return { label: agentActionLabel(individual.action), requestedAt: individual.requestedAt };
  }
  if (pending.bulk?.identityIds.has(identityId)) {
    return {
      label: pending.bulk.action === "start" ? "Bulk Start eligible agents" : "Bulk Stop active agents",
      requestedAt: pending.bulk.requestedAt,
    };
  }
  return undefined;
}

// Curated labels only: never render arbitrary transport errors or private server details.
export function agentStatusRequestError(error: unknown): string {
  if (error instanceof LocalControlClientError) {
    if (error.status === 401) return "Local browser session is missing or expired. Reopen Channels using its launch link.";
    if (error.status === 403) return "This browser session is not authorized to read Runtime status.";
    return `Local control status request failed (HTTP ${error.status}).`;
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "Runtime status request timed out. Refresh to try again.";
  }
  return "Runtime status request failed before a usable response was available. Check the dev server connection and refresh.";
}

/** The normal idle status poll is five seconds; a missed few polls deserves a warning. */
export function statusSnapshotIsStale(receivedAt: number, now: number): boolean {
  return receivedAt > 0 && now - receivedAt > 15_000;
}
