import { ConversationClient, ConversationClientError } from "@minu/channels-core/client";
import type { RelayBindingStore, WorkspaceComposition, WorkspaceAgentConfig, LocalWorkspaceConfig, AuthoredDocument, ConversationPreset } from "@minu/channels-relay";
import { LOCAL_CONTROL_PROTOCOL_VERSION, type ProvisionLocalWorkspaceResult } from "./contracts.ts";

export function compositionJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
}
function same(actual: unknown, expected: unknown) {
  if (compositionJson(actual) !== compositionJson(expected)) throw new Error("Partial workspace differs from the frozen plan; inspect before continuing");
}
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); } catch (error) { if (error instanceof ConversationClientError && error.status === 404) return undefined; throw error; }
}
async function ensure<T>(read: () => Promise<T | undefined>, create: () => Promise<T>): Promise<T> {
  const current = await read();
  if (current) return current;
  try { return await create(); } catch (error) { const committed = await read(); if (committed) return committed; throw error; }
}

/** Explicit retries reuse immutable IDs/content. Never updates an already-created resource. */
export async function executeWorkspaceComposition(client: ConversationClient, store: RelayBindingStore, record: WorkspaceComposition,
  authorize: (workspaceId: string, actor: string) => Promise<unknown>): Promise<ProvisionLocalWorkspaceResult> {
  const actor = record.ownerIdentityId;
  const result = { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, workspaceId: record.workspaceId, conversationId: record.conversationId };
  if (record.state === "complete") { await authorize(record.workspaceId, actor); return result; }
  const workspace = await ensure(() => optional(() => client.getWorkspace(record.workspaceId)),
    () => client.createWorkspace({ id: record.workspaceId, slug: record.request.slug, name: record.request.name }));
  same({ id: workspace.id, slug: workspace.slug, name: workspace.name, status: workspace.status }, { id: record.workspaceId, slug: record.request.slug, name: record.request.name, status: "active" });
  const actorIdentity = await client.getIdentity(actor);
  if (actorIdentity.type !== "human" || actorIdentity.status !== "active") throw new Error("Active account required");
  const members = await client.listWorkspaceMembers(workspace.id);
  if (!members.some(member => member.identityId === actor)) {
    if (members.length) throw new Error("Partial workspace membership changed; inspect before continuing");
    await ensure(async () => (await client.listWorkspaceMembers(workspace.id)).find(member => member.identityId === actor),
      () => client.addWorkspaceMember(workspace.id, { identityId: actor, mentionHandle: "you", accessRole: "owner", roleLabel: "owner" }));
  }
  await authorize(workspace.id, actor);
  const config: LocalWorkspaceConfig = { workspaceId: workspace.id, rootUri: record.request.rootUri,
    ...(record.plan.idleSleepTimeoutMs !== undefined ? { idleSleepTimeoutMs: record.plan.idleSleepTimeoutMs } : {}),
    ...(record.plan.turnTimeoutMs !== undefined ? { turnTimeoutMs: record.plan.turnTimeoutMs } : {}), createdAt: record.createdAt, updatedAt: record.createdAt };
  const existing = await store.getWorkspaceConfig(workspace.id);
  if (existing) same(existing, config);
  else if (!await store.createWorkspaceConfig(config)) same(await store.getWorkspaceConfig(workspace.id), config);
  for (const agent of record.plan.agents) {
    await authorize(workspace.id, actor);
    const ids = record.agents.find(item => item.key === agent.key)!;
    const identity = await ensure(() => optional(() => client.getIdentity(ids.identityId)), () => client.createIdentity({ id: ids.identityId, type: "agent", displayName: agent.displayName }));
    same({ type: identity.type, displayName: identity.displayName, publicProfile: identity.publicProfile, status: identity.status }, { type: "agent", displayName: agent.displayName, status: "active" });
    await authorize(workspace.id, actor);
    const member = await ensure(async () => (await client.listWorkspaceMembers(workspace.id)).find(item => item.identityId === ids.identityId),
      () => client.addWorkspaceMember(workspace.id, { identityId: ids.identityId, mentionHandle: agent.mentionHandle, accessRole: "member" }));
    same({ mentionHandle: member.mentionHandle, accessRole: member.accessRole, status: member.status, roleLabel: member.roleLabel, profileOverride: member.profileOverride }, { mentionHandle: agent.mentionHandle, accessRole: "member", status: "active" });
    const source = agent.configuration;
    const agentConfig: WorkspaceAgentConfig = { id: ids.configId, workspaceId: workspace.id, agentIdentityId: ids.identityId,
      personaPrompt: source.personaPrompt, runtimeAdapter: source.runtimeAdapter, modelProvider: source.modelProvider, modelId: source.modelId, reasoningLevel: source.reasoningLevel,
      accountSkills: source.accountSkillIds !== undefined ? { ownerIdentityId: actor, skillIds: [...source.accountSkillIds] } : undefined,
      skillIds: source.runtimeAdapter ? [] : undefined, status: "active", createdAt: record.createdAt, updatedAt: record.createdAt };
    await authorize(workspace.id, actor);
    const current = await store.getWorkspaceAgentConfig(workspace.id, ids.identityId);
    if (current) same(current, agentConfig);
    else if (!await store.createAgentConfig(agentConfig)) same(await store.getWorkspaceAgentConfig(workspace.id, ids.identityId), agentConfig);
  }
  await authorize(workspace.id, actor);
  const instructions: AuthoredDocument = { id: record.instructionsId, workspaceId: workspace.id, kind: "instructions", name: "Workspace instructions", description: "", content: record.plan.instructions,
    version: 1, state: "active", createdBy: actor, updatedBy: actor, createdAt: record.createdAt, updatedAt: record.createdAt };
  const currentInstructions = await store.getAuthoredDocument(workspace.id, instructions.id);
  if (currentInstructions) same(currentInstructions, { ...instructions, publishedRevision: 1 });
  else if (!await store.createAuthoredDocument(instructions, true)) throw new Error("Workspace instructions changed; inspect before continuing");
  for (const [index, entry] of record.plan.conversationPresets.entries()) {
    await authorize(workspace.id, actor);
    const preset: ConversationPreset = { id: record.conversationPresetIds[index]!, workspaceId: workspace.id, name: entry.name,
      participants: entry.agentKeys.map(key => ({ identityId: record.agents.find(agent => agent.key === key)!.identityId })),
      ...(entry.guidance ? { guidance: entry.guidance } : {}), revision: 1, createdAt: record.createdAt, updatedAt: record.createdAt };
    const current = (await store.listConversationPresets(workspace.id)).find(item => item.id === preset.id);
    if (current) same(current, preset);
    else if (!await store.putConversationPreset(preset, null)) same((await store.listConversationPresets(workspace.id)).find(item => item.id === preset.id), preset);
  }
  await authorize(workspace.id, actor);
  const conversation = await ensure(() => optional(() => client.getConversation(record.conversationId)),
    () => client.createConversation({ id: record.conversationId, workspaceId: workspace.id, name: "General", participantIds: [actor], actorIdentityId: actor }));
  same({ workspaceId: conversation.workspaceId, name: conversation.name, ids: conversation.participants.map(participant => participant.id) }, { workspaceId: workspace.id, name: "General", ids: [actor] });
  await authorize(workspace.id, actor);
  await store.completeWorkspaceComposition(actor, record.requestId);
  return result;
}
