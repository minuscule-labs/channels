export const queryKeys = {
  identities: () => ["identities"] as const,
  workspaces: () => ["workspaces"] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceMembers: (workspaceId: string) => ["workspace", workspaceId, "members"] as const,
  workspaceChannels: (workspaceId: string) => ["workspace", workspaceId, "channels"] as const,
  channel: (channelId: string) => ["channel", channelId] as const,
  channelMessages: (channelId: string) => ["channel", channelId, "messages"] as const,
  localChannelAgents: (channelId: string) => ["local", "channel", channelId, "agents"] as const,
};
