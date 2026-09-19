export const LOCAL_CONTROL_PROTOCOL_VERSION = 17 as const;

export type LocalReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LocalRuntimeModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  enabled: boolean;
}

export interface LocalRuntimeModelRef {
  provider: string;
  id: string;
}

export interface LocalRuntimeSkillOption {
  id: string;
  name: string;
  description: string;
}

export interface LocalRuntimeOptions {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  models: LocalRuntimeModelOption[];
  reasoningLevels: LocalReasoningLevel[];
  modelPolicyConfigured: boolean;
  skills: LocalRuntimeSkillOption[];
  defaultModel?: LocalRuntimeModelRef;
  defaultReasoningLevel?: LocalReasoningLevel;
}

export interface LocalAgentRuntimeOptions extends LocalRuntimeOptions {
  identityId: string;
  skillSelectionConfigured: boolean;
  selectedSkillIds: string[];
}

export interface UpdateLocalRuntimeModelPolicyInput {
  enabledModels: LocalRuntimeModelRef[];
}

export interface LocalCurrentSession {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  identityId: string;
}

export interface ProvisionLocalWorkspaceInput {
  slug: string;
  name: string;
  rootUri: string;
}

export interface ProvisionLocalWorkspaceResult {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  conversationId: string;
}

export interface LocalControlHealth {
  status: "ok";
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
}

export interface LocalWorkspaceAgentConfigurationSummary {
  identityId: string;
  configured: boolean;
  personaConfigured: boolean;
  runtimeConfigured: boolean;
  /** Authenticated local-control display label; never exposed by public Conversation APIs. */
  runtimeAdapter?: string;
  modelConfigured: boolean;
  reasoningConfigured: boolean;
  skillsConfigured: boolean;
  selectedSkillCount: number;
  status: "active" | "disabled" | "unconfigured";
  boundConversationCount: number;
  changesApplyToNewSessions: true;
}

export interface LocalWorkspaceConfigurationSummary {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  rootConfigured: boolean;
  notesFolderConfigured: boolean;
  agents: LocalWorkspaceAgentConfigurationSummary[];
}

/** Private launch configuration returned only by authenticated local control for one agent. */
export interface LocalWorkspaceAgentConfiguration {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  identityId: string;
  instructions:
    | { source: "none" }
    | { source: "inline"; text: string }
    | { source: "managed_reference" };
  runtimeAdapter?: string;
  modelProvider?: string;
  modelId?: string;
  reasoningLevel?: LocalReasoningLevel;
  skillIds?: string[];
  status: "active" | "disabled";
  changesApplyToNewSessions: true;
}

export interface UpdateLocalWorkspaceConfigurationInput {
  rootUri: string;
  notesFolderId?: string | null;
}

/** Presentation-safe private Conversation scope; absolute Workspace paths never leave local control. */
export interface LocalConversationWorkingFolder {
  relativePath: string;
  position: number;
  primary: boolean;
}

export interface LocalConversationWorkingFolders {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  conversationId: string;
  inheritedFromWorkspace: boolean;
  folders: LocalConversationWorkingFolder[];
  changesApplyToNewSessions: true;
  enforcement: "advisory";
}

/** Complete replacement. Folder picker selections use `path`; saved rows use `relativePath`. */
export interface LocalConversationWorkingFolderPreview {
  relativePath: string;
}

export interface UpdateLocalConversationWorkingFoldersInput {
  folders: Array<{
    path?: string;
    relativePath?: string;
    primary: boolean;
  }>;
}

export interface UpdateLocalWorkspaceAgentConfigurationInput {
  personaPrompt?: string | null;
  runtimeAdapter?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  reasoningLevel?: LocalReasoningLevel | null;
  skillIds?: string[];
  status?: "active" | "disabled";
}

export interface LocalControlCapabilities {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  features: {
    currentSession: boolean;
    conversationAgentStatus: boolean;
    workspaceConfigRead: boolean;
    workspaceConfigWrite: boolean;
    conversationWorkingFolders: boolean;
    agentCreate: boolean;
    agentRuntimeOptions: boolean;
    agentSkills: boolean;
    agentStart: boolean;
    agentReplace: boolean;
    agentStop: boolean;
    agentBulkStart: boolean;
    agentBulkStop: boolean;
    steer: boolean;
    interrupt: boolean;
    reconnect: boolean;
  };
}

