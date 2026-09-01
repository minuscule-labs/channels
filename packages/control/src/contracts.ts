export const LOCAL_CONTROL_PROTOCOL_VERSION = 5 as const;

export type LocalReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LocalRuntimeModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface LocalAgentRuntimeOptions {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  workspaceId: string;
  identityId: string;
  models: LocalRuntimeModelOption[];
  reasoningLevels: LocalReasoningLevel[];
}

export interface LocalCurrentSession {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  identityId: string;
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

export interface LocalChannelAgent {
  workspaceId: string;
  channelId: string;
  identityId: string;
  state: LocalChannelAgentState;
  wakePolicy?: LocalWakePolicy;
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
