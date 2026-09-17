import { ConversationClient } from "@minu/channels-core/client";
import {
  LocalRelayDirectory,
  type ConversationWorkingFolder,
  type RelayBindingStore,
} from "@minu/channels-relay";
import type {
  LocalAgentRuntimeOptions,
  LocalConversationWorkingFolders,
  LocalRuntimeModelOption,
  LocalRuntimeOptions,
  LocalRuntimeSkillOption,
  LocalWorkspaceAgentConfiguration,
  LocalWorkspaceAgentConfigurationSummary,
  ProvisionLocalWorkspaceResult,
  LocalWorkspaceConfigurationSummary,
} from "./contracts.ts";
import { LOCAL_CONTROL_PROTOCOL_VERSION } from "./contracts.ts";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalControlAuditEvent } from "./session.ts";

const MAX_ROOT_URI_BYTES = 8 * 1024;
const MAX_NOTES_FOLDER_ID_BYTES = 255;
const MAX_PERSONA_PROMPT_BYTES = 64 * 1024;
const MAX_RUNTIME_ADAPTER_BYTES = 100;
const MAX_MODEL_PROVIDER_BYTES = 100;
const MAX_MODEL_ID_BYTES = 300;
const MAX_SKILL_ID_BYTES = 200;
const MAX_CHANNEL_WORKING_FOLDERS = 16;

export class LocalConfigurationRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413,
    readonly reason: "invalid" | "forbidden" | "unavailable",
  ) {
    super(message);
    this.name = "LocalConfigurationRequestError";
  }
}

export interface LocalAgentHostConfigurationOptions {
  client: ConversationClient;
  store: RelayBindingStore;
  now?: () => Date;
  runtimeOptionsCacheTtlMs?: number;
  runtimes?: Readonly<Record<string, {
    capabilities?(config?: { cwd?: string }): Promise<{
      models: Array<Omit<LocalRuntimeModelOption, "enabled">>;
      reasoningLevels: LocalAgentRuntimeOptions["reasoningLevels"];
      skills: LocalRuntimeSkillOption[];
      defaultModel?: LocalAgentRuntimeOptions["defaultModel"];
      defaultReasoningLevel?: LocalAgentRuntimeOptions["defaultReasoningLevel"];
    }>;
  }>>;
  onAudit?(event: LocalControlAuditEvent): void;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalConfigurationRequestError(`${label} must be a JSON object`, 400, "invalid");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
  const hasUnknown = Object.keys(input).some((key) => !allowed.includes(key));
  if (hasUnknown) {
    throw new LocalConfigurationRequestError("Configuration contains unsupported fields", 400, "invalid");
  }
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LocalConfigurationRequestError(`${label} is required`, 400, "invalid");
  }
  if (bytes(value) > maxBytes) {
    throw new LocalConfigurationRequestError(`${label} is too large`, 400, "invalid");
  }
  return value;
}

async function canonicalWorkspaceRoot(value: string): Promise<string> {
  let path: string;
  try {
    path = value.startsWith("file:") ? fileURLToPath(value) : value;
  } catch {
    throw new LocalConfigurationRequestError("Source folder must be an absolute local path or file URL", 400, "invalid");
  }
  if (!isAbsolute(path)) {
    throw new LocalConfigurationRequestError("Source folder must be an absolute local path", 400, "invalid");
  }
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) {
      throw new LocalConfigurationRequestError("Source folder is not a directory", 409, "unavailable");
    }
    return pathToFileURL(canonical).href;
  } catch (error) {
    if (error instanceof LocalConfigurationRequestError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "EACCES" ? "cannot be accessed" : "is unavailable";
    throw new LocalConfigurationRequestError(`Source folder ${reason}`, 409, "unavailable");
  }
}

function optionalNullableString(
  value: unknown,
  label: string,
  maxBytes: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredString(value, label, maxBytes);
}

