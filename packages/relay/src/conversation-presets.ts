import type { WorkspaceAgentConfig, RelayBindingStore } from "./binding-store.ts";

export interface ConversationSetup {
  participants: Array<{ identityId?: string; role?: string }>;
  model?: { provider: string; id: string };
  reasoningLevel?: WorkspaceAgentConfig["reasoningLevel"];
  guidance?: string;
}

export interface ConversationPreset {
  participants: Array<{ identityId: string }>;
  guidance?: string;
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSettings extends ConversationSetup {
  workspaceId: string;
  conversationId: string;
  revision: number;
}

/** Immutable creation snapshot, independent of subsequent preset edits or deletion. */
export interface ConversationCreationSetup extends ConversationSetup {
  /** Historical snapshot values only; never used as active timeout policy. */
  turnTimeoutMs?: number;
  idleSleepTimeoutMs?: number | null;
  workspaceId: string;
  conversationId: string;
  workingFolder?: { relativePath: string };
  /** Identifies the original folder request without persisting its absolute path. */
  workingFolderRequestHash?: string;
  actorIdentityId: string;
  name: string;
}

export function applyConversationSetup(
  config: WorkspaceAgentConfig,
  setup: ConversationSetup | undefined,
): WorkspaceAgentConfig {
  if (!setup) return config;
  const role = setup.participants.find(({ identityId }) => identityId === config.agentIdentityId)?.role;
  const guidance = [
    role ? `Your role in this Conversation: ${role}.` : undefined,
    setup.participants.some(({ role }) => role) ? `Conversation role assignments (identity id and role):\n${JSON.stringify(setup.participants.filter(({ role }) => role))}` : undefined,
    setup.guidance,
  ].filter(Boolean).join("\n\n");
  return {
    ...config,
    ...(setup.model ? { modelProvider: setup.model.provider, modelId: setup.model.id } : {}),
    ...(setup.reasoningLevel ? { reasoningLevel: setup.reasoningLevel } : {}),
    personaPrompt: [config.personaPrompt, guidance].filter(Boolean).join("\n\n") || undefined,
  };
}

export async function conversationAgentConfiguration(
  store: Pick<RelayBindingStore, "getWorkspaceAgentConfig" | "getConversationCreationSetup" | "getConversationSettings">,
  workspaceId: string,
  conversationId: string,
  identityId: string,
): Promise<WorkspaceAgentConfig | undefined> {
  const [config, setup] = await Promise.all([
    store.getWorkspaceAgentConfig(workspaceId, identityId),
    effectiveConversationSetup(store, workspaceId, conversationId),
  ]);
  return config ? applyConversationSetup(config, setup) : undefined;
}

export async function effectiveConversationSetup(
  store: Pick<RelayBindingStore, "getConversationSettings" | "getConversationCreationSetup">,
  workspaceId: string, conversationId: string,
): Promise<ConversationSetup | undefined> {
  return await store.getConversationSettings(workspaceId, conversationId)
    ?? await store.getConversationCreationSetup(workspaceId, conversationId);
}
