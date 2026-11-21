import type { AccountAgentTemplateConfiguration } from "./account-library.ts";

export interface WorkspacePresetAgent {
  key: string;
  templateId: string;
  displayName: string;
  mentionHandle: string;
  accountSkillIds?: string[];
}
export interface WorkspacePresetDefinition {
  agents: WorkspacePresetAgent[];
  conversationPresets: Array<{ name: string; agentKeys: string[]; guidance?: string }>;
  instructions: string;
  idleSleepTimeoutMs?: number;
  turnTimeoutMs?: number;
}
export interface WorkspaceCompositionPlan extends Omit<WorkspacePresetDefinition, "agents"> {
  presetId: string;
  presetVersion: number;
  agents: Array<Omit<WorkspacePresetAgent, "accountSkillIds"> & { templateVersion: number; configuration: AccountAgentTemplateConfiguration }>;
}
export interface WorkspaceCompositionRequest {
  requestId: string;
  slug: string;
  name: string;
  rootUri: string;
  plan: WorkspaceCompositionPlan;
}
/** Private immutable intent, reserved before the first public resource write. */
export interface WorkspaceComposition {
  ownerIdentityId: string;
  requestId: string;
  requestHash: string;
  request: WorkspaceCompositionRequest;
  plan: WorkspaceCompositionPlan;
  workspaceId: string;
  conversationId: string;
  instructionsId: string;
  agents: Array<{ key: string; identityId: string; configId: string }>;
  conversationPresetIds: string[];
  createdAt: string;
  state: "pending" | "complete";
}