function localWorkingFolderInput(value: unknown): {
  path?: string;
  relativePath?: string;
  primary: boolean;
} {
  const input = object(value, "Working folder");
  rejectUnknown(input, ["path", "relativePath", "primary"]);
  if (typeof input.primary !== "boolean") {
    throw new LocalConfigurationRequestError("Working folder primary must be a boolean", 400, "invalid");
  }
  const path = input.path === undefined ? undefined : requiredString(input.path, "Working folder path", MAX_ROOT_URI_BYTES);
  const relativePath = input.relativePath === undefined
    ? undefined
    : requiredString(input.relativePath, "Working folder relativePath", MAX_ROOT_URI_BYTES);
  if (Boolean(path) === Boolean(relativePath)) {
    throw new LocalConfigurationRequestError(
      "Working folder requires exactly one path or relativePath",
      400,
      "invalid",
    );
  }
  return { ...(path ? { path } : {}), ...(relativePath ? { relativePath } : {}), primary: input.primary };
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  let path: string;
  try {
    path = value.startsWith("file:") ? fileURLToPath(value) : value;
  } catch {
    throw new LocalConfigurationRequestError(`${label} is unavailable`, 409, "unavailable");
  }
  if (!isAbsolute(path)) {
    throw new LocalConfigurationRequestError(`${label} is unavailable`, 409, "unavailable");
  }
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new LocalConfigurationRequestError(`${label} is unavailable`, 409, "unavailable");
  }
}

function relativePathWithinWorkspace(workspaceRoot: string, selectedPath: string): string | undefined {
  const path = relative(workspaceRoot, selectedPath);
  if (path === "") return undefined;
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path.split(sep).join("/");
}

export class LocalAgentHostConfiguration {
  private readonly directory: LocalRelayDirectory;
  private readonly now: () => Date;
  private readonly runtimeOptions = new Map<string, {
    expiresAt: number;
    value: Promise<{
      models: Array<Omit<LocalRuntimeModelOption, "enabled">>;
      reasoningLevels: LocalAgentRuntimeOptions["reasoningLevels"];
      skills: LocalRuntimeSkillOption[];
      defaultModel?: LocalAgentRuntimeOptions["defaultModel"];
      defaultReasoningLevel?: LocalAgentRuntimeOptions["defaultReasoningLevel"];
    }>;
  }>();

