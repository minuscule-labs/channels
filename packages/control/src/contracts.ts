export const LOCAL_CONTROL_PROTOCOL_VERSION = 9 as const;

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
  channelId: string;
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
  modelConfigured: boolean;
  reasoningConfigured: boolean;
  skillsConfigured: boolean;
  selectedSkillCount: number;
  status: "active" | "disabled" | "unconfigured";
  boundChannelCount: number;
  changesApplyToNewSessions: true;
}

export interface LocalWorkspaceConfigurationSummary {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  rootConfigured: boolean;
  notesFolderConfigured: boolean;
  agents: LocalWorkspaceAgentConfigurationSummary[];
}

export interface UpdateLocalWorkspaceConfigurationInput {
  rootUri: string;
  notesFolderId?: string | null;
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
    channelAgentStatus: boolean;
    workspaceConfigRead: boolean;
    workspaceConfigWrite: boolean;
    agentCreate: boolean;
    agentRuntimeOptions: boolean;
    agentSkills: boolean;
    agentStart: boolean;
    agentReplace: boolean;
    agentStop: boolean;
    steer: boolean;
    interrupt: boolean;
    reconnect: boolean;
  };
}

export type LocalChannelAgentState =
  | "unbound"
  | "idle"
  | "running"
  | "offline"
  | "disabled"
  | "uncertain";

export type LocalWakePolicy = "mentions" | "direct_mentions" | "all_messages" | "muted";

/** Presentation-safe Relay activity; it deliberately omits Runtime/session internals. */
export interface LocalAgentActivity {
  phase: "running" | "retrying" | "canceling";
  triggerMessageId: string;
  triggerSequence: number;
  startedAt: string;
  queuedTurns: number;
  retryAttempt?: number;
}

export interface LocalChannelAgent {
  workspaceId: string;
  channelId: string;
  identityId: string;
  state: LocalChannelAgentState;
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
}

export interface LocalChannelAgentsResponse {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  channelId: string;
  agents: LocalChannelAgent[];
}
