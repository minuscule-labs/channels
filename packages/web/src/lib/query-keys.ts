export const queryKeys = {
  localCurrentSession: () => ["local", "session"] as const,
  localCapabilities: () => ["local", "capabilities"] as const,
  identities: () => ["identities"] as const,
  workspaces: () => ["workspaces"] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceMembers: (workspaceId: string) => ["workspace", workspaceId, "members"] as const,
  workspaceConversations: (workspaceId: string) => ["workspace", workspaceId, "conversations"] as const,
  workspaceConfiguration: (workspaceId: string) => ["workspace", workspaceId, "configuration"] as const,
  workspaceAgentConfiguration: (workspaceId: string, identityId: string) =>
    ["workspace", workspaceId, "agent", identityId, "configuration"] as const,
  workspaceRuntimeOptions: (workspaceId: string, runtimeAdapter: string) =>
    ["workspace", workspaceId, "runtime", runtimeAdapter, "options"] as const,
  agentRuntimeOptions: (workspaceId: string, identityId: string) =>
    ["workspace", workspaceId, "agent", identityId, "runtime-options"] as const,
  conversation: (conversationId: string) => ["conversation", conversationId] as const,
  conversationMessages: (conversationId: string) => ["conversation", conversationId, "messages"] as const,
  localConversationAgents: (conversationId: string) => ["local", "conversation", conversationId, "agents"] as const,
  conversationWorkingFolders: (conversationId: string) => ["local", "conversation", conversationId, "working-folders"] as const,
};
