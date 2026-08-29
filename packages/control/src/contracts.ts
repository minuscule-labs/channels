export const LOCAL_CONTROL_PROTOCOL_VERSION = 2 as const;

export interface LocalCurrentSession {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  identityId: string;
}

export interface LocalControlHealth {
  status: "ok";
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
}

export interface LocalControlCapabilities {
  protocolVersion: typeof LOCAL_CONTROL_PROTOCOL_VERSION;
  features: {
    currentSession: boolean;
    channelAgentStatus: boolean;
    workspaceConfigRead: boolean;
    workspaceConfigWrite: boolean;
    agentCreate: boolean;
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
