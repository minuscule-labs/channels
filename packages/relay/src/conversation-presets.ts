import type { WorkspaceAgentConfig, RelayBindingStore } from "./binding-store.ts";

export interface ConversationSetup {
  participants: Array<{ identityId?: string; role: string }>;
  model?: { provider: string; id: string };
  reasoningLevel?: WorkspaceAgentConfig["reasoningLevel"];
  guidance?: string;
}

export interface ConversationPreset extends ConversationSetup {
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Immutable creation snapshot, independent of subsequent preset edits or deletion. */
export interface ConversationCreationSetup extends ConversationSetup {
  workspaceId: string;
  conversationId: string;
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
    setup.participants.length ? `Conversation role assignments (identity id and role):\n${JSON.stringify(setup.participants)}` : undefined,
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
  store: Pick<RelayBindingStore, "getWorkspaceAgentConfig" | "getConversationCreationSetup">,
  workspaceId: string,
  conversationId: string,
  identityId: string,
): Promise<WorkspaceAgentConfig | undefined> {
  const [config, setup] = await Promise.all([
    store.getWorkspaceAgentConfig(workspaceId, identityId),
    store.getConversationCreationSetup(workspaceId, conversationId),
  ]);
  return config ? applyConversationSetup(config, setup) : undefined;
}
