import type { WorkspacePresetDefinition } from "./workspace-presets.ts";

/** Private local account library. Account identity is the authenticated human identity,
 * not a workspace owner or a client-supplied account id. No runtime state is stored here. */
export interface AccountAgentTemplateConfiguration {
  personaPrompt?: string;
  runtimeAdapter?: string;
  modelProvider?: string;
  modelId?: string;
  reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Account skill identities only; workspace/harness skill selection is not copied. */
  accountSkillIds?: string[];
}

export type AccountLibraryContent =
  | { kind: "skill"; name: string; description: string; content: string }
  | { kind: "workspace-preset"; name: string; description: string; definition: WorkspacePresetDefinition }
  | { kind: "agent-template"; name: string; description: string; configuration: AccountAgentTemplateConfiguration };

export type AccountLibraryItem = AccountLibraryContent & {
  id: string;
  ownerIdentityId: string;
  version: number;
  state: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type AccountLibraryMutation = {
  expectedVersion: number;
  timestamp: string;
} & ({ action: "save"; content: AccountLibraryContent } | { action: "archive" });

/** Immutable versions use the same CAS/retirement semantics as authored documents. */
export function reviseAccountLibraryItem(current: AccountLibraryItem, mutation: AccountLibraryMutation): AccountLibraryItem | undefined {
  if (current.version !== mutation.expectedVersion || current.state !== "active"
    || (mutation.action === "save" && mutation.content.kind !== current.kind)) return undefined;
  return {
    ...current,
    ...(mutation.action === "save" ? mutation.content : { state: "archived" as const }),
    version: current.version + 1,
    updatedAt: mutation.timestamp,
  };
}
