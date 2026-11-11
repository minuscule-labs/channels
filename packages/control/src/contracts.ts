import type { DiagnosticDetail, DiagnosticHistory, DeliveryHistory, DeliveryDetail } from "@minu/channels-relay";
import type { ConversationPreset, ConversationSetup, ConversationCreationSetup, ConversationSettings } from "@minu/channels-relay";
export type { ConversationPreset, ConversationSetup, ConversationCreationSetup, ConversationSettings } from "@minu/channels-relay";

export interface LocalConversationSettings {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  settings: ConversationSettings;
}
export interface UpdateConversationSettingsInput extends ConversationSetup { expectedRevision: number }

export interface LocalConversationPresets {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  presets: ConversationPreset[];
}

export interface SaveConversationPresetInput extends Pick<ConversationPreset, "participants" | "guidance"> {
  name: string;
  expectedRevision: number | null;
}

export interface CreateLocalConversationInput extends ConversationSetup {
  /** Retain across retries so a lost response cannot create a duplicate. */
  id: string;
  name: string;
  /** Public navigation metadata, independent of the private creation setup. */
  folderId?: string | null;
  workingFolder?: { path: string } | { relativePath: string };
}

export interface LocalConversationCreationSetup {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  setup: ConversationCreationSetup | null;
}

export const LOCAL_CONTROL_PROTOCOL_VERSION = 25 as const;

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

export type LocalAuthoredDocument = import("@minu/channels-relay").AuthoredDocument;
export type LocalAuthoredDocumentRevision = import("@minu/channels-relay").AuthoredDocumentRevision;
export type LocalAuthoredDocumentSummary = Omit<LocalAuthoredDocument, "content">;

export interface LocalAuthoredSkillInvocationInput {
  documentId: string;
  source: "workspace" | "channel";
  revision: number;
  arguments: string;
  /** Explicit stable identity IDs, never mention aliases or broadcast. */
  to: string[];
}

export interface LocalAuthoredSkillInvocationReceipt extends LocalAuthoredSkillInvocationInput {
  id: string;
  requestId: string;
  workspaceId: string;
  conversationId: string;
  actorIdentityId: string;
  name: string;
  acceptedAt: string;
  /** Acceptance acknowledgment only; not a delivery or completion state. */
  acceptance: "accepted";
}

/** Explicit selection of one accepted own operation; neither field is normalized or substituted. */
export interface PublishLocalAuthoredSkillInvocationInput {
  requestId: string;
  invocationId: string;
}

/** Browser-safe observation of publication only, never retry permission or Runtime completion. */
export type LocalAuthoredSkillInvocationPublicationReceipt =
  | { requestId: string; invocationId: string; status: "not_linked" }
  | { requestId: string; invocationId: string; status: "not_observed" | "observed"; messageId: string };

/** Published authored metadata only. Catalog presence is not invocation capability. */
export interface LocalConversationAuthoredSkillCatalog {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  availability: "not_checked";
  /** Session-reference hints only; acceptance and dispatch remain authoritative. */
  agents?: Array<{
    identityId: string;
    state: "ready" | "unavailable";
    supported: boolean;
    skills: Array<{ documentId: string; source: "workspace" | "channel"; revision: number; contentHash: string }>;
    /** Sanitized configured native IDs; not a native invocation grant. */
    harness: string[];
  }>;
  skills: Array<{
    documentId: string;
    source: "workspace" | "channel";
    revision: number;
    contentHash: string;
    name: string;
    description: string;
  }>;
}

export interface LocalConversationAuthoredContext {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  capturedAt: string;
  published: import("@minu/channels-relay").AuthoredContextSnapshot;
  instructions?: string;
  agents: Array<{
    identityId: string;
    status: "not_started" | "legacy" | "applied" | "pending" | "unavailable";
    applied?: import("@minu/channels-relay").AuthoredContextReference[];
  }>;
  changesApplyToNewSessions: true;
}

export interface CreateLocalAuthoredDocumentInput {
  /** Explicit atomic save + activation; omitted retains legacy draft creation. */
  action?: "commit";
  kind: "instructions" | "skill";
  conversationId?: string;
  name?: string;
  description?: string;
  content: string;
}

