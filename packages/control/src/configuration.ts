import { ConversationClient, ConversationClientError } from "@minu/channels-core/client";
import { isReservedMentionHandle } from "@minu/channels-core/mentions";
import { createResourceId, isResourceId } from "@minu/channels-core";
import type { ConversationMetadata } from "@minu/channels-core/types";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_HANDOFF_SUMMARY_TOKENS,
  DEFAULT_RECENT_CONTEXT_MESSAGES,
  DEFAULT_RECENT_CONTEXT_TOKENS,
  LocalRelayDirectory,
  captureAuthoredContext,
  resolveAuthoredInstructions,
  resolveAuthoredPublication,
  invocationTargetMatches,
  inspectAuthoredInvocationPublication,
  publishAuthoredInvocationMessage,
  type AuthoredSkillInvocation,
  type AgentRuntimePort,
  validateAuthoredContext,
  type AccountLibraryItem,
  type AccountLibraryContent,
  type AccountAgentTemplateConfiguration,
  type AuthoredDocument,
  type AuthoredDocumentRevision,
  type ConversationWorkingFolder,
  type RelayBindingStore,
  type ConversationSetup,
  type ConversationPreset,
  type ConversationCreationSetup,
  type ConversationSettings,
  type WorkspacePresetDefinition, type WorkspaceCompositionPlan, type WorkspaceCompositionRequest, type WorkspaceComposition,
} from "@minu/channels-relay";
import type {
  CreateWorkspaceAgentFromAccountTemplateResult,
  LocalAgentRuntimeOptions,
  LocalAuthoredDocumentSummary,
  LocalAuthoredSkillInvocationInput,
  LocalAuthoredSkillInvocationReceipt,
  LocalAuthoredSkillInvocationPublicationReceipt,
  LocalConversationAuthoredContext,
  LocalConversationAuthoredSkillCatalog,
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
import { compositionJson, executeWorkspaceComposition } from "./workspace-composition.ts";

const MAX_ROOT_URI_BYTES = 8 * 1024;
const MAX_NOTES_FOLDER_ID_BYTES = 255;
const MAX_PERSONA_PROMPT_BYTES = 64 * 1024;
const MAX_RUNTIME_ADAPTER_BYTES = 100;
const MAX_MODEL_PROVIDER_BYTES = 100;
const MAX_MODEL_ID_BYTES = 300;
const MAX_SKILL_ID_BYTES = 200;
const MAX_CHANNEL_WORKING_FOLDERS = 16;
const MAX_HANDOFF_SUMMARY_TOKENS = 8_000;
const MAX_RECENT_CONTEXT_TOKENS = 16_000;
const MAX_RECENT_CONTEXT_MESSAGES = 100;

const HARNESS_SETUP_MESSAGES: Record<string, string | undefined> = Object.freeze({
  __proto__: null as never,
  ClaudeCodeAuthRequiredError: "Claude Code is not logged in; run `claude` to sign in",
  ClaudeCodeNotInstalledError: "Claude Code is not installed; install `claude` and restart Channels",
  ClaudeCodeUnsupportedVersionError: "This Claude Code version is not supported; update `claude`",
  CodexNotInstalledError: "Codex is not installed; install `codex` and restart Channels",
  CodexAuthRequiredError: "Codex is not logged in; run `codex login`",
});

export class LocalConfigurationRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 413,
    readonly reason: "invalid" | "forbidden" | "unavailable",
    readonly actionOutcome: "failed" | "unconfirmed" = "failed",
    readonly compositionOutcome?: "rejected-before-reservation",
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
    startTurn?: AgentRuntimePort["startTurn"];
    turn?: AgentRuntimePort["turn"];
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

function conversationLabel(value: unknown, label: string): string {
  const text = requiredString(value, label, 400).trim();
  if (text.length > 100) throw new LocalConfigurationRequestError(`${label} must be at most 100 characters`, 400, "invalid");
  return text;
}

function samePresetContents(left: ConversationSetup & { name: string }, right: ConversationSetup & { name: string }): boolean {
  return left.name === right.name
    && JSON.stringify(left.participants) === JSON.stringify(right.participants)
    && left.model?.provider === right.model?.provider
    && left.model?.id === right.model?.id
    && left.reasoningLevel === right.reasoningLevel
    && left.guidance === right.guidance;
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

function optionalNullableInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LocalConfigurationRequestError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
      400,
      "invalid",
    );
  }
  return value;
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
  async listConversationPresets(workspaceId: string, actorIdentityId: string) {
    await this.authorize(workspaceId, actorIdentityId);
    return { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, presets: await this.options.store.listConversationPresets(workspaceId) };
  }

  private parseConversationSetup(input: Record<string, unknown>, requireAssignments: boolean): ConversationSetup {
    if (!Array.isArray(input.participants) || input.participants.length > 16) {
      throw new LocalConfigurationRequestError("Choose at most 16 agent roles", 400, "invalid");
    }
    const participants = input.participants.map((value) => {
      const participant = object(value, "Participant");
      rejectUnknown(participant, ["identityId", "role"]);
      const role = participant.role === undefined ? undefined : conversationLabel(participant.role, "Role");
      const identityId = participant.identityId === undefined
        ? undefined : requiredString(participant.identityId, "Agent identity", 100);
      if (requireAssignments && !identityId) {
        throw new LocalConfigurationRequestError("Assign a Workspace agent to every role", 400, "invalid");
      }
      return { ...(identityId ? { identityId } : {}), ...(role ? { role } : {}) };
    });
    const ids = participants.flatMap(({ identityId }) => identityId ? [identityId] : []);
    if (new Set(ids).size !== ids.length) throw new LocalConfigurationRequestError("Each agent can fill only one role", 400, "invalid");
    let model: ConversationSetup["model"];
    if (input.model !== undefined) {
      const value = object(input.model, "Model");
      rejectUnknown(value, ["provider", "id"]);
      model = { provider: requiredString(value.provider, "Model provider", 100), id: requiredString(value.id, "Model id", 300) };
    }
    const reasoningLevel = input.reasoningLevel;
    if (reasoningLevel !== undefined && (typeof reasoningLevel !== "string"
      || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningLevel))) {
      throw new LocalConfigurationRequestError("Reasoning level is invalid", 400, "invalid");
    }
    if (input.guidance !== undefined && (typeof input.guidance !== "string" || bytes(input.guidance) > 16 * 1024)) {
      throw new LocalConfigurationRequestError("Guidance must be text of at most 16 KiB", 400, "invalid");
    }
    const guidance = (input.guidance as string | undefined)?.trim();
    return { participants, ...(model ? { model } : {}),
      ...(reasoningLevel ? { reasoningLevel: reasoningLevel as ConversationSetup["reasoningLevel"] } : {}),
      ...(guidance ? { guidance } : {}) };
  }

  async saveConversationPreset(workspaceId: string, presetId: string, actorIdentityId: string, value: unknown): Promise<ConversationPreset> {
    await this.authorize(workspaceId, actorIdentityId);
    if (!/^preset_[0-9a-f]{32}$/.test(presetId)) throw new LocalConfigurationRequestError("Preset id is invalid", 400, "invalid");
    const input = object(value, "Preset");
    rejectUnknown(input, ["name", "expectedRevision", "participants", "guidance"]);
    const expected = input.expectedRevision;
    if (expected !== null && (!Number.isSafeInteger(expected) || (expected as number) < 1)) {
      throw new LocalConfigurationRequestError("Expected preset revision is required", 400, "invalid");
    }
    const setup = this.parseConversationSetup(input, true);
    for (const participant of input.participants as unknown[]) rejectUnknown(object(participant, "Participant"), ["identityId"]);
    const contents = { participants: setup.participants.map(({ identityId }) => ({ identityId: identityId! })),
      ...(setup.guidance ? { guidance: setup.guidance } : {}), name: conversationLabel(input.name, "Preset name") };
    const nextRevision = ((expected as number | null) ?? 0) + 1;
    const currentPreset = async () => (await this.options.store.listConversationPresets(workspaceId)).find(({ id }) => id === presetId);
    const isExactRetry = (preset: ConversationPreset): boolean =>
      preset.revision === nextRevision && samePresetContents(preset, contents);
    const current = await currentPreset();
    if (current && isExactRetry(current)) return current;
    const timestamp = this.now().toISOString();
    const preset: ConversationPreset = { ...contents, id: presetId, workspaceId,
      revision: nextRevision, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp };
    if (!await this.options.store.putConversationPreset(preset, expected as number | null)) {
      // Another copy of this exact request may have committed during the write.
      const committed = await currentPreset();
      if (committed && isExactRetry(committed)) return committed;
      throw new LocalConfigurationRequestError("Preset changed; reload presets before saving", 409, "unavailable");
    }
    return preset;
  }

  async deleteConversationPreset(workspaceId: string, presetId: string, actorIdentityId: string, value: unknown): Promise<void> {
    await this.authorize(workspaceId, actorIdentityId);
    const input = object(value, "Preset deletion");
    rejectUnknown(input, ["expectedRevision"]);
    if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) {
      throw new LocalConfigurationRequestError("Expected preset revision is required", 400, "invalid");
    }
    if (!await this.options.store.deleteConversationPreset(workspaceId, presetId, input.expectedRevision as number)) {
      throw new LocalConfigurationRequestError("Preset changed; reload presets before deleting", 409, "unavailable");
    }
  }

  async getConversationCreationSetup(conversationId: string, actorIdentityId: string) {
    const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
    const setup = await this.options.store.getConversationCreationSetup(conversation.workspaceId, conversationId);
    return { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, setup: setup ?? null };
  }

  async createConversationWithSetup(workspaceId: string, actorIdentityId: string, value: unknown): Promise<ConversationMetadata> {
    const members = await this.authorize(workspaceId, actorIdentityId);
    const input = object(value, "Conversation");
    rejectUnknown(input, ["workingFolder", "id", "name", "folderId", "participants", "model", "reasoningLevel", "guidance"]);
    if (!isResourceId(input.id, "conversation")) throw new LocalConfigurationRequestError("Conversation id is invalid", 400, "invalid");
    const folderId = input.folderId ?? null;
    if (folderId !== null && !isResourceId(folderId, "folder")) {
      throw new LocalConfigurationRequestError("Folder id is invalid", 400, "invalid");
    }
    const original = await this.options.store.getConversationCreationSetup(workspaceId, input.id);
    const existing = await this.options.client.getConversation(input.id).catch((error) => {
      if (error instanceof ConversationClientError && error.status === 404) return undefined;
      throw error;
    });
    let folder: Pick<ConversationCreationSetup, "workingFolder" | "workingFolderRequestHash"> = {};
    if (input.workingFolder !== undefined) {
      const candidate = object(input.workingFolder, "Working folder");
      rejectUnknown(candidate, ["path", "relativePath"]);
      const selection = localWorkingFolderInput({ ...candidate, primary: true });
      const workingFolderRequestHash = createHash("sha256").update(JSON.stringify([selection.path ?? null, selection.relativePath ?? null])).digest("hex");
      // Recover a committed request even if its folder or Workspace source moved
      // since publication. Absolute folder paths are never saved in the snapshot.
      folder = { workingFolderRequestHash, workingFolder: existing?.workspaceId === workspaceId && original?.workingFolderRequestHash === workingFolderRequestHash
        ? original.workingFolder : await this.creationWorkingFolder(workspaceId, input.workingFolder) };
    }
    const setup: ConversationCreationSetup = { ...this.parseConversationSetup(input, true), workspaceId,
      conversationId: input.id, actorIdentityId, name: conversationLabel(input.name, "Conversation name"), ...folder };
    // A retry may find the public Conversation even when the first response was lost.
    if (original && JSON.stringify(original) !== JSON.stringify(setup)) {
      throw new LocalConfigurationRequestError("Creation request changed; start a new draft", 409, "unavailable");
    }
    if (existing) {
      if (original && existing.workspaceId === workspaceId) {
        if ((existing.folderId ?? null) !== folderId) {
          throw new LocalConfigurationRequestError("Creation request changed; start a new draft", 409, "unavailable");
        }
        return existing;
      }
      throw new LocalConfigurationRequestError("Conversation id is already in use", 409, "unavailable");
    }
    if (folderId !== null && !(await this.options.client.listWorkspaceFolders(workspaceId)).some(folder => folder.id === folderId)) {
      throw new LocalConfigurationRequestError("Folder is unavailable in this Workspace", 404, "unavailable");
    }
    await this.validateConversationAgents(workspaceId, setup, members);
    // Persist before publication: an agent can never start without its reviewed settings.
    const saved = await this.options.store.putConversationCreationSetup(setup);
    if (JSON.stringify(saved) !== JSON.stringify(setup)) {
      throw new LocalConfigurationRequestError("Creation request changed; start a new draft", 409, "unavailable");
    }
    if (setup.workingFolder) {
      await this.options.store.initializeConversationWorkingFolders(workspaceId, setup.conversationId,
        setup.workingFolder.relativePath === "." ? [] : [{ workspaceId, conversationId: setup.conversationId,
          relativePath: setup.workingFolder.relativePath, position: 0, primary: true }]);
    }
    try {
      return await this.options.client.createConversation({ id: input.id, workspaceId, name: setup.name, folderId,
        participantIds: [actorIdentityId, ...setup.participants.map(({ identityId }) => identityId!)], actorIdentityId });
    } catch (error) {
      if (error instanceof ConversationClientError && error.status === 409) {
        const created = await this.options.client.getConversation(input.id);
        if (created.workspaceId === workspaceId && (created.folderId ?? null) === folderId) return created;
      }
      throw error;
    }
  }

  private async creationWorkingFolder(workspaceId: string, value: unknown): Promise<{ relativePath: string }> {
    const selection = object(value, "Working folder");
    rejectUnknown(selection, ["path", "relativePath"]);
    const input = localWorkingFolderInput({ ...selection, primary: true });
    const config = await this.options.store.getWorkspaceConfig(workspaceId);
    if (!config?.rootUri) throw new LocalConfigurationRequestError("Configure the Workspace source folder first", 409, "unavailable");
    const root = await canonicalDirectory(config.rootUri, "Workspace source folder");
    const path = input.relativePath;
    if (path && (isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes(".."))) {
      throw new LocalConfigurationRequestError("Working folder relativePath is invalid", 400, "invalid");
    }
    const selected = await canonicalDirectory(input.path ?? resolve(root, path!), "Working folder");
    const relativePath = relativePathWithinWorkspace(root, selected);
    if (selected !== root && relativePath === undefined) {
      throw new LocalConfigurationRequestError("Working folder must be inside the Workspace source folder", 400, "invalid");
    }
    return { relativePath: relativePath ?? "." };
  }

  private async validateConversationAgents(workspaceId: string, setup: ConversationSetup,
    members: Awaited<ReturnType<ConversationClient["listWorkspaceMembers"]>>): Promise<void> {
    const identities = await this.options.client.listIdentities();
    for (const participant of setup.participants) {
      const identity = identities.find(({ id }) => id === participant.identityId);
      if (!identity || identity.type !== "agent" || identity.status !== "active"
        || !members.some((member) => member.identityId === identity.id && member.status === "active")) {
        throw new LocalConfigurationRequestError("A selected Workspace agent is unavailable; review participants", 409, "unavailable");
      }
      if (setup.model || setup.reasoningLevel) {
        const config = await this.options.store.getWorkspaceAgentConfig(workspaceId, identity.id);
        if (!config?.runtimeAdapter || config.status !== "active") {
          throw new LocalConfigurationRequestError("Configure each agent before choosing Conversation launch defaults", 409, "unavailable");
        }
        const options = await this.resolveRuntimeOptions(workspaceId, config.runtimeAdapter);
        const modelRef = setup.model ?? (config.modelProvider && config.modelId
          ? { provider: config.modelProvider, id: config.modelId } : options.defaultModel);
        const model = options.models.find((candidate) => candidate.enabled
          && candidate.provider === modelRef?.provider && candidate.id === modelRef?.id);
        const reasoningLevel = setup.reasoningLevel ?? config.reasoningLevel;
        if (setup.model && !model) {
          throw new LocalConfigurationRequestError("Conversation model is unavailable for a selected agent", 409, "unavailable");
        }
        if (reasoningLevel && !options.reasoningLevels.includes(reasoningLevel)) {
          throw new LocalConfigurationRequestError("Conversation reasoning level is unavailable for a selected agent", 409, "unavailable");
        }
        if (model && !model.reasoning && reasoningLevel && reasoningLevel !== "off") {
          throw new LocalConfigurationRequestError("Selected model does not support reasoning; choose off for Conversation effort", 409, "unavailable");
        }
      }
    }
  }

  async getConversationSettings(conversationId: string, actorIdentityId: string) {
    const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
    const sourceId = conversation.thread?.parentConversationId ?? conversationId;
    const stored = await this.options.store.getConversationSettings(conversation.workspaceId, sourceId);
    const setup = stored ?? await this.options.store.getConversationCreationSetup(conversation.workspaceId, sourceId);
    return { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, settings: {
      ...this.parseConversationSetup({ ...setup, participants: setup?.participants ?? [] }, false),
      workspaceId: conversation.workspaceId, conversationId: sourceId, revision: stored?.revision ?? 0,
    } };
  }

  async updateConversationSettings(conversationId: string, actorIdentityId: string, value: unknown) {
    const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
    if (conversation.thread) throw new LocalConfigurationRequestError("Threads inherit parent Conversation settings", 409, "unavailable");
    const members = await this.authorize(conversation.workspaceId, actorIdentityId);
    const input = object(value, "Conversation settings");
    rejectUnknown(input, ["expectedRevision", "participants", "model", "reasoningLevel", "guidance"]);
    if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
      throw new LocalConfigurationRequestError("Expected settings revision is required", 400, "invalid");
    }
    const expected = input.expectedRevision as number;
    const setup = this.parseConversationSetup(input, true);
    const previous = await this.options.store.getConversationSettings(conversation.workspaceId, conversationId);
    if (previous?.revision === expected + 1 && samePresetContents({ ...previous, name: "" }, { ...setup, name: "" })) {
      return { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, settings: previous };
    }
    if ((previous?.revision ?? 0) !== expected) {
      throw new LocalConfigurationRequestError("Settings changed; reload before saving", 409, "unavailable");
    }
    if (setup.participants.some(({ identityId }) => !conversation.participants.some((participant) => participant.id === identityId && participant.status === "active"))) {
      throw new LocalConfigurationRequestError("Participants changed; reload before saving settings", 409, "unavailable");
    }
    const identities = await this.options.client.listIdentities();
    const activeAgents = conversation.participants.filter((participant) => participant.status === "active"
      && identities.some((identity) => identity.id === participant.id && identity.type === "agent"));
    await this.validateConversationAgents(conversation.workspaceId, { ...setup,
      participants: activeAgents.map(({ id }) => ({ identityId: id, role: setup.participants.find(({ identityId }) => identityId === id)?.role ?? "Collaborator" })) }, members);
    const settings: ConversationSettings = { ...setup, workspaceId: conversation.workspaceId, conversationId, revision: expected + 1 };
    if (!await this.options.store.putConversationSettings(settings, expected)) {
      const current = await this.options.store.getConversationSettings(conversation.workspaceId, conversationId);
      if (!current || current.revision !== expected + 1
        || !samePresetContents({ ...current, name: "" }, { ...settings, name: "" })) {
        throw new LocalConfigurationRequestError("Settings changed; reload before saving", 409, "unavailable");
      }
      return { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, settings: current };
    }
    return { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, settings };
  }

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

  private readonly compositionFlights = new Map<string, Promise<ProvisionLocalWorkspaceResult>>();

  async listWorkspaceCompositions(actor: string) {
    await this.authorizeAccount(actor);
    return (await this.options.store.listWorkspaceCompositions(actor)).map(record => ({ requestId: record.requestId, name: record.request.name, workspaceId: record.workspaceId, state: record.state, createdAt: record.createdAt }));
  }

  async getWorkspaceComposition(requestId: string, actor: string): Promise<WorkspaceComposition> {
    await this.authorizeAccount(actor);
    const record = await this.options.store.getWorkspaceComposition(actor, requestId);
    if (!record) throw new LocalConfigurationRequestError("Workspace creation receipt unavailable", 404, "unavailable");
    return record;
  }

  async composeWorkspace(actor: string, value: unknown): Promise<ProvisionLocalWorkspaceResult> {
    let reservationMayExist = false;
    try {
    await this.authorizeAccount(actor);
    const identity = await this.options.client.getIdentity(actor);
    if (identity.status !== "active") throw new LocalConfigurationRequestError("Active account required", 403, "forbidden");
    const input = object(value, "Workspace composition");
    rejectUnknown(input, ["requestId", "slug", "name", "rootUri", "plan"]);
    const requestId = requiredString(input.requestId, "requestId", 128);
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) throw new LocalConfigurationRequestError("Invalid creation request id", 400, "invalid");
    const slug = requiredString(input.slug, "slug", 63);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new LocalConfigurationRequestError("Invalid workspace slug", 400, "invalid");
    const name = requiredString(input.name, "Workspace name", 200).trim();
    const rootUri = await canonicalWorkspaceRoot(requiredString(input.rootUri, "rootUri", MAX_ROOT_URI_BYTES));
    const request = { requestId, slug, name, rootUri, plan: input.plan } as WorkspaceCompositionRequest;
    const requestHash = createHash("sha256").update(compositionJson(request)).digest("hex");
    let record = await this.options.store.getWorkspaceComposition(actor, requestId);
    reservationMayExist = record !== undefined;
    if (!record) {
      const planInput = object(input.plan, "Workspace plan");
      const preset = await this.getAccountLibraryItem(requiredString(planInput.presetId, "Preset id", 100), actor);
      if (preset.kind !== "workspace-preset" || preset.state !== "active") throw new LocalConfigurationRequestError("Workspace preset unavailable", 404, "unavailable");
      if (preset.version !== planInput.presetVersion) throw new LocalConfigurationRequestError("Workspace preset changed; review again", 409, "unavailable");
      const plan = await this.parseWorkspacePreset(input.plan, actor, true) as WorkspaceCompositionPlan;
      // A failed reservation dispatch can still have committed: never label it rejected.
      reservationMayExist = true;
      record = await this.options.store.reserveWorkspaceComposition({ ownerIdentityId: actor, requestId, requestHash, request, plan,
        workspaceId: createResourceId("workspace"), conversationId: createResourceId("conversation"), instructionsId: randomUUID(),
        agents: plan.agents.map(agent => ({ key: agent.key, identityId: createResourceId("identity"), configId: createResourceId("config") })),
        conversationPresetIds: plan.conversationPresets.map(() => `preset_${randomUUID().replaceAll("-", "")}`), createdAt: this.now().toISOString(), state: "pending" });
    }
    if (record.requestHash !== requestHash) throw new LocalConfigurationRequestError("Creation request changed; inspect the original receipt", 409, "unavailable");
    const key = JSON.stringify([actor, requestId]);
    let flight = this.compositionFlights.get(key);
    if (!flight) {
      const frozen = record;
      flight = executeWorkspaceComposition(this.options.client, this.options.store, frozen, (workspaceId, identityId) => this.authorize(workspaceId, identityId))
        .catch(error => {
          if (error instanceof LocalConfigurationRequestError && [401, 403, 404].includes(error.status)) throw error;
          throw new LocalConfigurationRequestError("Workspace creation is incomplete; inspect its receipt and retry the same request", 409, "unavailable", "unconfirmed");
        });
      this.compositionFlights.set(key, flight);
    }
    try { return await flight; } finally { if (this.compositionFlights.get(key) === flight) this.compositionFlights.delete(key); }
    } catch (error) {
      if (!reservationMayExist && error instanceof LocalConfigurationRequestError && [400, 404, 409, 413].includes(error.status)) {
        throw new LocalConfigurationRequestError(error.message, error.status, error.reason, error.actionOutcome, "rejected-before-reservation");
      }
      throw error;
    }
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

  private async authorizeInvocationActor(conversationId: string, actorIdentityId: string) {
    let conversation;
    try {
      conversation = await this.options.client.getConversation(conversationId);
    } catch {
      throw new LocalConfigurationRequestError("Conversation is unavailable", 404, "unavailable");
    }
    let workspace;
    let members;
    let actor;
    try {
      [workspace, members, actor] = await Promise.all([
        this.options.client.getWorkspace(conversation.workspaceId),
        this.options.client.listWorkspaceMembers(conversation.workspaceId),
        this.options.client.getIdentity(actorIdentityId),
      ]);
    } catch {
      throw new LocalConfigurationRequestError("Workspace is unavailable", 404, "unavailable");
    }
    if (workspace.status !== "active") throw new LocalConfigurationRequestError("Workspace is unavailable", 409, "unavailable");
    if (actor.type !== "human" || actor.status !== "active"
      || !members.some(member => member.identityId === actorIdentityId && member.status === "active")
      || !conversation.participants.some(participant => participant.id === actorIdentityId
        && participant.type === "human" && participant.status === "active")) {
      throw new LocalConfigurationRequestError("An active human workspace member and participant is required", 403, "forbidden");
    }
    return conversation;
  }

  private invocationInput(value: unknown): LocalAuthoredSkillInvocationInput {
    const input = object(value, "Skill invocation");
    rejectUnknown(input, ["documentId", "source", "revision", "arguments", "to"]);
    const documentId = requiredString(input.documentId, "documentId", MAX_SKILL_ID_BYTES);
    if (input.source !== "workspace" && input.source !== "channel") {
      throw new LocalConfigurationRequestError("Only authored workspace/channel invocation is supported", 400, "invalid");
    }
    const revision = optionalNullableInteger(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER - 1);
    if (revision == null) throw new LocalConfigurationRequestError("revision is required", 400, "invalid");
    if (typeof input.arguments !== "string" || bytes(input.arguments) > MAX_PERSONA_PROMPT_BYTES) {
      throw new LocalConfigurationRequestError("arguments must be a string of at most 64 KiB", 400, "invalid");
    }
    if (!Array.isArray(input.to)) {
      throw new LocalConfigurationRequestError("Recipients must be an array", 400, "invalid");
    }
    const to = input.to.map(value => requiredString(value, "Recipient", 200)).sort();
    if (new Set(to).size !== to.length) throw new LocalConfigurationRequestError("Recipients must be unique", 400, "invalid");
    return { documentId, source: input.source, revision, arguments: input.arguments, to };
  }

  private invocationReceipt(record: AuthoredSkillInvocation): LocalAuthoredSkillInvocationReceipt {
    return { id: record.id, requestId: record.requestId, workspaceId: record.workspaceId, conversationId: record.conversationId,
      actorIdentityId: record.actorIdentityId, documentId: record.documentId, source: record.source, revision: record.revision,
      arguments: record.arguments, to: record.to ?? record.targets.map(target => target.identityId), name: record.name,
      acceptedAt: record.acceptedAt, acceptance: "accepted" };
  }

  async getAuthoredSkillInvocation(conversationId: string, actorIdentityId: string, requestId: string): Promise<LocalAuthoredSkillInvocationReceipt> {
    requiredString(requestId, "requestId", 255);
    const conversation = await this.authorizeInvocationActor(conversationId, actorIdentityId);
    const record = await this.options.store.getAuthoredSkillInvocation(conversationId, actorIdentityId, requestId);
    if (!record || record.workspaceId !== conversation.workspaceId) {
      throw new LocalConfigurationRequestError("Invocation receipt is unavailable", 404, "unavailable");
    }
    await this.authorizeInvocationActor(conversationId, actorIdentityId);
    return this.invocationReceipt(record);
  }

  async getAuthoredSkillInvocationPublication(
    conversationId: string, actorIdentityId: string, requestId: string,
  ): Promise<LocalAuthoredSkillInvocationPublicationReceipt> {
    // Reuse own-receipt authorization/validation, including 404 for another
    // active human's request. The selector always comes from the browser actor.
    const receipt = await this.getAuthoredSkillInvocation(conversationId, actorIdentityId, requestId);
    try {
      const observation = await inspectAuthoredInvocationPublication(this.options.store, this.options.client, {
        workspaceId: receipt.workspaceId, conversationId, actorIdentityId, requestId,
      });
      // Explicit projection: never expose private fields if inspection grows.
      return observation.status === "not_linked"
        ? { requestId, invocationId: observation.invocationId, status: observation.status }
        : { requestId, invocationId: observation.invocationId, status: observation.status, messageId: observation.messageId };
    } catch {
      throw new LocalConfigurationRequestError("Skill invocation publication is unavailable", 409, "unavailable");
    }
  }

  async publishAuthoredSkillInvocation(
    conversationId: string, actorIdentityId: string, value: unknown, assertSession?: () => void,
  ): Promise<LocalAuthoredSkillInvocationPublicationReceipt> {
    const input = object(value, "Skill publication");
    rejectUnknown(input, ["requestId", "invocationId"]);
    const requestId = requiredString(input.requestId, "requestId", 255);
    const invocationId = requiredString(input.invocationId, "invocationId", 128);
    const receipt = await this.getAuthoredSkillInvocation(conversationId, actorIdentityId, requestId);
    if (receipt.id !== invocationId) throw new LocalConfigurationRequestError("Accepted invocation does not match", 409, "invalid");
    try {
      const context = { workspaceId: receipt.workspaceId, conversationId, actorIdentityId, requestId };
      const observation = await inspectAuthoredInvocationPublication(this.options.store, this.options.client, context);
      assertSession?.();
      if (observation.status === "observed") {
        return { requestId, invocationId, status: "observed", messageId: observation.messageId };
      }
      if (observation.status !== "not_linked") {
        throw new LocalConfigurationRequestError("Publication outcome is unresolved; inspect the original receipt", 409, "unavailable");
      }
      // Only this reservation's creator may post. A concurrent writer retaining
      // an existing link is uncertainty, never implicit permission to resend.
      const message = await publishAuthoredInvocationMessage(this.options.store, this.options.client, context,
        { requireNewLink: true, assertSession });
      return { requestId, invocationId, status: "observed", messageId: message.id };
    } catch (error) {
      assertSession?.();
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError("Skill invocation publication is unavailable; inspect the original receipt", 409, "unavailable");
    }
  }

  async acceptAuthoredSkillInvocation(
    conversationId: string, actorIdentityId: string, requestId: string, value: unknown,
  ): Promise<LocalAuthoredSkillInvocationReceipt> {
    let workspaceId: string | undefined;
    try {
      requiredString(requestId, "requestId", 255);
      const conversation = await this.authorizeInvocationActor(conversationId, actorIdentityId);
      workspaceId = conversation.workspaceId;
      const input = this.invocationInput(value);
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const existing = await this.options.store.getAuthoredSkillInvocation(conversationId, actorIdentityId, requestId);
      if (existing) {
        if (existing.workspaceId !== workspaceId || existing.requestHash !== requestHash) {
          throw new LocalConfigurationRequestError("Request identity already used with a different payload", 409, "invalid");
        }
        // Resolving an old acknowledgment is not accepting or dispatching new work.
        await this.authorizeInvocationActor(conversationId, actorIdentityId);
        return this.invocationReceipt(existing);
      }
      if ((await this.options.client.getConversationLifecycle(conversationId)).state !== "active") {
        throw new LocalConfigurationRequestError("Conversation is not active", 409, "unavailable");
      }
      const channelId = conversation.thread?.parentConversationId ?? conversationId;
      const document = await this.options.store.getAuthoredDocument(workspaceId, input.documentId);
      if (!document || document.kind !== "skill"
        || document.conversationId !== (input.source === "channel" ? channelId : undefined)) {
        throw new LocalConfigurationRequestError("Skill is unavailable", 404, "unavailable");
      }
      if (document.state !== "active" || !document.publishedRevision || document.publishedRevision < input.revision) {
        throw new LocalConfigurationRequestError("Skill publication is unavailable", 409, "unavailable");
      }
      const members = await this.options.client.listWorkspaceMembers(workspaceId);
      const targets: AuthoredSkillInvocation["targets"] = [];
      const publication = (await this.options.store.listAuthoredDocumentRevisions(workspaceId, input.documentId))
        .find(row => row.revision === input.revision);
      if (!publication) throw new LocalConfigurationRequestError("Skill publication is unavailable", 409, "unavailable");
      const contentHash = publication.contentHash;
      await resolveAuthoredPublication(this.options.store, { schemaVersion: 1, workspaceId, channelId, documents: [] },
        { documentId: input.documentId, kind: "skill", source: input.source, revision: input.revision, contentHash });
      for (const identityId of input.to) {
        if (identityId === "@conversation") continue;
        const participant = conversation.participants.find(participant => participant.id === identityId);
        if (!participant || participant.status !== "active"
          || members.find(member => member.identityId === identityId)?.status !== "active") {
          throw new LocalConfigurationRequestError("Recipient is unavailable", 409, "unavailable");
        }
        const identity = await this.options.client.getIdentity(identityId).catch(() => undefined);
        if (!identity || identity.status !== "active") {
          throw new LocalConfigurationRequestError("Recipient is unavailable", 409, "unavailable");
        }
        // Acceptance records message intent, not an agent/session capability grant.
        const { bindings } = await this.options.store.getSessionInspectionRecords(workspaceId, conversationId, identityId);
        if (bindings.length === 1) targets.push({ identityId, bindingId: bindings[0]!.id, generation: bindings[0]!.generation });
      }
      const fresh = await this.authorizeInvocationActor(conversationId, actorIdentityId);
      if (fresh.workspaceId !== workspaceId || (fresh.thread?.parentConversationId ?? conversationId) !== channelId
        || input.to.some(id => id !== "@conversation" && !fresh.participants.some(participant => participant.id === id && participant.status === "active"))) {
        throw new LocalConfigurationRequestError("Invocation scope changed", 409, "unavailable");
      }
      const record = await this.options.store.reserveAuthoredSkillInvocation({
        id: randomUUID(), workspaceId, conversationId, channelId, actorIdentityId, requestId, requestHash,
        documentId: input.documentId, source: input.source, revision: input.revision, contentHash,
        name: publication.name, arguments: input.arguments, targets, to: input.to, acceptedAt: this.now().toISOString(),
      });
      if (!record) throw new LocalConfigurationRequestError("Invocation state changed; inspect the receipt before retrying", 409, "unavailable");
      if (record.requestHash !== requestHash) throw new LocalConfigurationRequestError("Request identity already used with a different payload", 409, "invalid");
      this.audit({ action: "skill.invocation.accepted", outcome: "accepted", actorIdentityId, workspaceId, conversationId });
      return this.invocationReceipt(record);
    } catch (error) {
      this.auditFailure("skill.invocation.accepted", actorIdentityId, workspaceId, undefined, error, conversationId);
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError("Skill invocation is unavailable; inspect the receipt before retrying", 409, "unavailable");
    }
  }

  async getConversationAuthoredSkillCatalog(conversationId: string, actorIdentityId: string): Promise<LocalConversationAuthoredSkillCatalog> {
    const conversation = await this.authorizeInvocationActor(conversationId, actorIdentityId);
    const channelId = conversation.thread?.parentConversationId ?? conversationId;
    try {
      const select = (documents: AuthoredDocument[]) => documents.filter(document => document.kind === "skill"
        && document.state === "active" && document.publishedRevision !== undefined
        && (document.conversationId === undefined || document.conversationId === channelId))
        .sort((left, right) => left.id.localeCompare(right.id));
      const documents = select(await this.options.store.listAuthoredDocuments(conversation.workspaceId));
      // Discovery observes publication heads once; acceptance and delivery validate later use.
      const skills: LocalConversationAuthoredSkillCatalog["skills"] = [];
      for (const document of documents) {
        const publication = (await this.options.store.listAuthoredDocumentRevisions(conversation.workspaceId, document.id))
          .find(value => value.revision === document.publishedRevision);
        if (!publication || publication.workspaceId !== conversation.workspaceId || publication.documentId !== document.id
          || publication.contentHash !== createHash("sha256").update(JSON.stringify({
            name: publication.name, description: publication.description, content: publication.content,
          })).digest("hex")) throw new Error();
        const source = document.conversationId === undefined ? "workspace" as const : "channel" as const;
        // Project published metadata only; never return the mutable draft or private procedure.
        skills.push({ documentId: document.id, source, revision: publication.revision, contentHash: publication.contentHash,
          name: publication.name, description: publication.description });
      }
      const agents: NonNullable<LocalConversationAuthoredSkillCatalog["agents"]> = [];
      for (const participant of conversation.participants.filter(value => value.status === "active" && (value.type === "agent" || value.type === "service"))) {
        const [config, records] = await Promise.all([
          this.options.store.getWorkspaceAgentConfig(conversation.workspaceId, participant.id),
          this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, participant.id),
        ]);
        const binding = records.bindings[0], activation = records.activation;
        const runtime = binding && this.options.runtimes?.[binding.runtimeAdapter];
        const supported = typeof runtime?.startTurn === "function" && typeof runtime.turn === "function";
        let sessionReady = false;
        const references: NonNullable<LocalConversationAuthoredSkillCatalog["agents"]>[number]["skills"] = [];
        if (config?.status === "active" && binding?.state === "connected" && binding.wakePolicy !== "muted"
          && records.bindings.length === 1 && activation?.authoredContext) {
          try {
            validateAuthoredContext(activation.authoredContext, conversation.workspaceId, channelId);
            // Session validity is independent of whether any published skill is pinned.
            sessionReady = activation.state === "active" && binding.workspaceId === conversation.workspaceId
              && binding.conversationId === conversationId && binding.agentIdentityId === participant.id
              && activation.workspaceId === conversation.workspaceId && activation.conversationId === conversationId
              && activation.agentIdentityId === participant.id && activation.bindingId === binding.id
              && activation.bindingGeneration === binding.generation && activation.runtimeAdapter === binding.runtimeAdapter
              && (activation.mapping === "managed"
                ? activation.managedSessionId === binding.runtimeSessionId && activation.runtimeOwnerId === binding.runtimeOwnerId
                : activation.legacyRuntimeSessionRef === binding.runtimeSessionId);
            for (const ref of activation.authoredContext.documents.filter(value => value.kind === "skill")) {
              if (!documents.some(document => document.id === ref.documentId)) continue;
              if (invocationTargetMatches({ workspaceId: conversation.workspaceId, conversationId, channelId, ...ref },
                { identityId: participant.id, bindingId: binding.id, generation: binding.generation }, binding, activation)) {
                references.push({ documentId: ref.documentId, source: ref.source, revision: ref.revision, contentHash: ref.contentHash });
              }
            }
          } catch { /* Corrupt/legacy context is unavailable, never a substitute. */ }
        }
        const harness = config?.skillIds?.filter(value => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value)) ?? [];
        agents.push({ identityId: participant.id, state: sessionReady && supported ? "ready" : "unavailable",
          supported, skills: references, harness: [...new Set(harness)] });
      }
      const fresh = await this.authorizeInvocationActor(conversationId, actorIdentityId);
      if (fresh.workspaceId !== conversation.workspaceId || (fresh.thread?.parentConversationId ?? fresh.id) !== channelId) throw new Error();
      return { workspaceId: conversation.workspaceId, conversationId, channelId, availability: "not_checked", skills, agents };
    } catch (error) {
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError("Skill catalog is unavailable", 409, "unavailable");
    }
  }

  async getConversationAuthoredContext(conversationId: string, actorIdentityId: string): Promise<LocalConversationAuthoredContext> {
    const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
    const channelId = conversation.thread?.parentConversationId ?? conversationId;
    try {
      const published = await captureAuthoredContext(this.options.store, conversation.workspaceId, channelId);
      const instructions = await resolveAuthoredInstructions(this.options.store, published);
      const agents: LocalConversationAuthoredContext["agents"] = [];
      for (const participant of conversation.participants.filter((participant) =>
        participant.status === "active" && (participant.type === "agent" || participant.type === "service"))) {
        const { bindings, activation } = await this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, participant.id);
        if (!bindings.length) { agents.push({ identityId: participant.id, status: "not_started" }); continue; }
        const binding = bindings[0]!;
        if (bindings.length !== 1 || !activation || activation.state !== "active"
          || activation.bindingId !== binding.id || activation.bindingGeneration !== binding.generation
          || activation.workspaceId !== conversation.workspaceId || activation.conversationId !== conversationId
          || activation.agentIdentityId !== participant.id) {
          agents.push({ identityId: participant.id, status: "unavailable" });
        } else if (activation.authoredContext === undefined) {
          agents.push({ identityId: participant.id, status: "legacy" });
        } else {
          try {
            validateAuthoredContext(activation.authoredContext, conversation.workspaceId, channelId);
            await resolveAuthoredInstructions(this.options.store, activation.authoredContext);
            agents.push({ identityId: participant.id,
              status: JSON.stringify(activation.authoredContext.documents) === JSON.stringify(published.documents) ? "applied" : "pending",
              applied: activation.authoredContext.documents });
          } catch {
            agents.push({ identityId: participant.id, status: "unavailable" });
          }
        }
      }
      await this.authorizeConversation(conversationId, actorIdentityId);
      return { workspaceId: conversation.workspaceId, conversationId, channelId, capturedAt: this.now().toISOString(),
        published, ...(instructions ? { instructions } : {}), agents, changesApplyToNewSessions: true };
    } catch (error) {
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError("Published instruction context is unavailable", 409, "unavailable");
    }
  }

  // The local authenticated human identity is the account boundary until login/sync exists.
  private async authorizeAccount(actorIdentityId: string): Promise<void> {
    const actor = await this.options.client.getIdentity(actorIdentityId).catch(() => undefined);
    if (actor?.type !== "human") throw new LocalConfigurationRequestError("Account library requires a human account", 403, "forbidden");
  }

  async listAccountLibraryItems(actorIdentityId: string): Promise<AccountLibraryItem[]> {
    await this.authorizeAccount(actorIdentityId);
    return this.options.store.listAccountLibraryItems(actorIdentityId);
  }

  async getAccountLibraryItem(itemId: string, actorIdentityId: string): Promise<AccountLibraryItem> {
    await this.authorizeAccount(actorIdentityId);
    const item = await this.options.store.getAccountLibraryItem(actorIdentityId, itemId);
    if (!item) throw new LocalConfigurationRequestError("Library item unavailable", 404, "unavailable");
    return item;
  }

  async listAccountLibraryVersions(itemId: string, actorIdentityId: string): Promise<AccountLibraryItem[]> {
    await this.getAccountLibraryItem(itemId, actorIdentityId);
    return this.options.store.listAccountLibraryVersions(actorIdentityId, itemId);
  }

  private async accountLibraryContent(input: Record<string, unknown>, actorIdentityId: string): Promise<AccountLibraryContent> {
    const name = requiredString(input.name, "name", 200).trim();
    const description = requiredString(input.description, "description", 2_000);
    if (input.kind === "skill") {
      rejectUnknown(input, ["kind", "name", "description", "content"]);
      return { kind: "skill", name, description, content: requiredString(input.content, "content", MAX_PERSONA_PROMPT_BYTES) };
    }
    if (input.kind === "workspace-preset") {
      rejectUnknown(input, ["kind", "name", "description", "definition"]);
      const definition = await this.parseWorkspacePreset(input.definition, actorIdentityId) as WorkspacePresetDefinition;
      return { kind: "workspace-preset", name, description, definition };
    }
    if (input.kind !== "agent-template") throw new LocalConfigurationRequestError("Library kind is invalid", 400, "invalid");
    rejectUnknown(input, ["kind", "name", "description", "configuration"]);
    const fields = object(input.configuration, "Template configuration");
    rejectUnknown(fields, ["personaPrompt", "runtimeAdapter", "modelProvider", "modelId", "reasoningLevel", "accountSkillIds"]);
    const configuration: AccountAgentTemplateConfiguration = {};
    for (const [key, max] of [["personaPrompt", MAX_PERSONA_PROMPT_BYTES], ["runtimeAdapter", MAX_RUNTIME_ADAPTER_BYTES],
      ["modelProvider", MAX_MODEL_PROVIDER_BYTES], ["modelId", MAX_MODEL_ID_BYTES]] as const) {
      if (fields[key] !== undefined) configuration[key] = requiredString(fields[key], key, max);
    }
    if ((configuration.modelProvider === undefined) !== (configuration.modelId === undefined)) {
      throw new LocalConfigurationRequestError("Model provider and id must be supplied together", 400, "invalid");
    }
    if (fields.reasoningLevel !== undefined) {
      if (typeof fields.reasoningLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(fields.reasoningLevel)) {
        throw new LocalConfigurationRequestError("Invalid reasoning level", 400, "invalid");
      }
      configuration.reasoningLevel = fields.reasoningLevel as AccountAgentTemplateConfiguration["reasoningLevel"];
    }
    if (fields.accountSkillIds !== undefined) {
      if (!Array.isArray(fields.accountSkillIds) || fields.accountSkillIds.length > 100
        || fields.accountSkillIds.some(id => typeof id !== "string" || !id.trim() || bytes(id) > MAX_SKILL_ID_BYTES)
        || new Set(fields.accountSkillIds).size !== fields.accountSkillIds.length) {
        throw new LocalConfigurationRequestError("Invalid account skill references", 400, "invalid");
      }
      for (const id of fields.accountSkillIds as string[]) {
        const skill = await this.options.store.getAccountLibraryItem(actorIdentityId, id);
        if (skill?.kind !== "skill" || skill.state !== "active") throw new LocalConfigurationRequestError("Account skill unavailable", 400, "invalid");
      }
      configuration.accountSkillIds = [...fields.accountSkillIds] as string[];
    }
    return { kind: "agent-template", name, description, configuration };
  }

  async createAccountLibraryItem(actorIdentityId: string, value: unknown): Promise<AccountLibraryItem> {
    await this.authorizeAccount(actorIdentityId);
    const content = await this.accountLibraryContent(object(value, "Library item"), actorIdentityId);
    const timestamp = this.now().toISOString();
    const item = await this.options.store.createAccountLibraryItem({
      ...content, id: randomUUID(), ownerIdentityId: actorIdentityId, version: 1,
      state: "active", createdAt: timestamp, updatedAt: timestamp,
    });
    if (!item) throw new LocalConfigurationRequestError("Library item creation conflict", 409, "unavailable");
    return item;
  }

  async updateAccountLibraryItem(itemId: string, actorIdentityId: string, value: unknown): Promise<AccountLibraryItem> {
    const current = await this.getAccountLibraryItem(itemId, actorIdentityId);
    const input = object(value, "Library update");
    rejectUnknown(input, input.action === "archive" ? ["action", "expectedVersion"] : ["action", "expectedVersion", "content"]);
    const expectedVersion = optionalNullableInteger(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER - 1);
    if (expectedVersion == null) throw new LocalConfigurationRequestError("expectedVersion is required", 400, "invalid");
    if (input.action !== "save" && input.action !== "archive") throw new LocalConfigurationRequestError("Invalid library action", 400, "invalid");
    const mutation = input.action === "archive" ? { action: "archive" as const } : {
      action: "save" as const, content: await this.accountLibraryContent(object(input.content, "Library content"), actorIdentityId),
    };
    if (mutation.action === "save" && mutation.content.kind !== current.kind) throw new LocalConfigurationRequestError("Library kind cannot change", 400, "invalid");
    const item = await this.options.store.mutateAccountLibraryItem(actorIdentityId, itemId, {
      ...mutation, expectedVersion, timestamp: this.now().toISOString(),
    });
    if (!item) throw new LocalConfigurationRequestError("Library item changed or retired; reload before retrying", 409, "unavailable");
    return item;
  }

  private async parseWorkspacePreset(value: unknown, actor: string, resolved = false): Promise<WorkspacePresetDefinition | WorkspaceCompositionPlan> {
    const input = object(value, "Workspace preset");
    rejectUnknown(input, ["agents", "conversationPresets", "instructions", "idleSleepTimeoutMs", "turnTimeoutMs", ...(resolved ? ["presetId", "presetVersion"] : [])]);
    if (!Array.isArray(input.agents) || input.agents.length > 16 || !Array.isArray(input.conversationPresets) || input.conversationPresets.length > 16) throw new LocalConfigurationRequestError("Choose at most 16 agents and conversation presets", 400, "invalid");
    if (typeof input.instructions !== "string" || bytes(input.instructions) > MAX_PERSONA_PROMPT_BYTES) throw new LocalConfigurationRequestError("Invalid workspace instructions", 400, "invalid");
    const agents: Array<WorkspacePresetDefinition["agents"][number] | WorkspaceCompositionPlan["agents"][number]> = [];
    for (const candidate of input.agents) {
      const agent = object(candidate, "Preset agent");
      rejectUnknown(agent, ["key", "templateId", "displayName", "mentionHandle", ...(resolved ? ["templateVersion", "configuration"] : ["accountSkillIds"])]);
      const key = requiredString(agent.key, "Agent key", 100);
      const templateId = requiredString(agent.templateId, "Template id", 100);
      const displayName = requiredString(agent.displayName, "Agent name", 200).trim();
      const mentionHandle = requiredString(agent.mentionHandle, "Mention handle", 63).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(mentionHandle) || isReservedMentionHandle(mentionHandle) || mentionHandle === "you") throw new LocalConfigurationRequestError("Invalid or reserved preset handle", 400, "invalid");
      const template = await this.getAccountLibraryItem(templateId, actor);
      if (template.kind !== "agent-template" || template.state !== "active") throw new LocalConfigurationRequestError("Account agent template unavailable", 404, "unavailable");
      if (resolved && agent.templateVersion !== template.version) throw new LocalConfigurationRequestError("Agent template changed; review preset again", 409, "unavailable");
      const configuration = resolved ? agent.configuration : { ...template.configuration, ...(agent.accountSkillIds !== undefined ? { accountSkillIds: agent.accountSkillIds } : {}) };
      const validated = await this.accountLibraryContent({ kind: "agent-template", name: displayName, description: "Workspace starter", configuration }, actor);
      if (validated.kind !== "agent-template" || (validated.configuration.runtimeAdapter && !/^[a-zA-Z0-9._-]+$/.test(validated.configuration.runtimeAdapter))) throw new LocalConfigurationRequestError("Invalid starter configuration", 400, "invalid");
      agents.push(resolved ? { key, templateId, displayName, mentionHandle, templateVersion: template.version, configuration: validated.configuration }
        : { key, templateId, displayName, mentionHandle, ...(agent.accountSkillIds !== undefined ? { accountSkillIds: validated.configuration.accountSkillIds ?? [] } : {}) });
    }
    if (new Set(agents.map(a => a.key)).size !== agents.length || new Set(agents.map(a => a.mentionHandle)).size !== agents.length) throw new LocalConfigurationRequestError("Preset agents must have unique keys and handles", 400, "invalid");
    const conversationPresets = input.conversationPresets.map(candidate => {
      const preset = object(candidate, "Conversation preset");
      rejectUnknown(preset, ["name", "agentKeys", "guidance"]);
      const name = conversationLabel(preset.name, "Conversation preset name");
      if (!Array.isArray(preset.agentKeys) || preset.agentKeys.length > 16 || new Set(preset.agentKeys).size !== preset.agentKeys.length
        || preset.agentKeys.some(key => typeof key !== "string" || !agents.some(agent => agent.key === key))) throw new LocalConfigurationRequestError("Conversation preset references an unavailable starter", 400, "invalid");
      if (preset.guidance !== undefined && (typeof preset.guidance !== "string" || bytes(preset.guidance) > 16 * 1024)) throw new LocalConfigurationRequestError("Invalid conversation guidance", 400, "invalid");
      return { name, agentKeys: preset.agentKeys as string[], ...(preset.guidance ? { guidance: preset.guidance as string } : {}) };
    });
    const idleSleepTimeoutMs = input.idleSleepTimeoutMs;
    const turnTimeoutMs = input.turnTimeoutMs;
    if (idleSleepTimeoutMs !== undefined && (typeof idleSleepTimeoutMs !== "number" || ![15, 30, 60, 240, 1440].includes(idleSleepTimeoutMs / 60_000))) throw new LocalConfigurationRequestError("Invalid idle sleep default", 400, "invalid");
    if (turnTimeoutMs !== undefined && (typeof turnTimeoutMs !== "number" || ![30, 60, 120].includes(turnTimeoutMs / 60_000))) throw new LocalConfigurationRequestError("Invalid turn timeout default", 400, "invalid");
    const definition = { agents, conversationPresets, instructions: input.instructions,
      ...(idleSleepTimeoutMs !== undefined ? { idleSleepTimeoutMs: idleSleepTimeoutMs as number } : {}), ...(turnTimeoutMs !== undefined ? { turnTimeoutMs: turnTimeoutMs as number } : {}) };
    if (resolved) return { ...definition, presetId: requiredString(input.presetId, "Preset id", 100), presetVersion: input.presetVersion as number } as WorkspaceCompositionPlan;
    return definition as WorkspacePresetDefinition;
  }

  async previewWorkspacePreset(presetId: string, actor: string): Promise<WorkspaceCompositionPlan> {
    const preset = await this.getAccountLibraryItem(presetId, actor);
    if (preset.kind !== "workspace-preset" || preset.state !== "active") throw new LocalConfigurationRequestError("Workspace preset unavailable", 404, "unavailable");
    const definition = await this.parseWorkspacePreset(preset.definition, actor) as WorkspacePresetDefinition;
    const agents: WorkspaceCompositionPlan["agents"] = [];
    for (const agent of definition.agents) {
      const template = await this.getAccountLibraryItem(agent.templateId, actor);
      if (template.kind !== "agent-template" || template.state !== "active") throw new LocalConfigurationRequestError("Agent template unavailable", 404, "unavailable");
      agents.push({ key: agent.key, templateId: agent.templateId, displayName: agent.displayName, mentionHandle: agent.mentionHandle, templateVersion: template.version,
        configuration: { ...template.configuration, ...(agent.accountSkillIds !== undefined ? { accountSkillIds: [...agent.accountSkillIds] } : {}) } });
    }
    return { ...definition, agents, presetId, presetVersion: preset.version };
  }

  async copyAccountSkillToWorkspace(workspaceId: string, skillId: string, actorIdentityId: string, value: unknown): Promise<AuthoredDocument> {
    await this.authorize(workspaceId, actorIdentityId);
    const input = object(value, "Skill copy");
    rejectUnknown(input, ["expectedVersion"]);
    const version = optionalNullableInteger(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER - 1);
    if (version == null) throw new LocalConfigurationRequestError("expectedVersion is required", 400, "invalid");
    const source = await this.getAccountLibraryItem(skillId, actorIdentityId);
    if (source.kind !== "skill" || source.state !== "active") throw new LocalConfigurationRequestError("Account skill unavailable", 404, "unavailable");
    if (source.version !== version) throw new LocalConfigurationRequestError("Account skill changed; reload before copying", 409, "unavailable");
    return this.createAuthoredDocument(workspaceId, actorIdentityId, {
      action: "commit", kind: "skill", name: source.name, description: source.description, content: source.content,
    });
  }

  async createWorkspaceAgentFromAccountTemplate(
    workspaceId: string, actorIdentityId: string, value: unknown,
  ): Promise<CreateWorkspaceAgentFromAccountTemplateResult> {
    const members = await this.authorize(workspaceId, actorIdentityId);
    const input = object(value, "Account template addition");
    rejectUnknown(input, ["templateId", "expectedTemplateVersion", "displayName", "mentionHandle"]);
    const templateId = requiredString(input.templateId, "templateId", 200);
    const displayName = requiredString(input.displayName, "displayName", 200).trim();
    const mentionHandle = requiredString(input.mentionHandle, "mentionHandle", 63).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(mentionHandle) || isReservedMentionHandle(mentionHandle)) {
      throw new LocalConfigurationRequestError("Invalid mention handle", 400, "invalid");
    }
    if (members.some(member => member.mentionHandle.toLowerCase() === mentionHandle)) {
      throw new LocalConfigurationRequestError("Mention handle is already in use", 409, "unavailable");
    }
    const version = optionalNullableInteger(input.expectedTemplateVersion, "expectedTemplateVersion", 1, Number.MAX_SAFE_INTEGER - 1);
    if (version == null) throw new LocalConfigurationRequestError("expectedTemplateVersion is required", 400, "invalid");
    const template = await this.getAccountLibraryItem(templateId, actorIdentityId);
    if (template.kind !== "agent-template" || template.state !== "active") {
      throw new LocalConfigurationRequestError("Account agent template unavailable", 404, "unavailable");
    }
    if (template.version !== version) throw new LocalConfigurationRequestError("Template changed; reload account agents before adding", 409, "unavailable");
    // Revalidate the reusable allowlist/references before creating any public resources.
    const validated = await this.accountLibraryContent({ kind: template.kind, name: template.name,
      description: template.description, configuration: template.configuration }, actorIdentityId);
    if (validated.kind !== "agent-template") throw new LocalConfigurationRequestError("Account agent template unavailable", 404, "unavailable");
    const config = validated.configuration;
    if (config.runtimeAdapter && !/^[a-zA-Z0-9._-]+$/.test(config.runtimeAdapter)) {
      throw new LocalConfigurationRequestError("Runtime adapter is invalid", 400, "invalid");
    }
    const workspace = await this.options.store.getWorkspaceConfig(workspaceId);
    if (!workspace) throw new LocalConfigurationRequestError("Workspace configuration unavailable", 409, "unavailable");
    const policy = config.runtimeAdapter ? workspace.runtimeModelPolicies?.[config.runtimeAdapter] : undefined;
    if (policy && config.modelProvider && config.modelId && !policy.some(model =>
      model.provider === config.modelProvider && model.id === config.modelId)) {
      throw new LocalConfigurationRequestError("Selected model is disabled for this Runtime", 409, "unavailable");
    }
    await this.authorize(workspaceId, actorIdentityId);
    try {
      const identity = await this.options.client.createIdentity({ type: "agent", displayName });
      await this.authorize(workspaceId, actorIdentityId);
      const member = await this.options.client.addWorkspaceMember(workspaceId, {
        identityId: identity.id, mentionHandle, accessRole: "member",
      });
      await this.authorize(workspaceId, actorIdentityId);
      await this.directory.configureAgent({
        workspaceId, agentIdentityId: identity.id,
        personaPrompt: config.personaPrompt, runtimeAdapter: config.runtimeAdapter,
        modelProvider: config.modelProvider, modelId: config.modelId, reasoningLevel: config.reasoningLevel,
        // Account selections are private references, not harness skill IDs or runtime grants.
        accountSkills: config.accountSkillIds?.length
          ? { ownerIdentityId: actorIdentityId, skillIds: [...config.accountSkillIds] } : undefined,
        skillIds: config.runtimeAdapter ? [] : undefined,
        status: "active",
      });
      this.audit({ action: "agent.config.updated", outcome: "accepted", actorIdentityId, workspaceId, targetIdentityId: identity.id });
      await this.authorize(workspaceId, actorIdentityId);
      return { identity, member, templateVersion: template.version };
    } catch (error) {
      if (error instanceof LocalConfigurationRequestError && [401, 403, 404].includes(error.status)) throw error;
      // Core identity/membership and private Relay storage do not share a transaction.
      // Never retry automatically or imply that an uncertain addition had no effect.
      throw new LocalConfigurationRequestError("Agent addition may be incomplete; inspect workspace agents before adding again", 409, "unavailable", "unconfirmed");
    }
  }

  async listAuthoredDocuments(workspaceId: string, actorIdentityId: string): Promise<LocalAuthoredDocumentSummary[]> {
    await this.authorize(workspaceId, actorIdentityId);
    const documents = await this.options.store.listAuthoredDocuments(workspaceId);
    await this.authorize(workspaceId, actorIdentityId);
    return documents.map(({ content, ...summary }) => summary);
  }

  async getAuthoredDocument(workspaceId: string, documentId: string, actorIdentityId: string): Promise<AuthoredDocument> {
    await this.authorize(workspaceId, actorIdentityId);
    const document = await this.options.store.getAuthoredDocument(workspaceId, documentId);
    if (!document) throw new LocalConfigurationRequestError("Document is unavailable", 404, "unavailable");
    await this.authorizeAuthoredScope(workspaceId, document.conversationId);
    await this.authorize(workspaceId, actorIdentityId);
    return document;
  }

  async listAuthoredDocumentRevisions(
    workspaceId: string,
    documentId: string,
    actorIdentityId: string,
  ): Promise<AuthoredDocumentRevision[]> {
    await this.getAuthoredDocument(workspaceId, documentId, actorIdentityId);
    const revisions = await this.options.store.listAuthoredDocumentRevisions(workspaceId, documentId);
    await this.authorize(workspaceId, actorIdentityId);
    return revisions;
  }

  async createAuthoredDocument(workspaceId: string, actorIdentityId: string, value: unknown): Promise<AuthoredDocument> {
    try {
      await this.authorize(workspaceId, actorIdentityId);
      const input = object(value, "Document");
      rejectUnknown(input, ["action", "kind", "conversationId", "name", "description", "content"]);
      if (input.action !== undefined && input.action !== "commit") throw new LocalConfigurationRequestError("Document action is invalid", 400, "invalid");
      if (input.kind !== "instructions" && input.kind !== "skill") {
        throw new LocalConfigurationRequestError("Document kind is invalid", 400, "invalid");
      }
      const conversationId = input.conversationId === undefined
        ? undefined : requiredString(input.conversationId, "conversationId", 200);
      await this.authorizeAuthoredScope(workspaceId, conversationId);
      const draft = this.authoredDraft(input, input.kind, conversationId);
      if (input.action === "commit" && input.kind === "skill" && (!draft.description.trim() || !draft.content.trim())) {
        throw new LocalConfigurationRequestError("A saved skill requires a description and instructions", 400, "invalid");
      }
      const timestamp = this.now().toISOString();
      await this.authorize(workspaceId, actorIdentityId);
      const document = await this.options.store.createAuthoredDocument({
        id: randomUUID(), workspaceId, conversationId, kind: input.kind, ...draft,
        version: 1, state: "active", createdBy: actorIdentityId, updatedBy: actorIdentityId,
        createdAt: timestamp, updatedAt: timestamp,
      }, input.action === "commit");
      if (!document) throw new LocalConfigurationRequestError("Instructions already exist for this scope", 409, "unavailable");
      this.audit({ action: "authored-document.created", outcome: "accepted", actorIdentityId, workspaceId, conversationId });
      // The commit may have succeeded while access changed; withhold its private result.
      await this.authorize(workspaceId, actorIdentityId);
      return document;
    } catch (error) {
      this.auditFailure("authored-document.created", actorIdentityId, workspaceId, undefined, error);
      throw error;
    }
  }

  async updateAuthoredDocument(
    workspaceId: string,
    documentId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<AuthoredDocument> {
    let action: "authored-document.updated" | "authored-document.published" | "authored-document.archived" = "authored-document.updated";
    try {
      const current = await this.getAuthoredDocument(workspaceId, documentId, actorIdentityId);
      const input = object(value, "Document update");
      if (input.action !== "save" && input.action !== "commit" && input.action !== "publish" && input.action !== "archive") {
        throw new LocalConfigurationRequestError("Document action is invalid", 400, "invalid");
      }
      action = input.action === "publish" || input.action === "commit" ? "authored-document.published"
        : input.action === "archive" ? "authored-document.archived" : "authored-document.updated";
      rejectUnknown(input, input.action === "save" || input.action === "commit"
        ? ["action", "expectedVersion", "name", "description", "content"] : ["action", "expectedVersion"]);
      const expectedVersion = optionalNullableInteger(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER - 1);
      if (expectedVersion == null) throw new LocalConfigurationRequestError("expectedVersion is required", 400, "invalid");
      if (current.version !== expectedVersion || current.state !== "active") {
        throw new LocalConfigurationRequestError("Document changed or is archived; reload before retrying", 409, "unavailable");
      }
      if (input.action === "publish" && current.kind === "skill"
        && (!current.description.trim() || !current.content.trim())) {
        throw new LocalConfigurationRequestError("A published skill requires a description and instructions", 400, "invalid");
      }
      if (input.action === "archive" && current.kind === "instructions") {
        throw new LocalConfigurationRequestError("Save empty instructions to clear this scope", 400, "invalid");
      }
      const mutation = input.action === "save" || input.action === "commit"
        ? { action: input.action, ...this.authoredDraft(input, current.kind, current.conversationId) } as const
        : { action: input.action } as const;
      if (mutation.action === "commit" && current.kind === "skill" && (!mutation.description.trim() || !mutation.content.trim())) {
        throw new LocalConfigurationRequestError("A saved skill requires a description and instructions", 400, "invalid");
      }
      await this.authorize(workspaceId, actorIdentityId);
      const document = await this.options.store.mutateAuthoredDocument(workspaceId, documentId, {
        ...mutation, expectedVersion, actorIdentityId, timestamp: this.now().toISOString(),
      });
      if (!document) throw new LocalConfigurationRequestError("Document changed; reload before retrying", 409, "unavailable");
      this.audit({ action, outcome: "accepted", actorIdentityId, workspaceId, conversationId: current.conversationId });
      await this.authorize(workspaceId, actorIdentityId);
      return document;
    } catch (error) {
      this.auditFailure(action, actorIdentityId, workspaceId, undefined, error);
      throw error;
    }
  }

  private authoredDraft(input: Record<string, unknown>, kind: AuthoredDocument["kind"], conversationId?: string) {
    if (typeof input.content !== "string" || bytes(input.content) > MAX_PERSONA_PROMPT_BYTES) {
      throw new LocalConfigurationRequestError("content must be Markdown of at most 64 KiB", 400, "invalid");
    }
    if (kind === "instructions" && (input.name !== undefined || input.description !== undefined)) {
      throw new LocalConfigurationRequestError("Instruction names and descriptions are not editable", 400, "invalid");
    }
    if (input.description !== undefined && (typeof input.description !== "string" || bytes(input.description) > 2_000)) {
      throw new LocalConfigurationRequestError("description must be at most 2000 bytes", 400, "invalid");
    }
    return {
      name: kind === "skill" ? requiredString(input.name, "name", 200).trim()
        : conversationId ? "Channel instructions" : "Workspace instructions",
      description: kind === "skill" ? (input.description as string | undefined) ?? "" : "",
      content: input.content,
    };
  }

  private async authorizeAuthoredScope(workspaceId: string, conversationId?: string): Promise<void> {
    if (!conversationId) return;
    const conversation = await this.options.client.getConversation(conversationId).catch(() => undefined);
    if (!conversation || conversation.workspaceId !== workspaceId) {
      throw new LocalConfigurationRequestError("Document scope is unavailable", 404, "unavailable");
    }
    if (conversation.thread) {
      throw new LocalConfigurationRequestError("Threads inherit parent channel content", 409, "unavailable");
    }
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
          skillsConfigured: config?.skillIds !== undefined || config?.accountSkills !== undefined || config?.workspaceSkillIds !== undefined,
          selectedSkillCount: (config?.skillIds?.length ?? 0) + (config?.accountSkills?.skillIds.length ?? 0) + (config?.workspaceSkillIds?.length ?? 0),
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
      ...(workspaceConfig?.turnTimeoutMs !== undefined ? { turnTimeoutMs: workspaceConfig.turnTimeoutMs } : {}),
      ...(workspaceConfig?.idleSleepTimeoutMs !== undefined
        ? { idleSleepTimeoutMs: workspaceConfig.idleSleepTimeoutMs }
        : {}),
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
      ...(config.accountSkills ? { accountSkills: structuredClone(config.accountSkills) } : {}),
      ...(config.workspaceSkillIds ? { workspaceSkillIds: [...config.workspaceSkillIds] } : {}),
      handoffSummaryTokens: config.handoffSummaryTokens ?? DEFAULT_HANDOFF_SUMMARY_TOKENS,
      recentContextTokens: config.recentContextTokens ?? DEFAULT_RECENT_CONTEXT_TOKENS,
      recentContextMessages: config.recentContextMessages ?? DEFAULT_RECENT_CONTEXT_MESSAGES,
      status: config.status,
      changesApplyToNewSessions: true,
    };
  }

  async getConversationWorkingFolders(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationWorkingFolders> {
    const conversation = await this.authorizeConversation(conversationId, actorIdentityId);
    const folders = await this.options.store.getConversationWorkingFolders(conversation.workspaceId, conversation.thread?.parentConversationId ?? conversationId);
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
    if (conversation.thread) throw new LocalConfigurationRequestError("Threads inherit parent Conversation working folders", 409, "unavailable");
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
      if (conversation.thread) throw new LocalConfigurationRequestError("Threads inherit parent Conversation working folders", 409, "unavailable");
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
      rejectUnknown(input, ["rootUri", "notesFolderId", "idleSleepTimeoutMs", "turnTimeoutMs"]);
      if (Object.keys(input).length === 0) {
        throw new LocalConfigurationRequestError("Workspace configuration update is empty", 400, "invalid");
      }
      const existing = await this.options.store.getWorkspaceConfig(workspaceId);
      const rootUri = input.rootUri === undefined
        ? existing?.rootUri
        : await canonicalWorkspaceRoot(requiredString(input.rootUri, "rootUri", MAX_ROOT_URI_BYTES));
      if (!rootUri) {
        throw new LocalConfigurationRequestError("Workspace source folder is required", 409, "unavailable");
      }
      const idleSleepTimeoutMs = input.idleSleepTimeoutMs === undefined || input.idleSleepTimeoutMs === null
        ? input.idleSleepTimeoutMs
        : optionalNullableInteger(input.idleSleepTimeoutMs, "idleSleepTimeoutMs", 15 * 60_000, 24 * 60 * 60_000);
      if (idleSleepTimeoutMs !== undefined && idleSleepTimeoutMs !== null
        && ![15, 30, 60, 240, 1440].includes(idleSleepTimeoutMs / 60_000)) {
        throw new LocalConfigurationRequestError("Unsupported idle sleep timeout", 400, "invalid");
      }
      const turnTimeoutMs = input.turnTimeoutMs;
      if (turnTimeoutMs !== undefined && turnTimeoutMs !== null
        && (typeof turnTimeoutMs !== "number" || ![30, 60, 120].includes(turnTimeoutMs / 60_000))) {
        throw new LocalConfigurationRequestError("Unsupported turn timeout", 400, "invalid");
      }
      const notesFolderId = optionalNullableString(
        input.notesFolderId,
        "notesFolderId",
        MAX_NOTES_FOLDER_ID_BYTES,
      );
      await this.directory.configureWorkspace({
        workspaceId,
        rootUri,
        notesFolderId,
        idleSleepTimeoutMs,
        turnTimeoutMs: turnTimeoutMs as number | null | undefined,
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
        "personaPrompt", "runtimeAdapter", "modelProvider", "modelId", "reasoningLevel", "skillIds",
        "handoffSummaryTokens", "recentContextTokens", "recentContextMessages", "status", "accountSkillIds", "workspaceSkillIds",
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
      const launchDefaults = resolvedAdapter === existingConfig?.runtimeAdapter ? existingConfig : undefined;
      const resolvedProvider = modelProvider === undefined
        ? launchDefaults?.modelProvider
        : modelProvider ?? undefined;
      const resolvedModelId = modelId === undefined ? launchDefaults?.modelId : modelId ?? undefined;
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
      const selected = new Map<string, string[]>();
      for (const key of ["accountSkillIds", "workspaceSkillIds"] as const) {
        if (input[key] === undefined) continue;
        if (!Array.isArray(input[key]) || input[key].length > 100) throw new LocalConfigurationRequestError("Invalid skill selection", 400, "invalid");
        const ids = input[key].map(id => requiredString(id, "Skill id", MAX_SKILL_ID_BYTES));
        if (new Set(ids).size !== ids.length) throw new LocalConfigurationRequestError("Duplicate skill selection", 400, "invalid");
        for (const id of ids) {
          const skill = key === "accountSkillIds" ? await this.options.store.getAccountLibraryItem(actorIdentityId, id)
            : await this.options.store.getAuthoredDocument(workspaceId, id);
          if (!skill || skill.kind !== "skill" || skill.state !== "active"
            || (key === "workspaceSkillIds" && ("conversationId" in skill && skill.conversationId !== undefined
              || !("publishedRevision" in skill) || skill.publishedRevision === undefined))) {
            throw new LocalConfigurationRequestError("Selected skill unavailable", 400, "invalid");
          }
        }
        selected.set(key, ids);
      }
      const handoffSummaryTokens = optionalNullableInteger(
        input.handoffSummaryTokens,
        "handoffSummaryTokens",
        0,
        MAX_HANDOFF_SUMMARY_TOKENS,
      );
      const recentContextTokens = optionalNullableInteger(
        input.recentContextTokens,
        "recentContextTokens",
        1_000,
        MAX_RECENT_CONTEXT_TOKENS,
      );
      const recentContextMessages = optionalNullableInteger(
        input.recentContextMessages,
        "recentContextMessages",
        1,
        MAX_RECENT_CONTEXT_MESSAGES,
      );
      const resolvedSkillIds = skillIds ?? launchDefaults?.skillIds;
      const authoredSelectionOnly = Object.keys(input).every(key => key === "accountSkillIds" || key === "workspaceSkillIds");
      if (resolvedSkillIds !== undefined && !authoredSelectionOnly) {
        if (!resolvedAdapter) {
          throw new LocalConfigurationRequestError("A Runtime is required to configure skills", 409, "unavailable");
        }
        // A skill saved earlier may since have been deleted or renamed; only a newly selected one must exist.
        const saved = new Set(launchDefaults?.skillIds);
        const added = resolvedSkillIds.filter((id) => !saved.has(id));
        if (added.length) {
          const options = await this.resolveRuntimeOptions(workspaceId, resolvedAdapter);
          const available = new Set(options.skills.map(({ id }) => id));
          if (added.some((id) => !available.has(id))) {
            throw new LocalConfigurationRequestError("A selected skill is unavailable for this Runtime", 409, "unavailable");
          }
        }
      }
      const status = input.status;
      if (status !== undefined && status !== "active" && status !== "disabled") {
        throw new LocalConfigurationRequestError("status must be active or disabled", 400, "invalid");
      }
      await this.authorize(workspaceId, actorIdentityId);
      await this.directory.configureAgent({
        workspaceId,
        agentIdentityId,
        personaPrompt,
        runtimeAdapter,
        modelProvider,
        modelId,
        reasoningLevel: reasoningLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null | undefined,
        skillIds,
        ...(selected.has("accountSkillIds") ? { accountSkills: { ownerIdentityId: actorIdentityId, skillIds: selected.get("accountSkillIds")! } } : {}),
        workspaceSkillIds: selected.get("workspaceSkillIds"),
        handoffSummaryTokens,
        recentContextTokens,
        recentContextMessages,
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
      // The only non-generic Runtime errors: a harness that is missing, signed out or too old says so (fixed, non-secret text,
      // matched by error name; nothing from the error itself is ever shown). Keep in step with web lib/harness-errors.ts.
      const setup = error instanceof Error ? HARNESS_SETUP_MESSAGES[error.name] : undefined;
      if (setup) throw new LocalConfigurationRequestError(setup, 409, "unavailable");
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
    action: "workspace.config.updated" | "conversation.working-folders.updated" | "runtime.models.updated" | "agent.config.updated"
      | "authored-document.created" | "authored-document.updated" | "authored-document.published" | "authored-document.archived" | "skill.invocation.accepted",
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