export type LocalConversationAgentState =
  | "unbound"
  | "starting"
  | "idle"
  | "running"
  | "disconnected"
  | "offline"
  | "disabled"
  | "uncertain";

export type LocalWakePolicy = "mentions" | "direct_mentions" | "all_messages" | "muted";

/** Presentation-safe Relay activity; it deliberately omits Runtime/session internals. */
export interface LocalAgentActivity {
  phase: "running" | "using_tools" | "responding" | "retrying" | "canceling";
  triggerMessageId: string;
  triggerSequence: number;
  startedAt: string;
  queuedTurns: number;
  queuedTurnsExact: boolean;
  retryAttempt?: number;
}

export type LocalLiveCapabilityState = "available" | "unavailable" | "not_verified";

export interface LocalAgentDiagnostics {
  connection: "connected" | "disconnected" | "offline" | "uncertain";
  phase?: LocalAgentActivity["phase"];
  startedAt?: string;
  queuedTurns: number;
  queuedTurnsExact: boolean;
  lastVerifiedAt?: string;
  capabilities: {
    safeActivityEvents: LocalLiveCapabilityState;
    interrupt: LocalLiveCapabilityState;
    reconnectExisting: LocalLiveCapabilityState;
    interactiveAttach: LocalLiveCapabilityState;
    openDiagnostic: LocalLiveCapabilityState;
    liveSkillVerification: LocalLiveCapabilityState;
  };
}

export interface LocalConversationAgent {
  workspaceId: string;
  conversationId: string;
  identityId: string;
  state: LocalConversationAgentState;
  wakePolicy?: LocalWakePolicy;
  activity?: LocalAgentActivity;
  capabilities: {
    start: boolean;
    replace: boolean;
    stop: boolean;
    steer: boolean;
    interrupt: boolean;
    reconnect: boolean;
  };
  lastVerifiedAt?: string;
  diagnostics?: LocalAgentDiagnostics;
}

export interface LocalConversationAgentsResponse {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  agents: LocalConversationAgent[];
}

export type LocalTurnFailureDiagnosticOpenState = "available" | "stale" | "unavailable";

/** Safe local projection of one durable Relay turn-failure record. */
export interface LocalTurnFailureDiagnostic {
  participant: {
    identityId: string;
    displayLabel: string;
  };
  causeCategory: "turn_timeout" | "runtime_request_timeout" | "runtime_offline" | "runtime_rejected" | "response_delivery_failed" | "unknown";
  failedAt: string;
  elapsedMs: number;
  attemptCount: number;
  deliveryOutcome: "pending" | "delivered" | "delivery_rejected" | "delivery_timed_out" | "cursor_commit_failed";
  remediation: {
    code: "retry_or_start_new_session" | "retry_request" | "reconnect_agent" | "open_runtime_diagnostic" | "check_connection_and_retry";
    label: string;
  };
  openDiagnostic: {
    state: LocalTurnFailureDiagnosticOpenState;
    /** Short-lived, opaque, browser-session-scoped action token. */
    token?: string;
  };
}

export interface LocalConversationTurnFailuresResponse {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  diagnostics: LocalTurnFailureDiagnostic[];
}

export interface LocalOpenTurnFailureDiagnosticResponse {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  status: "accepted" | "unavailable";
}

export type LocalBulkAgentLifecycleReason =
  | "already_running"
  | "already_idle"
  | "unconfigured"
  | "offline"
  | "uncertain"
  | "unavailable";

export interface LocalBulkAgentLifecycleResult {
  identityId: string;
  outcome: "started" | "stopped" | "skipped" | "failed";
  reason?: LocalBulkAgentLifecycleReason;
}

export interface LocalBulkAgentLifecycleResponse {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  results: LocalBulkAgentLifecycleResult[];
}