export type UpdateLocalAuthoredDocumentInput = { expectedVersion: number } & (
  | { action: "save" | "commit"; name?: string; description?: string; content: string }
  | { action: "publish" | "archive" }
);

export interface LocalWorkspaceConfigurationSummary {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  rootConfigured: boolean;
  notesFolderConfigured: boolean;
  /** Absent means automatic managed-agent sleep is off. */
  idleSleepTimeoutMs?: number;
  turnTimeoutMs?: number;
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
  /** Maximum ephemeral, Conversation-derived handoff brief included when a fresh Runtime session starts. */
  handoffSummaryTokens: number;
  /** Maximum recent Conversation context included on each Runtime turn. */
  recentContextTokens: number;
  /** Maximum recent Conversation messages considered on each Runtime turn. */
  recentContextMessages: number;
  status: "active" | "disabled";
  changesApplyToNewSessions: true;
}

export interface UpdateLocalWorkspaceConfigurationInput {
  rootUri?: string;
  notesFolderId?: string | null;
  /** Null explicitly turns automatic sleep off. */
  idleSleepTimeoutMs?: number | null;
  turnTimeoutMs?: number | null;
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
  handoffSummaryTokens?: number | null;
  recentContextTokens?: number | null;
  recentContextMessages?: number | null;
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
    authoredContent?: boolean;
    authoredSkillPublication?: boolean;
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
  | "stopped"
  | "disabled"
  | "uncertain";

export type LocalWakePolicy = "mentions" | "direct_mentions" | "all_messages" | "muted";
export type LocalSessionContextMode = "with_context" | "fresh";

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
    /** Explicit owner-scoped worker shutdown/restart, independent of live status. */
    recover?: boolean;
    steer: boolean;
    interrupt: boolean;
    reconnect: boolean;
  };
  lastVerifiedAt?: string;
  diagnostics?: LocalAgentDiagnostics;
}

export type LocalAgentAction = "start" | "start-fresh" | "reconnect" | "replace" | "replace-fresh" | "stop" | "stop-runtime" | "restart-runtime" | "cancel" | "start-all" | "stop-all";

/** An exact browser intent. Reuse its ID only to inspect it, never to retry an uncertain mutation. */
export interface LocalAgentActionInput {
  requestId: string;
  action: LocalAgentAction;
  identityId?: string;
}

/** In-process lifecycle receipt, independent of optional diagnostics and Runtime status reads.
 * Missing receipts (including after host restart) mean unconfirmed, never failed or safe to replay. */
export interface LocalAgentActionReceipt extends LocalAgentActionInput {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  state: "pending" | "succeeded" | "failed" | "unconfirmed";
  requestedAt: number;
  completedAt?: number;
  error?: string;
  results?: LocalBulkAgentLifecycleResult[];
}

export interface LocalConversationAgentsResponse {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  agents: LocalConversationAgent[];
}

/** Minimal issue notice safe to show in a shared Conversation timeline. */
export interface LocalTurnFailureNotice {
  participant: {
    identityId: string;
    displayLabel: string;
  };
  /** Public Conversation sequence of the message that triggered the failed turn. */
  triggerSequence: number;
  failedAt: string;
}

export interface LocalAgentOperationHistory extends DiagnosticHistory {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  participantIdentityId: string;
  capturedAt: string;
}

export interface LocalAgentOperationDetail {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  participantIdentityId: string;
  capturedAt: string;
  coverage: "available" | "unavailable";
  /** Missing can mean unrecorded, pruned, expired, or not yet persisted. */
  detail?: DiagnosticDetail;
  relations: Array<{ kind: "bulk_parent" | "retired_session_cleanup"; operationId: string }>;
  failures: LocalOperationTurnFailure[];
  failuresUnavailable: boolean;
}

export interface LocalOperationTurnFailure extends LocalTurnFailureDiagnostic {
  /** Correlation is evidence of a targeted turn, not causation. */
  operationRelation: "targeted_trigger" | "uncorrelated" | "unavailable";
}