  constructor(private readonly options: LocalAgentHostConfigurationOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.runtimeOptionsCacheTtlMs !== undefined
      && (!Number.isSafeInteger(options.runtimeOptionsCacheTtlMs) || options.runtimeOptionsCacheTtlMs < 1)) {
      throw new RangeError("runtimeOptionsCacheTtlMs must be a positive integer");
    }
    this.directory = new LocalRelayDirectory(options.client, options.store, this.now);
  }

  async provisionWorkspace(
    actorIdentityId: string,
    value: unknown,
  ): Promise<ProvisionLocalWorkspaceResult> {
    const input = object(value, "Workspace");
    rejectUnknown(input, ["slug", "name", "rootUri"]);
    const slug = requiredString(input.slug, "slug", 63);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
      throw new LocalConfigurationRequestError("Workspace slug is invalid", 400, "invalid");
    }
    const name = requiredString(input.name, "name", 200).trim();
    const rootUri = await canonicalWorkspaceRoot(requiredString(input.rootUri, "rootUri", MAX_ROOT_URI_BYTES));
    const actor = await this.options.client.getIdentity(actorIdentityId).catch(() => undefined);
    if (actor?.type !== "human" || actor.status !== "active") {
      throw new LocalConfigurationRequestError("Active local human required", 403, "forbidden");
    }
    let workspace = (await this.options.client.listWorkspaces()).find((candidate) => candidate.slug === slug);
    if (!workspace) workspace = await this.options.client.createWorkspace({ slug, name });
    if (workspace.status !== "active") {
      throw new LocalConfigurationRequestError("Workspace is unavailable", 409, "unavailable");
    }
    const members = await this.options.client.listWorkspaceMembers(workspace.id);
    const membership = members.find((member) => member.identityId === actorIdentityId);
    if (!membership) {
      if (members.length > 0) throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
      await this.options.client.addWorkspaceMember(workspace.id, {
        identityId: actorIdentityId,
        mentionHandle: "you",
        accessRole: "owner",
        roleLabel: "owner",
      });
    } else if (membership.status !== "active"
      || (membership.accessRole !== "owner" && membership.accessRole !== "admin")) {
      throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
    }
    await this.directory.configureWorkspace({ workspaceId: workspace.id, rootUri });
    let conversation = (await this.options.client.listWorkspaceConversations(workspace.id))
      .find((candidate) => candidate.name === "General");
    if (!conversation) {
      conversation = await this.options.client.createConversation({
        workspaceId: workspace.id,
        name: "General",
        participantIds: [actorIdentityId],
        actorIdentityId,
      });
    }
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      workspaceId: workspace.id,
      conversationId: conversation.id,
    };
  }

  async getWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    const members = await this.authorize(workspaceId, actorIdentityId);
    const [workspaceConfig, configs, bindings, identities] = await Promise.all([
      this.options.store.getWorkspaceConfig(workspaceId),
      this.options.store.listWorkspaceAgentConfigs(workspaceId),
      this.options.store.listWorkspaceBindings(workspaceId),
      this.options.client.listIdentities(),
    ]);
    const identityTypes = new Map(identities.map((identity) => [identity.id, identity.type]));
    const configsByIdentity = new Map(configs.map((config) => [config.agentIdentityId, config]));
    const agents: LocalWorkspaceAgentConfigurationSummary[] = members
      .filter((member) => {
        const type = identityTypes.get(member.identityId);
        return type === "agent" || type === "service";
      })
      .map((member) => {
        const config = configsByIdentity.get(member.identityId);
        const boundConversations = new Set(bindings
          .filter((binding) => binding.agentIdentityId === member.identityId && binding.state !== "disabled")
          .map((binding) => binding.conversationId));
        return {
          identityId: member.identityId,
          configured: Boolean(config),
          personaConfigured: Boolean(config?.personaPrompt || config?.personaRef),
          runtimeConfigured: Boolean(config?.runtimeAdapter),
          ...(config?.runtimeAdapter ? { runtimeAdapter: config.runtimeAdapter } : {}),
          modelConfigured: Boolean(config?.modelProvider && config?.modelId),
          reasoningConfigured: Boolean(config?.reasoningLevel),
          skillsConfigured: config?.skillIds !== undefined,
          selectedSkillCount: config?.skillIds?.length ?? 0,
          status: config?.status ?? "unconfigured",
          boundConversationCount: boundConversations.size,
          changesApplyToNewSessions: true,
        };
      });
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      workspaceId,
      rootConfigured: Boolean(workspaceConfig?.rootUri),
      notesFolderConfigured: Boolean(workspaceConfig?.notesFolderId),
      agents,
    };
  }

  async getWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceAgentConfiguration> {
    const members = await this.authorize(workspaceId, actorIdentityId);
    if (!members.some((member) => member.identityId === agentIdentityId && member.status === "active")) {
      throw new LocalConfigurationRequestError("Agent configuration is unavailable", 404, "unavailable");
    }
    const config = await this.options.store.getWorkspaceAgentConfig(workspaceId, agentIdentityId);
    if (!config) {
      throw new LocalConfigurationRequestError("Agent configuration is unavailable", 404, "unavailable");
    }
    const instructions = config.personaPrompt
      ? { source: "inline" as const, text: config.personaPrompt }
      : config.personaRef
        ? { source: "managed_reference" as const }
        : { source: "none" as const };
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      workspaceId,
      identityId: agentIdentityId,
      instructions,
      ...(config.runtimeAdapter ? { runtimeAdapter: config.runtimeAdapter } : {}),
      ...(config.modelProvider ? { modelProvider: config.modelProvider } : {}),
      ...(config.modelId ? { modelId: config.modelId } : {}),
      ...(config.reasoningLevel ? { reasoningLevel: config.reasoningLevel } : {}),
      ...(config.skillIds ? { skillIds: [...config.skillIds] } : {}),
      status: config.status,
      changesApplyToNewSessions: true,
    };
  }

  async getConversationWorkingFolders(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationWorkingFolders> {
    const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
    const folders = await this.options.store.getConversationWorkingFolders(conversation.workspaceId, conversationId);
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      workspaceId: conversation.workspaceId,
      conversationId,
      inheritedFromWorkspace: folders.length === 0,
      folders: folders.map(({ relativePath, position, primary }) => ({
        relativePath,
        position,
        primary,
      })),
      changesApplyToNewSessions: true,
      enforcement: "advisory",
    };
  }

  async previewConversationWorkingFolder(
    conversationId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<{ relativePath: string }> {
    const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
    const selection = localWorkingFolderInput(value);
    if (!selection.path) {
      throw new LocalConfigurationRequestError("Working folder preview requires a selected path", 400, "invalid");
    }
    const workspaceConfig = await this.options.store.getWorkspaceConfig(conversation.workspaceId);
    if (!workspaceConfig?.rootUri) {
      throw new LocalConfigurationRequestError("Workspace source folder is unavailable", 409, "unavailable");
    }
    const [workspaceRoot, selected] = await Promise.all([
      canonicalDirectory(workspaceConfig.rootUri, "Workspace source folder"),
      canonicalDirectory(selection.path, "Working folder"),
    ]);
    const relativePath = relativePathWithinWorkspace(workspaceRoot, selected);
    if (!relativePath) {
      throw new LocalConfigurationRequestError("Working folder must be inside the Workspace source folder", 400, "invalid");
    }
    return { relativePath };
  }

  async updateConversationWorkingFolders(
    conversationId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<LocalConversationWorkingFolders> {
    let workspaceId: string | undefined;
    try {
      const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
      workspaceId = conversation.workspaceId;
      const input = object(value, "Conversation working folders");
      rejectUnknown(input, ["folders"]);
      if (!Array.isArray(input.folders) || input.folders.length > MAX_CHANNEL_WORKING_FOLDERS) {
        throw new LocalConfigurationRequestError(
          `folders must be an array of at most ${MAX_CHANNEL_WORKING_FOLDERS} folders`,
          400,
          "invalid",
        );
      }
      const workspaceConfig = await this.options.store.getWorkspaceConfig(conversation.workspaceId);
      if (!workspaceConfig?.rootUri) {
        throw new LocalConfigurationRequestError("Workspace source folder is unavailable", 409, "unavailable");
      }
      const workspaceRoot = await canonicalDirectory(workspaceConfig.rootUri, "Workspace source folder");
      const selectedCanonicalPaths = new Set<string>();
      const folders: ConversationWorkingFolder[] = [];
      for (const [position, candidate] of input.folders.entries()) {
        const selection = localWorkingFolderInput(candidate);
        let selected: string;
        if (selection.path) {
          selected = await canonicalDirectory(selection.path, "Working folder");
        } else {
          const displayPath = selection.relativePath!;
          if (isAbsolute(displayPath) || displayPath.includes("\0")
            || displayPath.split(/[\\/]/).includes("..")) {
            throw new LocalConfigurationRequestError("Working folder relativePath is invalid", 400, "invalid");
          }
          selected = await canonicalDirectory(resolve(workspaceRoot, displayPath), "Working folder");
        }
        const relativePath = relativePathWithinWorkspace(workspaceRoot, selected);
        if (relativePath === undefined) {
          if (selected === workspaceRoot) continue;
          throw new LocalConfigurationRequestError("Working folder must be inside the Workspace source folder", 400, "invalid");
        }
        if (bytes(relativePath) > MAX_ROOT_URI_BYTES || selectedCanonicalPaths.has(selected)) {
          throw new LocalConfigurationRequestError("Working folders contain a duplicate or oversized folder", 400, "invalid");
        }
        selectedCanonicalPaths.add(selected);
        folders.push({
          workspaceId: conversation.workspaceId,
          conversationId,
          relativePath,
          position,
          primary: selection.primary,
        });
      }
      if (folders.length > 0 && folders.filter(({ primary }) => primary).length !== 1) {
        throw new LocalConfigurationRequestError(
          "Working folders must have exactly one primary folder",
          400,
          "invalid",
        );
      }
      // Positions remain stable in source order; root-only selection intentionally becomes inheritance.
      await this.options.store.replaceConversationWorkingFolders(conversation.workspaceId, conversationId, folders);
      this.audit({
        action: "conversation.working-folders.updated",
        outcome: "accepted",
        actorIdentityId,
        workspaceId: conversation.workspaceId,
        conversationId,
      });
      return this.getConversationWorkingFolders(conversationId, actorIdentityId);
    } catch (error) {
      this.auditFailure("conversation.working-folders.updated", actorIdentityId, workspaceId, undefined, error, conversationId);
      throw error;
    }
  }

  async getWorkspaceRuntimeOptions(
    workspaceId: string,
    runtimeAdapter: string,
    actorIdentityId: string,
  ): Promise<LocalRuntimeOptions> {
    await this.authorize(workspaceId, actorIdentityId);
    if (!runtimeAdapter.trim() || !/^[a-zA-Z0-9._-]+$/.test(runtimeAdapter)) {
      throw new LocalConfigurationRequestError("Runtime adapter is invalid", 400, "invalid");
    }
    return this.resolveRuntimeOptions(workspaceId, runtimeAdapter);
  }

  async getAgentRuntimeOptions(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<LocalAgentRuntimeOptions> {
    await this.authorize(workspaceId, actorIdentityId);
    const config = await this.options.store.getWorkspaceAgentConfig(workspaceId, agentIdentityId);
    if (!config?.runtimeAdapter) {
      throw new LocalConfigurationRequestError("Agent Runtime options are unavailable", 409, "unavailable");
    }
    return {
      ...(await this.resolveRuntimeOptions(workspaceId, config.runtimeAdapter)),
      identityId: agentIdentityId,
      skillSelectionConfigured: config.skillIds !== undefined,
      selectedSkillIds: [...(config.skillIds ?? [])],
    };
  }

  async updateAgentRuntimeModelPolicy(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<LocalAgentRuntimeOptions> {
    try {
      await this.authorize(workspaceId, actorIdentityId);
      const input = object(value, "Runtime model policy");
      rejectUnknown(input, ["enabledModels"]);
      if (!Array.isArray(input.enabledModels) || input.enabledModels.length > 500) {
        throw new LocalConfigurationRequestError("enabledModels must be an array of at most 500 models", 400, "invalid");
      }
      const config = await this.options.store.getWorkspaceAgentConfig(workspaceId, agentIdentityId);
      if (!config?.runtimeAdapter) {
        throw new LocalConfigurationRequestError("Agent Runtime options are unavailable", 409, "unavailable");
      }
      const runtimeOptions = await this.getAgentRuntimeOptions(workspaceId, agentIdentityId, actorIdentityId);
      const available = new Set(runtimeOptions.models.map((model) => JSON.stringify([model.provider, model.id])));
      const seen = new Set<string>();
      const models = input.enabledModels.map((entry) => {
        const model = object(entry, "Enabled model");
        rejectUnknown(model, ["provider", "id"]);
        const provider = requiredString(model.provider, "provider", MAX_MODEL_PROVIDER_BYTES);
        const id = requiredString(model.id, "id", MAX_MODEL_ID_BYTES);
        const key = JSON.stringify([provider, id]);
        if (!available.has(key) || seen.has(key)) {
          throw new LocalConfigurationRequestError("enabledModels contains an unavailable or duplicate model", 400, "invalid");
        }
        seen.add(key);
        return { provider, id };
      });
      await this.directory.configureRuntimeModelPolicy({
        workspaceId,
        runtimeAdapter: config.runtimeAdapter,
        models,
      });
      this.audit({
        action: "runtime.models.updated",
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
        targetIdentityId: agentIdentityId,
      });
      return this.getAgentRuntimeOptions(workspaceId, agentIdentityId, actorIdentityId);
    } catch (error) {
      this.auditFailure("runtime.models.updated", actorIdentityId, workspaceId, agentIdentityId, error);
      throw error;
    }
  }

  async updateWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    try {
      await this.authorize(workspaceId, actorIdentityId);
      const input = object(value, "Workspace configuration");
      rejectUnknown(input, ["rootUri", "notesFolderId"]);
      const rootUri = await canonicalWorkspaceRoot(
        requiredString(input.rootUri, "rootUri", MAX_ROOT_URI_BYTES),
      );
      const notesFolderId = optionalNullableString(
        input.notesFolderId,
        "notesFolderId",
        MAX_NOTES_FOLDER_ID_BYTES,
      );
      await this.directory.configureWorkspace({
        workspaceId,
        rootUri,
        notesFolderId,
      });
      for (const key of this.runtimeOptions.keys()) {
        if (key.startsWith(`${workspaceId}\0`)) this.runtimeOptions.delete(key);
      }
      this.audit({
        action: "workspace.config.updated",
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
      });
      return this.getWorkspaceConfiguration(workspaceId, actorIdentityId);
    } catch (error) {
      this.auditFailure("workspace.config.updated", actorIdentityId, workspaceId, undefined, error);
      throw error;
    }
  }

  async updateWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    try {
      await this.authorize(workspaceId, actorIdentityId);
      const input = object(value, "Agent configuration");
      rejectUnknown(input, [
        "personaPrompt", "runtimeAdapter", "modelProvider", "modelId", "reasoningLevel", "skillIds", "status",
      ]);
      if (Object.keys(input).length === 0) {
        throw new LocalConfigurationRequestError("Agent configuration update is empty", 400, "invalid");
      }
      const personaPrompt = optionalNullableString(
        input.personaPrompt,
        "personaPrompt",
        MAX_PERSONA_PROMPT_BYTES,
      );
      const runtimeAdapter = optionalNullableString(
        input.runtimeAdapter,
        "runtimeAdapter",
        MAX_RUNTIME_ADAPTER_BYTES,
      );
      if (runtimeAdapter && !/^[a-zA-Z0-9._-]+$/.test(runtimeAdapter)) {
        throw new LocalConfigurationRequestError("runtimeAdapter has invalid characters", 400, "invalid");
      }
      const modelProvider = optionalNullableString(
        input.modelProvider,
        "modelProvider",
        MAX_MODEL_PROVIDER_BYTES,
      );
      const modelId = optionalNullableString(input.modelId, "modelId", MAX_MODEL_ID_BYTES);
      if ((modelProvider === null) !== (modelId === null)
        || (typeof modelProvider === "string") !== (typeof modelId === "string")) {
        throw new LocalConfigurationRequestError(
          "modelProvider and modelId must be configured together",
          400,
          "invalid",
        );
      }
      const existingConfig = await this.options.store.getWorkspaceAgentConfig(workspaceId, agentIdentityId);
      const resolvedAdapter = runtimeAdapter === undefined
        ? existingConfig?.runtimeAdapter
        : runtimeAdapter ?? undefined;
      const resolvedProvider = modelProvider === undefined
        ? existingConfig?.modelProvider
        : modelProvider ?? undefined;
      const resolvedModelId = modelId === undefined ? existingConfig?.modelId : modelId ?? undefined;
      const workspaceConfig = await this.options.store.getWorkspaceConfig(workspaceId);
      const modelPolicy = resolvedAdapter
        ? workspaceConfig?.runtimeModelPolicies?.[resolvedAdapter]
        : undefined;
      if (modelPolicy && resolvedProvider && resolvedModelId
        && !modelPolicy.some((model) => model.provider === resolvedProvider && model.id === resolvedModelId)) {
        throw new LocalConfigurationRequestError("Selected model is disabled for this Runtime", 409, "unavailable");
      }
      const reasoningLevel = input.reasoningLevel;
      const reasoningLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (reasoningLevel !== undefined && reasoningLevel !== null
        && !reasoningLevels.includes(String(reasoningLevel))) {
        throw new LocalConfigurationRequestError("reasoningLevel is invalid", 400, "invalid");
      }
      let skillIds: string[] | undefined;
      if (input.skillIds !== undefined) {
        if (!Array.isArray(input.skillIds) || input.skillIds.length > 100) {
          throw new LocalConfigurationRequestError("skillIds must be an array of at most 100 skills", 400, "invalid");
        }
        skillIds = input.skillIds.map((value) => requiredString(value, "skill id", MAX_SKILL_ID_BYTES));
        if (new Set(skillIds).size !== skillIds.length) {
          throw new LocalConfigurationRequestError("skillIds must be unique", 400, "invalid");
        }
      }
      const resolvedSkillIds = skillIds ?? existingConfig?.skillIds;
      if (resolvedSkillIds !== undefined) {
        if (!resolvedAdapter) {
          throw new LocalConfigurationRequestError("A Runtime is required to configure skills", 409, "unavailable");
        }
        const options = await this.resolveRuntimeOptions(workspaceId, resolvedAdapter);
        const available = new Set(options.skills.map(({ id }) => id));
        if (resolvedSkillIds.some((id) => !available.has(id))) {
          throw new LocalConfigurationRequestError("A selected skill is unavailable for this Runtime", 409, "unavailable");
        }
      }
      const status = input.status;
      if (status !== undefined && status !== "active" && status !== "disabled") {
        throw new LocalConfigurationRequestError("status must be active or disabled", 400, "invalid");
      }
      await this.directory.configureAgent({
        workspaceId,
        agentIdentityId,
        personaPrompt,
        runtimeAdapter,
        modelProvider,
        modelId,
        reasoningLevel: reasoningLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null | undefined,
        skillIds,
        status,
      });
      this.audit({
        action: "agent.config.updated",
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
        targetIdentityId: agentIdentityId,
      });
      return this.getWorkspaceConfiguration(workspaceId, actorIdentityId);
    } catch (error) {
      this.auditFailure("agent.config.updated", actorIdentityId, workspaceId, agentIdentityId, error);
      throw error;
    }
  }

  private async resolveRuntimeOptions(
    workspaceId: string,
    runtimeAdapter: string,
  ): Promise<LocalRuntimeOptions> {
    const runtime = this.options.runtimes?.[runtimeAdapter];
    if (!runtime?.capabilities) {
      throw new LocalConfigurationRequestError("Runtime options are unavailable", 409, "unavailable");
    }
    try {
      const workspaceConfig = await this.options.store.getWorkspaceConfig(workspaceId);
      if (!workspaceConfig?.rootUri) {
        throw new LocalConfigurationRequestError("Workspace source folder is unavailable", 409, "unavailable");
      }
      let cwd: string;
      try {
        cwd = fileURLToPath(workspaceConfig.rootUri);
      } catch {
        throw new LocalConfigurationRequestError("Workspace source folder is unavailable", 409, "unavailable");
      }
      const cacheKey = `${workspaceId}\0${runtimeAdapter}\0${cwd}`;
      let cached = this.runtimeOptions.get(cacheKey);
      if (!cached || cached.expiresAt <= Date.now()) {
        const pending = runtime.capabilities({ cwd });
        cached = { value: pending, expiresAt: Date.now() + (this.options.runtimeOptionsCacheTtlMs ?? 5_000) };
        this.runtimeOptions.set(cacheKey, cached);
        void pending.catch(() => this.runtimeOptions.delete(cacheKey));
      }
      const capabilities = await cached.value;
      const policy = workspaceConfig?.runtimeModelPolicies?.[runtimeAdapter];
      const enabled = policy
        ? new Set(policy.map((model) => JSON.stringify([model.provider, model.id])))
        : undefined;
      const defaultModel = capabilities.defaultModel
        && capabilities.models.some((model) => model.provider === capabilities.defaultModel?.provider
          && model.id === capabilities.defaultModel?.id)
        ? { ...capabilities.defaultModel }
        : undefined;
      const defaultReasoningLevel = capabilities.defaultReasoningLevel
        && capabilities.reasoningLevels.includes(capabilities.defaultReasoningLevel)
        ? capabilities.defaultReasoningLevel
        : undefined;
      return {
        protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
        workspaceId,
        models: capabilities.models.map((model) => ({
          ...model,
          enabled: enabled?.has(JSON.stringify([model.provider, model.id])) ?? true,
        })),
        reasoningLevels: capabilities.reasoningLevels,
        modelPolicyConfigured: Boolean(policy),
        skills: capabilities.skills.map((skill) => ({ ...skill })),
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
      };
    } catch (error) {
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError("Runtime options are unavailable", 409, "unavailable");
    }
  }

  private async authorizeConversation(conversationId: string, actorIdentityId: string) {
    let conversation;
    try {
      conversation = await this.options.client.getConversation(conversationId);
    } catch {
      throw new LocalConfigurationRequestError("Conversation working folders are unavailable", 404, "unavailable");
    }
    await this.authorize(conversation.workspaceId, actorIdentityId);
    return conversation;
  }

  private async authorize(workspaceId: string, actorIdentityId: string) {
    let members;
    let actor;
    try {
      const result = await Promise.all([
        this.options.client.getWorkspace(workspaceId),
        this.options.client.listWorkspaceMembers(workspaceId),
        this.options.client.getIdentity(actorIdentityId),
      ]);
      if (result[0].status !== "active") {
        throw new LocalConfigurationRequestError("Workspace is unavailable", 409, "unavailable");
      }
      members = result[1];
      actor = result[2];
    } catch (error) {
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError("Workspace is unavailable", 404, "unavailable");
    }
    const membership = members.find((member) => member.identityId === actorIdentityId);
    if (actor.type !== "human" || actor.status !== "active" || membership?.status !== "active"
      || (membership.accessRole !== "owner" && membership.accessRole !== "admin")) {
      throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
    }
    return members;
  }

  private auditFailure(
    action: "workspace.config.updated" | "conversation.working-folders.updated" | "runtime.models.updated" | "agent.config.updated",
    actorIdentityId: string,
    workspaceId: string | undefined,
    targetIdentityId: string | undefined,
    error: unknown,
    conversationId?: string,
  ): void {
    this.audit({
      action,
      outcome: "rejected",
      reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
      actorIdentityId,
      workspaceId,
      conversationId,
      targetIdentityId,
    });
  }

  private audit(event: Omit<LocalControlAuditEvent, "timestamp">): void {
    try {
      this.options.onAudit?.({ ...event, timestamp: this.now().toISOString() });
    } catch {
      // Audit sinks must not make private configuration unavailable.
    }
  }
}
