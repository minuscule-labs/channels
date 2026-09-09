export const queryKeys = {
  localCurrentSession: () => ["local", "session"] as const,
  localCapabilities: () => ["local", "capabilities"] as const,
  identities: () => ["identities"] as const,
  workspaces: () => ["workspaces"] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceMembers: (workspaceId: string) => ["workspace", workspaceId, "members"] as const,
  workspaceChannels: (workspaceId: string) => ["workspace", workspaceId, "channels"] as const,
  workspaceConfiguration: (workspaceId: string) => ["workspace", workspaceId, "configuration"] as const,
  workspaceRuntimeOptions: (workspaceId: string, runtimeAdapter: string) =>
    ["workspace", workspaceId, "runtime", runtimeAdapter, "options"] as const,
  agentRuntimeOptions: (workspaceId: string, identityId: string) =>
    ["workspace", workspaceId, "agent", identityId, "runtime-options"] as const,
  channel: (channelId: string) => ["channel", channelId] as const,
  channelMessages: (channelId: string) => ["channel", channelId, "messages"] as const,
  localChannelAgents: (channelId: string) => ["local", "channel", channelId, "agents"] as const,
};