/** Browser-safe structural contract; Runtime remains an optional, separately versioned adapter. */
export interface LocalRuntimeSessionProfile {
  version: 1;
  capturedAt: string;
  model: { status: "verified"; provider: string; id: string } | { status: "not_verified" };
  reasoning: { status: "verified"; level: LocalReasoningLevel } | { status: "not_verified" };
  skills: { status: "verified"; commandIds: string[]; complete: boolean } | { status: "not_verified" };
}
export const LOCAL_RUNTIME_EVENT_CODES = [
  "bridge_ready", "turn_accepted", "turn_reused", "turn_rejected_conflict",
  "turn_dispatch_requested", "turn_dispatch_returned", "turn_dispatch_failed", "turn_completed", "turn_failed",
  "request_rejected_busy", "steer_requested", "steer_acknowledged", "steer_failed",
  "interrupt_requested", "interrupt_acknowledged", "interrupt_failed", "stop_requested",
] as const;
export type LocalRuntimeEventCode = typeof LOCAL_RUNTIME_EVENT_CODES[number];
export interface LocalRuntimeSessionEvents {
  version: 1;
  source: "runtime_bridge";
  capturedAt: string;
  recordingSince: string;
  eventsDropped: number;
  events: Array<{ sequence: number; observedAt: string; code: LocalRuntimeEventCode }>;
}
export interface LocalAgentDeliveryTrails {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  participantIdentityId: string;
  capturedAt: string;
  availability: "available" | "unavailable" | "changed";
  history?: DeliveryHistory;
  selected?: DeliveryDetail;
  retention: { days: number; terminalLimit: number; eventLimit: number };
}

export interface LocalAgentSessionEvents {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  participantIdentityId: string;
  capturedAt: string;
  availability: "available" | "unavailable" | "changed";
  snapshot?: LocalRuntimeSessionEvents;
}

export interface LocalAgentSessionInspection {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  participantIdentityId: string;
  capturedAt: string;
  availability: "available" | "unbound" | "unavailable" | "changed" | "conflict" | "legacy";
  recorded?: {
    bindingState: "connected" | "sleeping" | "waking" | "offline" | "replacing" | "stopping" | "paused" | "disabled";
    origin: "started" | "resumed" | "forked" | "restored" | "attached" | "migrated" | "unknown";
    adapter?: string;
    contextMode?: LocalSessionContextMode;
    activationSequence?: number;
    activatedAt?: string;
  };
  running: { status: "available"; profile: LocalRuntimeSessionProfile } | { status: "not_verified" };
  /** Saved launch profile and host limits; recent limits apply on Relay attachment, not only new Runtime sessions. */
  saved: { status: "unconfigured" | "unavailable" } | { status: "available"; profile: {
    updatedAt?: string; adapter?: string; model?: { provider: string; id: string }; reasoningLevel?: LocalReasoningLevel;
    skills: { selection: "default" | "explicit"; ids: string[]; complete: boolean };
    recentContextTokens?: number; recentContextMessages?: number; handoffSummaryTokens?: number;
  } };
  latestStart: "not_verified";
  lastStopBoundary: "not_recorded";
}

export interface LocalAgentDiagnosticReport {
  formatVersion: 1;
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  capturedAt: string;
  conversationId: string;
  participant: { identityId: string; displayLabel: string; availability: "current" | "historical_or_unavailable" };
  snapshot?: Pick<LocalConversationAgent, "state" | "diagnostics" | "lastVerifiedAt">;
  selected: LocalAgentOperationDetail;
  /** Optional independently authorized current-session snapshot; never inferred from selected history. */
  session?: LocalAgentSessionInspection;
  coverage: {
    snapshotUnavailable: boolean;
    truncated: boolean;
    notes: string[];
  };
}

/** Safe local projection of one durable Relay turn-failure record. */
export interface LocalTurnFailureDiagnostic {
  /** Public Conversation trigger; never the private trigger message reference. */
  triggerSequence: number;
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
}

export interface LocalConversationTurnFailuresResponse {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  conversationId: string;
  /** Minimal notices are visible to active Conversation participants. */
  notices: LocalTurnFailureNotice[];
  /** Detailed in-app diagnostics are restricted to active Workspace owners/admins. */
  diagnostics: LocalTurnFailureDiagnostic[];
}

export type LocalBulkAgentLifecycleReason =
  | "already_running"
  | "already_idle"
  | "unconfigured"
  | "offline"
  | "new_session_required"
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
