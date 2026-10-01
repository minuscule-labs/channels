import { createResourceId, type ConversationClient } from "@minu/channels-core";
import { randomUUID } from "node:crypto";
import type {
  AgentConversationBinding,
  AgentRuntimePort,
  DeliveryDeadLetterInput,
  DeliveryDeadLetterReason,
  RelayCursorStore,
  TurnFailureCauseCategory,
  TurnFailureDeliveryInput,
  TurnFailureDeliveryOutcome,
  TurnFailureDiagnosticInput,
  TurnFailureRemediationCode,
  WakePolicy,
} from "./relay.ts";

export interface RuntimeModelRef {
  provider: string;
  id: string;
}

export const DEFAULT_HANDOFF_SUMMARY_TOKENS = 4_000;
export const DEFAULT_RECENT_CONTEXT_TOKENS = 8_000;
export const DEFAULT_RECENT_CONTEXT_MESSAGES = 50;

async function withRuntimeTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface LocalWorkspaceConfig {
  workspaceId: string;
  rootUri: string;
  notesFolderId?: string;
  /** Undefined means no automatic sleep for this Workspace. */
  idleSleepTimeoutMs?: number;
  runtimeModelPolicies?: Record<string, RuntimeModelRef[]>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgentConfig {
  id: string;
  workspaceId: string;
  agentIdentityId: string;
  personaRef?: string;
  personaPrompt?: string;
  runtimeAdapter?: string;
  modelProvider?: string;
  modelId?: string;
  reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  skillIds?: string[];
  /** Maximum ephemeral Conversation-derived handoff brief for a newly created Runtime session. */
  handoffSummaryTokens?: number;
  /** Maximum recent Conversation context sent on each Runtime turn. */
  recentContextTokens?: number;
  /** Maximum number of recent Conversation messages considered for each Runtime turn. */
  recentContextMessages?: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export type ConversationAgentBindingState = "connected" | "sleeping" | "waking" | "offline" | "replacing" | "disabled";

export interface ConversationAgentBindingRecord {
  id: string;
  workspaceAgentConfigId: string;
  workspaceId: string;
  conversationId: string;
  agentIdentityId: string;
  executionEnvironmentId?: string;
  runtimeAdapter: string;
  /** Runtime-managed stable id when runtimeOwnerId is present; otherwise a legacy adapter id. */
  runtimeSessionId: string;
  /** Stable opaque owner scope for Runtime-managed sessions. */
  runtimeOwnerId?: string;
  generation: number;
  state: ConversationAgentBindingState;
  wakePolicy: WakePolicy;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastVerifiedAt?: string;
  lastActiveAt?: string;
  sleptAt?: string;
  wakeRequestedAt?: string;
  managedSessionMissingAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeSessionHistoryMapping = "managed" | "legacy_unmapped";
export type RuntimeSessionHistoryState = "active" | "retired";
export type RuntimeSessionHistoryOrigin = "started" | "resumed" | "forked" | "restored" | "attached" | "migrated";
export type RuntimeSessionRetirementReason = "replaced" | "stopped" | "disabled" | "conversation_retired" | "recovered";
export type RuntimeSessionCleanupAction = "none" | "suspend" | "destroy";
export type RuntimeSessionCleanupStatus = "not_required" | "pending" | "succeeded" | "failed" | "unknown";
export type RuntimeSessionRetentionStatus = "retained" | "destroy_pending" | "destroyed";
export type RuntimeSessionCleanupErrorCategory =
  | "runtime_unavailable"
  | "session_unavailable"
  | "operation_unsupported"
  | "operation_failed";

/** Private activation metadata. Legacy native ids are intentionally not copied into this history. */
export interface RuntimeSessionHistoryRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentIdentityId: string;
  workspaceAgentConfigId: string;
  bindingId: string;
  bindingGeneration: number;
  runtimeAdapter: string;
  managedSessionId?: string;
  runtimeOwnerId?: string;
  /** Exact legacy binding reference; never passed to owner-scoped Runtime-managed operations. */
  legacyRuntimeSessionRef?: string;
  mapping: RuntimeSessionHistoryMapping;
  state: RuntimeSessionHistoryState;
  origin: RuntimeSessionHistoryOrigin;
  conversationSequenceAtActivation?: number;
  conversationSequenceAtRetirement?: number;
  activatedAt: string;
  retiredAt?: string;
  retirementReason?: RuntimeSessionRetirementReason;
  cleanupAction: RuntimeSessionCleanupAction;
  cleanupStatus: RuntimeSessionCleanupStatus;
  retentionStatus: RuntimeSessionRetentionStatus;
  cleanupAttemptCount: number;
  lastCleanupAttemptAt?: string;
  lastObservedRuntimeStatus?: "idle" | "working" | "offline" | "unknown";
  lastVerifiedAt?: string;
  lastCleanupErrorCategory?: RuntimeSessionCleanupErrorCategory;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSessionCleanupAttempt {
  bindingId: string;
  bindingGeneration: number;
  outcome: "succeeded" | "failed";
  attemptedAt: string;
  observedRuntimeStatus: "idle" | "working" | "offline" | "unknown";
  errorCategory?: RuntimeSessionCleanupErrorCategory;
  retentionOutcome?: "retained" | "destroyed";
}

export interface DeliveryDeadLetterRecord {
  conversationId: string;
  participantId: string;
  triggerMessageId: string;
  triggerSequence: number;
  reason: DeliveryDeadLetterReason;
  createdAt: string;
  updatedAt: string;
}

export interface TurnFailureDiagnosticRecord {
  conversationId: string;
  participantId: string;
  triggerMessageId: string;
  triggerSequence: number;
  bindingId?: string;
  bindingGeneration?: number;
  startedAt: string;
  failedAt: string;
  elapsedMs: number;
  attemptCount: number;
  causeCategory: TurnFailureCauseCategory;
  deliveryOutcome: TurnFailureDeliveryOutcome;
  remediationCode: TurnFailureRemediationCode;
  createdAt: string;
  updatedAt: string;
}

/** Private, Workspace-relative Conversation working-folder configuration. */
export interface ConversationWorkingFolder {
  workspaceId: string;
  conversationId: string;
  relativePath: string;
  position: number;
  primary: boolean;
}

export interface RelayBindingStore extends RelayCursorStore {
  putWorkspaceConfig(config: LocalWorkspaceConfig): Promise<LocalWorkspaceConfig>;
  getWorkspaceConfig(workspaceId: string): Promise<LocalWorkspaceConfig | undefined>;
  getConversationWorkingFolders(workspaceId: string, conversationId: string): Promise<ConversationWorkingFolder[]>;
  replaceConversationWorkingFolders(
    workspaceId: string,
    conversationId: string,
    folders: readonly ConversationWorkingFolder[],
  ): Promise<ConversationWorkingFolder[]>;
  putAgentConfig(config: WorkspaceAgentConfig): Promise<WorkspaceAgentConfig>;
  getAgentConfig(configId: string): Promise<WorkspaceAgentConfig | undefined>;
  getWorkspaceAgentConfig(
    workspaceId: string,
    agentIdentityId: string,
  ): Promise<WorkspaceAgentConfig | undefined>;
  listWorkspaceAgentConfigs(workspaceId: string): Promise<WorkspaceAgentConfig[]>;
  getOrCreateRuntimeOwnerId(): Promise<string>;
  putBinding(
    binding: ConversationAgentBindingRecord,
    activation?: { origin?: RuntimeSessionHistoryOrigin; conversationSequence?: number },
  ): Promise<ConversationAgentBindingRecord>;
  getBinding(bindingId: string): Promise<ConversationAgentBindingRecord | undefined>;
  deleteBinding(bindingId: string): Promise<void>;
  listSessionHistory(conversationId: string, agentIdentityId?: string): Promise<RuntimeSessionHistoryRecord[]>;
  listPendingSessionCleanups(limit: number): Promise<RuntimeSessionHistoryRecord[]>;
  recordSessionCleanupAttempt(input: RuntimeSessionCleanupAttempt): Promise<void>;
  listConversationBindings(conversationId: string): Promise<ConversationAgentBindingRecord[]>;
  listWorkspaceBindings(workspaceId: string): Promise<ConversationAgentBindingRecord[]>;
  acquireBindingLease(
    bindingId: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined>;
  renewBindingLease(
    bindingId: string,
    generation: number,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  releaseBindingLease(bindingId: string, generation: number, leaseOwner: string): Promise<void>;
  updateBindingState(
    bindingId: string,
    generation: number,
    leaseOwner: string,
    state: ConversationAgentBindingState,
    lastVerifiedAt: string | undefined,
    updatedAt: string,
    expectedState?: ConversationAgentBindingState,
    lifecycle?: {
      lastActiveAt?: string | null;
      sleptAt?: string | null;
      wakeRequestedAt?: string | null;
      managedSessionMissingAt?: string | null;
    },
  ): Promise<ConversationAgentBindingRecord | undefined>;
  replaceBindingSession(
    bindingId: string,
    expectedGeneration: number,
    runtimeAdapter: string,
    runtimeSessionId: string,
    updatedAt: string,
    runtimeOwnerId?: string,
    activation?: { origin?: RuntimeSessionHistoryOrigin; conversationSequence?: number },
  ): Promise<ConversationAgentBindingRecord | undefined>;
  disableBinding(
    bindingId: string,
    expectedGeneration: number,
    updatedAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined>;
  recordTurnFailure(input: TurnFailureDiagnosticInput): Promise<void>;
  commitTurnFailureDelivery(input: TurnFailureDeliveryInput): Promise<void>;
  listTurnFailures(conversationId: string, limit: number): Promise<TurnFailureDiagnosticRecord[]>;
  commitDeliveryDeadLetter(input: DeliveryDeadLetterInput): Promise<void>;
  listDeliveryDeadLetters(conversationId: string, participantId: string): Promise<DeliveryDeadLetterRecord[]>;
  close?(): Promise<void> | void;
}

function validateRuntimeOwnerScope(runtimeOwnerId: string | undefined): void {
  if (runtimeOwnerId !== undefined && !runtimeOwnerId.trim()) {
    throw new Error("Runtime owner scope must not be empty");
  }
}

function copyWorkspaceConfig(config: LocalWorkspaceConfig): LocalWorkspaceConfig {
  return {
    ...config,
    runtimeModelPolicies: config.runtimeModelPolicies
      ? Object.fromEntries(Object.entries(config.runtimeModelPolicies).map(([adapter, models]) => [
        adapter,
        models.map((model) => ({ ...model })),
      ]))
      : undefined,
  };
}

function copyBinding(binding: ConversationAgentBindingRecord): ConversationAgentBindingRecord {
  return { ...binding };
}

function copyConversationWorkingFolder(folder: ConversationWorkingFolder): ConversationWorkingFolder {
  return { ...folder };
}

export function validateConversationWorkingFolders(
  workspaceId: string,
  conversationId: string,
  folders: readonly ConversationWorkingFolder[],
): void {
  if (folders.length > 16) throw new Error("A Conversation can have at most 16 working folders");
  const relativePaths = new Set<string>();
  const positions = new Set<number>();
  let primaryCount = 0;
  for (const folder of folders) {
    if (folder.workspaceId !== workspaceId || folder.conversationId !== conversationId) {
      throw new Error("Working folder does not belong to the requested Workspace and Conversation");
    }
    if (!folder.relativePath || folder.relativePath === ".") {
      throw new Error("Working folder must be a non-root relative path");
    }
    if (!Number.isSafeInteger(folder.position) || folder.position < 0) {
      throw new Error("Working folder position must be a non-negative integer");
    }
    if (relativePaths.has(folder.relativePath) || positions.has(folder.position)) {
      throw new Error("Working folders must have unique paths and positions");
    }
    relativePaths.add(folder.relativePath);
    positions.add(folder.position);
    if (folder.primary) primaryCount += 1;
  }
  if (folders.length > 0 && primaryCount !== 1) {
    throw new Error("Working folder configuration must have exactly one primary folder");
  }
}

export class InMemoryRelayBindingStore implements RelayBindingStore {
  private readonly workspaceConfigs = new Map<string, LocalWorkspaceConfig>();
  private readonly conversationWorkingFolders = new Map<string, ConversationWorkingFolder[]>();
  private readonly agentConfigs = new Map<string, WorkspaceAgentConfig>();
  private readonly bindings = new Map<string, ConversationAgentBindingRecord>();
  private readonly sessionHistory = new Map<string, RuntimeSessionHistoryRecord>();
  private runtimeOwnerId: string | undefined;
  private readonly cursors = new Map<string, number>();
  private readonly turnFailures = new Map<string, TurnFailureDiagnosticRecord>();
  /** Private recovery marker for a pending record evicted from the safe 100-row projection. */
  private readonly turnFailureFinalizationTombstones = new Set<string>();
  private readonly deliveryDeadLetters = new Map<string, DeliveryDeadLetterRecord>();

  async putWorkspaceConfig(config: LocalWorkspaceConfig): Promise<LocalWorkspaceConfig> {
    this.workspaceConfigs.set(config.workspaceId, copyWorkspaceConfig(config));
    return copyWorkspaceConfig(config);
  }

  async getWorkspaceConfig(workspaceId: string): Promise<LocalWorkspaceConfig | undefined> {
    const config = this.workspaceConfigs.get(workspaceId);
    return config ? copyWorkspaceConfig(config) : undefined;
  }

  async getConversationWorkingFolders(
    workspaceId: string,
    conversationId: string,
  ): Promise<ConversationWorkingFolder[]> {
    return (this.conversationWorkingFolders.get(`${workspaceId}\0${conversationId}`) ?? [])
      .map(copyConversationWorkingFolder);
  }

  async replaceConversationWorkingFolders(
    workspaceId: string,
    conversationId: string,
    folders: readonly ConversationWorkingFolder[],
  ): Promise<ConversationWorkingFolder[]> {
    validateConversationWorkingFolders(workspaceId, conversationId, folders);
    const replacement = folders.map(copyConversationWorkingFolder)
      .sort((left, right) => left.position - right.position);
    this.conversationWorkingFolders.set(`${workspaceId}\0${conversationId}`, replacement);
    return replacement.map(copyConversationWorkingFolder);
  }

  async putAgentConfig(config: WorkspaceAgentConfig): Promise<WorkspaceAgentConfig> {
    const duplicate = [...this.agentConfigs.values()].find(
      (candidate) => candidate.id !== config.id
        && candidate.workspaceId === config.workspaceId
        && candidate.agentIdentityId === config.agentIdentityId,
    );
    if (duplicate) throw new Error("Workspace agent configuration already exists");
    const stored = { ...config, skillIds: config.skillIds ? [...config.skillIds] : undefined };
    this.agentConfigs.set(config.id, stored);
    return { ...stored, skillIds: stored.skillIds ? [...stored.skillIds] : undefined };
  }

  async getAgentConfig(configId: string): Promise<WorkspaceAgentConfig | undefined> {
    const config = this.agentConfigs.get(configId);
    return config ? { ...config, skillIds: config.skillIds ? [...config.skillIds] : undefined } : undefined;
  }

  async getWorkspaceAgentConfig(
    workspaceId: string,
    agentIdentityId: string,
  ): Promise<WorkspaceAgentConfig | undefined> {
    const config = [...this.agentConfigs.values()].find(
      (candidate) => candidate.workspaceId === workspaceId
        && candidate.agentIdentityId === agentIdentityId,
    );
    return config ? { ...config, skillIds: config.skillIds ? [...config.skillIds] : undefined } : undefined;
  }

  async listWorkspaceAgentConfigs(workspaceId: string): Promise<WorkspaceAgentConfig[]> {
    return [...this.agentConfigs.values()]
      .filter((config) => config.workspaceId === workspaceId)
      .map((config) => ({ ...config, skillIds: config.skillIds ? [...config.skillIds] : undefined }));
  }

  async getOrCreateRuntimeOwnerId(): Promise<string> {
    this.runtimeOwnerId ??= randomUUID();
    return this.runtimeOwnerId;
  }

  async putBinding(
    binding: ConversationAgentBindingRecord,
    activation?: { origin?: RuntimeSessionHistoryOrigin; conversationSequence?: number },
  ): Promise<ConversationAgentBindingRecord> {
    validateRuntimeOwnerScope(binding.runtimeOwnerId);
    if (this.bindings.has(binding.id)) throw new Error("Conversation agent binding id already exists");
    const duplicate = [...this.bindings.values()].find(
      (candidate) => candidate.id !== binding.id
        && candidate.workspaceId === binding.workspaceId
        && candidate.conversationId === binding.conversationId
        && candidate.agentIdentityId === binding.agentIdentityId,
    );
    if (duplicate) throw new Error("Conversation agent binding already exists");
    const sessionOwner = [...this.bindings.values()].find(
      (candidate) => candidate.id !== binding.id
        && candidate.runtimeAdapter === binding.runtimeAdapter
        && candidate.runtimeSessionId === binding.runtimeSessionId
        && candidate.state !== "disabled",
    );
    if (sessionOwner) throw new Error("Runtime session is already bound");
    this.assertManagedSessionReusable(binding);
    this.bindings.set(binding.id, copyBinding(binding));
    this.createSessionActivation(binding, activation);
    return copyBinding(binding);
  }

  private assertManagedSessionReusable(binding: ConversationAgentBindingRecord): void {
    if (binding.runtimeOwnerId === undefined) return;
    const retired = [...this.sessionHistory.values()].find((record) =>
      record.mapping === "managed"
      && record.state === "retired"
      && record.runtimeAdapter === binding.runtimeAdapter
      && record.runtimeOwnerId === binding.runtimeOwnerId
      && record.managedSessionId === binding.runtimeSessionId
      && (record.retentionStatus !== "retained"
        || record.cleanupStatus === "pending"
        || record.cleanupStatus === "failed"));
    if (retired) throw new Error("Managed session cleanup is still pending");
  }

  private createSessionActivation(
    binding: ConversationAgentBindingRecord,
    activation?: { origin?: RuntimeSessionHistoryOrigin; conversationSequence?: number },
  ): void {
    const managed = binding.runtimeOwnerId !== undefined;
    const record: RuntimeSessionHistoryRecord = {
      id: randomUUID(),
      workspaceId: binding.workspaceId,
      conversationId: binding.conversationId,
      agentIdentityId: binding.agentIdentityId,
      workspaceAgentConfigId: binding.workspaceAgentConfigId,
      bindingId: binding.id,
      bindingGeneration: binding.generation,
      runtimeAdapter: binding.runtimeAdapter,
      managedSessionId: managed ? binding.runtimeSessionId : undefined,
      runtimeOwnerId: managed ? binding.runtimeOwnerId : undefined,
      legacyRuntimeSessionRef: managed ? undefined : binding.runtimeSessionId,
      mapping: managed ? "managed" : "legacy_unmapped",
      state: "active",
      origin: activation?.origin ?? (managed ? "started" : "migrated"),
      conversationSequenceAtActivation: activation?.conversationSequence,
      activatedAt: binding.updatedAt,
      cleanupAction: "none",
      cleanupStatus: managed ? "not_required" : "unknown",
      retentionStatus: "retained",
      cleanupAttemptCount: 0,
      createdAt: binding.updatedAt,
      updatedAt: binding.updatedAt,
    };
    this.sessionHistory.set(`${binding.id}\0${binding.generation}`, record);
  }

  private retireSessionActivation(
    binding: ConversationAgentBindingRecord,
    timestamp: string,
    reason: RuntimeSessionRetirementReason,
  ): void {
    const record = this.sessionHistory.get(`${binding.id}\0${binding.generation}`);
    if (!record || record.state !== "active") return;
    record.state = "retired";
    record.retiredAt = timestamp;
    record.retirementReason = reason;
    const destructionRequested = reason === "replaced" || reason === "stopped";
    record.cleanupAction = record.mapping === "managed"
      ? destructionRequested ? "destroy" : "suspend"
      : "none";
    record.cleanupStatus = record.mapping === "managed" ? "pending" : "unknown";
    if (record.mapping === "managed" && destructionRequested) record.retentionStatus = "destroy_pending";
    record.updatedAt = timestamp;
  }

  async getBinding(bindingId: string): Promise<ConversationAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    return binding ? copyBinding(binding) : undefined;
  }

  async deleteBinding(bindingId: string): Promise<void> {
    const binding = this.bindings.get(bindingId);
    if (binding) this.retireSessionActivation(binding, new Date().toISOString(), "recovered");
    this.bindings.delete(bindingId);
  }

  async listSessionHistory(
    conversationId: string,
    agentIdentityId?: string,
  ): Promise<RuntimeSessionHistoryRecord[]> {
    return [...this.sessionHistory.values()]
      .filter((record) => record.conversationId === conversationId
        && (!agentIdentityId || record.agentIdentityId === agentIdentityId))
      .sort((left, right) => left.activatedAt.localeCompare(right.activatedAt))
      .map((record) => ({ ...record }));
  }

  async listPendingSessionCleanups(limit: number): Promise<RuntimeSessionHistoryRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Session cleanup limit must be between 1 and 100");
    }
    return [...this.sessionHistory.values()]
      .filter((record) => record.state === "retired" && record.cleanupAction !== "none"
        && (record.cleanupStatus === "pending"
          || (record.cleanupStatus === "failed" && record.cleanupAttemptCount < 5)))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async recordSessionCleanupAttempt(input: RuntimeSessionCleanupAttempt): Promise<void> {
    const record = this.sessionHistory.get(`${input.bindingId}\0${input.bindingGeneration}`);
    if (!record || record.state !== "retired" || record.cleanupAction === "none") return;
    record.cleanupAttemptCount += 1;
    record.lastCleanupAttemptAt = input.attemptedAt;
    record.lastObservedRuntimeStatus = input.observedRuntimeStatus;
    record.cleanupStatus = input.outcome;
    if (input.retentionOutcome) record.retentionStatus = input.retentionOutcome;
    record.lastCleanupErrorCategory = input.outcome === "failed" ? input.errorCategory : undefined;
    record.lastVerifiedAt = input.attemptedAt;
    record.updatedAt = input.attemptedAt;
  }

  async listConversationBindings(conversationId: string): Promise<ConversationAgentBindingRecord[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.conversationId === conversationId)
      .map(copyBinding);
  }

  async listWorkspaceBindings(workspaceId: string): Promise<ConversationAgentBindingRecord[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.workspaceId === workspaceId)
      .map(copyBinding);
  }

  async acquireBindingLease(
    bindingId: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.state === "disabled") return undefined;
    if (binding.leaseOwner && binding.leaseOwner !== leaseOwner
      && binding.leaseExpiresAt && binding.leaseExpiresAt > now) return undefined;
    binding.leaseOwner = leaseOwner;
    binding.leaseExpiresAt = leaseExpiresAt;
    binding.updatedAt = now;
    return copyBinding(binding);
  }

  async renewBindingLease(
    bindingId: string,
    generation: number,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== generation || binding.leaseOwner !== leaseOwner
      || !binding.leaseExpiresAt || binding.leaseExpiresAt <= now) return false;
    binding.leaseExpiresAt = leaseExpiresAt;
    binding.updatedAt = now;
    return true;
  }

  async releaseBindingLease(
    bindingId: string,
    generation: number,
    leaseOwner: string,
  ): Promise<void> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== generation || binding.leaseOwner !== leaseOwner) return;
    delete binding.leaseOwner;
    delete binding.leaseExpiresAt;
  }

  async updateBindingState(
    bindingId: string,
    generation: number,
    leaseOwner: string,
    state: ConversationAgentBindingState,
    lastVerifiedAt: string | undefined,
    updatedAt: string,
    expectedState?: ConversationAgentBindingState,
    lifecycle?: {
      lastActiveAt?: string | null;
      sleptAt?: string | null;
      wakeRequestedAt?: string | null;
      managedSessionMissingAt?: string | null;
    },
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== generation || binding.leaseOwner !== leaseOwner
      || (expectedState !== undefined && binding.state !== expectedState)
      || !binding.leaseExpiresAt || binding.leaseExpiresAt <= updatedAt) {
      return undefined;
    }
    binding.state = state;
    if (lastVerifiedAt) binding.lastVerifiedAt = lastVerifiedAt;
    if (lifecycle?.lastActiveAt !== undefined) {
      if (lifecycle.lastActiveAt === null) delete binding.lastActiveAt;
      else binding.lastActiveAt = lifecycle.lastActiveAt;
    }
    if (lifecycle?.sleptAt !== undefined) {
      if (lifecycle.sleptAt === null) delete binding.sleptAt;
      else binding.sleptAt = lifecycle.sleptAt;
    }
    if (lifecycle?.wakeRequestedAt !== undefined) {
      if (lifecycle.wakeRequestedAt === null) delete binding.wakeRequestedAt;
      else binding.wakeRequestedAt = lifecycle.wakeRequestedAt;
    }
    if (lifecycle?.managedSessionMissingAt !== undefined) {
      if (lifecycle.managedSessionMissingAt === null) delete binding.managedSessionMissingAt;
      else binding.managedSessionMissingAt = lifecycle.managedSessionMissingAt;
    }
    if (state === "connected") delete binding.managedSessionMissingAt;
    binding.updatedAt = updatedAt;
    return copyBinding(binding);
  }

  async replaceBindingSession(
    bindingId: string,
    expectedGeneration: number,
    runtimeAdapter: string,
    runtimeSessionId: string,
    updatedAt: string,
    runtimeOwnerId?: string,
    activation?: { origin?: RuntimeSessionHistoryOrigin; conversationSequence?: number },
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== expectedGeneration) return undefined;
    validateRuntimeOwnerScope(runtimeOwnerId);
    const sessionOwner = [...this.bindings.values()].find(
      (candidate) => candidate.id !== bindingId
        && candidate.runtimeAdapter === runtimeAdapter
        && candidate.runtimeSessionId === runtimeSessionId
        && candidate.state !== "disabled",
    );
    if (sessionOwner) throw new Error("Runtime session is already bound");
    if (runtimeOwnerId && binding.runtimeOwnerId === runtimeOwnerId
      && binding.runtimeAdapter === runtimeAdapter
      && binding.runtimeSessionId === runtimeSessionId) {
      throw new Error("A managed session cannot be replaced by its current identity");
    }
    this.assertManagedSessionReusable({
      ...binding,
      runtimeAdapter,
      runtimeSessionId,
      runtimeOwnerId,
    });
    this.retireSessionActivation(binding, updatedAt, "replaced");
    binding.runtimeAdapter = runtimeAdapter;
    binding.runtimeSessionId = runtimeSessionId;
    binding.runtimeOwnerId = runtimeOwnerId;
    binding.generation += 1;
    binding.lastActiveAt = updatedAt;
    delete binding.sleptAt;
    delete binding.wakeRequestedAt;
    delete binding.managedSessionMissingAt;
    binding.updatedAt = updatedAt;
    this.createSessionActivation(binding, activation);
    // Remain visibly uncertain until the new session is leased, verified, and attached.
    binding.state = "replacing";
    delete binding.leaseOwner;
    delete binding.leaseExpiresAt;
    delete binding.lastVerifiedAt;
    return copyBinding(binding);
  }

  async getCursor(conversationId: string, participantId: string): Promise<number> {
    return this.cursors.get(`${conversationId}:${participantId}`) ?? 0;
  }

  async setCursor(conversationId: string, participantId: string, sequence: number): Promise<void> {
    const key = `${conversationId}:${participantId}`;
    this.cursors.set(key, Math.max(this.cursors.get(key) ?? 0, sequence));
  }

  async recordTurnFailure(input: TurnFailureDiagnosticInput): Promise<void> {
    const key = JSON.stringify([input.conversationId, input.participantId, input.triggerMessageId]);
    if (!this.turnFailures.has(key)) {
      this.turnFailures.set(key, {
        ...input,
        deliveryOutcome: "pending",
        createdAt: input.failedAt,
        updatedAt: input.failedAt,
      });
    }
    const retained = [...this.turnFailures.entries()]
      .filter(([, record]) => record.conversationId === input.conversationId)
      .sort(([, left], [, right]) => right.failedAt.localeCompare(left.failedAt)
        || right.triggerSequence - left.triggerSequence
        || left.participantId.localeCompare(right.participantId));
    for (const [expiredKey, expired] of retained.slice(100)) {
      this.turnFailures.delete(expiredKey);
      if (expired.deliveryOutcome === "pending") this.turnFailureFinalizationTombstones.add(expiredKey);
    }
  }

  async commitTurnFailureDelivery(input: TurnFailureDeliveryInput): Promise<void> {
    const key = JSON.stringify([input.conversationId, input.participantId, input.triggerMessageId]);
    const diagnostic = this.turnFailures.get(key);
    const cursorKey = `${input.conversationId}:${input.participantId}`;
    if (!diagnostic && !this.turnFailureFinalizationTombstones.has(key)
      && (this.cursors.get(cursorKey) ?? 0) < input.triggerSequence) {
      throw new Error("Matching turn-failure diagnostic is unavailable");
    }
    if (diagnostic?.deliveryOutcome === "pending") {
      diagnostic.deliveryOutcome = input.outcome;
      diagnostic.updatedAt = input.recordedAt;
    }
    this.cursors.set(cursorKey, Math.max(this.cursors.get(cursorKey) ?? 0, input.triggerSequence));
    this.turnFailureFinalizationTombstones.delete(key);
  }

  async listTurnFailures(conversationId: string, limit: number): Promise<TurnFailureDiagnosticRecord[]> {
    return [...this.turnFailures.values()]
      .filter((record) => record.conversationId === conversationId)
      .sort((left, right) => right.failedAt.localeCompare(left.failedAt)
        || right.triggerSequence - left.triggerSequence
        || left.participantId.localeCompare(right.participantId))
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async commitDeliveryDeadLetter(input: DeliveryDeadLetterInput): Promise<void> {
    const key = JSON.stringify([input.conversationId, input.participantId, input.triggerMessageId]);
    const existing = this.deliveryDeadLetters.get(key);
    this.deliveryDeadLetters.set(key, existing ?? {
      conversationId: input.conversationId,
      participantId: input.participantId,
      triggerMessageId: input.triggerMessageId,
      triggerSequence: input.triggerSequence,
      reason: input.reason,
      createdAt: input.recordedAt,
      updatedAt: input.recordedAt,
    });
    const diagnostic = this.turnFailures.get(key);
    const cursorKey = `${input.conversationId}:${input.participantId}`;
    if (input.requiresTurnFailure && !diagnostic && !this.turnFailureFinalizationTombstones.has(key)
      && (this.cursors.get(cursorKey) ?? 0) < input.triggerSequence) {
      throw new Error("Matching turn-failure diagnostic is unavailable");
    }
    if (diagnostic?.deliveryOutcome === "pending") {
      diagnostic.deliveryOutcome = input.reason;
      diagnostic.updatedAt = input.recordedAt;
    }
    this.cursors.set(
      cursorKey,
      Math.max(this.cursors.get(cursorKey) ?? 0, input.triggerSequence),
    );
    this.turnFailureFinalizationTombstones.delete(key);
  }

  async listDeliveryDeadLetters(
    conversationId: string,
    participantId: string,
  ): Promise<DeliveryDeadLetterRecord[]> {
    return [...this.deliveryDeadLetters.values()]
      .filter((record) => record.conversationId === conversationId && record.participantId === participantId)
      .sort((left, right) => left.triggerSequence - right.triggerSequence)
      .map((record) => ({ ...record }));
  }

  async disableBinding(
    bindingId: string,
    expectedGeneration: number,
    updatedAt: string,
  ): Promise<ConversationAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== expectedGeneration) return undefined;
    this.retireSessionActivation(binding, updatedAt, "stopped");
    binding.generation += 1;
    binding.state = "disabled";
    delete binding.wakeRequestedAt;
    delete binding.managedSessionMissingAt;
    delete binding.leaseOwner;
    delete binding.leaseExpiresAt;
    delete binding.lastVerifiedAt;
    binding.updatedAt = updatedAt;
    return copyBinding(binding);
  }

  async close(): Promise<void> {}
}

export class LocalRelayDirectory {
  constructor(
    private readonly client: ConversationClient,
    private readonly store: RelayBindingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async configureWorkspace(input: {
    workspaceId: string;
    rootUri: string;
    notesFolderId?: string | null;
    idleSleepTimeoutMs?: number | null;
  }): Promise<LocalWorkspaceConfig> {
    await this.client.getWorkspace(input.workspaceId);
    if (!input.rootUri.trim()) throw new Error("rootUri is required");
    const existing = await this.store.getWorkspaceConfig(input.workspaceId);
    const timestamp = this.now().toISOString();
    return this.store.putWorkspaceConfig({
      workspaceId: input.workspaceId,
      rootUri: input.rootUri,
      notesFolderId: input.notesFolderId === undefined
        ? existing?.notesFolderId
        : input.notesFolderId ?? undefined,
      runtimeModelPolicies: existing?.runtimeModelPolicies,
      idleSleepTimeoutMs: input.idleSleepTimeoutMs === undefined
        ? existing?.idleSleepTimeoutMs
        : input.idleSleepTimeoutMs ?? undefined,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  async configureRuntimeModelPolicy(input: {
    workspaceId: string;
    runtimeAdapter: string;
    models: RuntimeModelRef[];
  }): Promise<LocalWorkspaceConfig> {
    const existing = await this.store.getWorkspaceConfig(input.workspaceId);
    if (!existing) throw new Error("Private Workspace configuration is required");
    if (!input.runtimeAdapter.trim()) throw new Error("Runtime adapter is required");
    const timestamp = this.now().toISOString();
    return this.store.putWorkspaceConfig({
      ...existing,
      runtimeModelPolicies: {
        ...(existing.runtimeModelPolicies ?? {}),
        [input.runtimeAdapter]: input.models.map((model) => ({ ...model })),
      },
      updatedAt: timestamp,
    });
  }

  async configureAgent(input: {
    workspaceId: string;
    agentIdentityId: string;
    personaRef?: string | null;
    personaPrompt?: string | null;
    runtimeAdapter?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
    skillIds?: string[];
    handoffSummaryTokens?: number | null;
    recentContextTokens?: number | null;
    recentContextMessages?: number | null;
    status?: "active" | "disabled";
  }): Promise<WorkspaceAgentConfig> {
    const [identity, members, workspaceConfig] = await Promise.all([
      this.client.getIdentity(input.agentIdentityId),
      this.client.listWorkspaceMembers(input.workspaceId),
      this.store.getWorkspaceConfig(input.workspaceId),
    ]);
    const member = members.find(({ identityId }) => identityId === input.agentIdentityId);
    if (!workspaceConfig) throw new Error("Private Workspace configuration is required");
    if ((identity.type !== "agent" && identity.type !== "service") || identity.status !== "active"
      || !member || member.status !== "active") {
      throw new Error("Agent must be an active member of the Workspace");
    }
    const existing = await this.store.getWorkspaceAgentConfig(
      input.workspaceId,
      input.agentIdentityId,
    );
    const personaPrompt = input.personaPrompt === undefined
      ? existing?.personaPrompt
      : input.personaPrompt ?? undefined;
    const runtimeAdapter = input.runtimeAdapter === undefined
      ? existing?.runtimeAdapter
      : input.runtimeAdapter ?? undefined;
    const modelProvider = input.modelProvider === undefined
      ? existing?.modelProvider
      : input.modelProvider ?? undefined;
    const modelId = input.modelId === undefined ? existing?.modelId : input.modelId ?? undefined;
    const reasoningLevel = input.reasoningLevel === undefined
      ? existing?.reasoningLevel
      : input.reasoningLevel ?? undefined;
    const skillIds = input.skillIds === undefined ? existing?.skillIds : [...input.skillIds];
    const handoffSummaryTokens = input.handoffSummaryTokens === undefined
      ? existing?.handoffSummaryTokens
      : input.handoffSummaryTokens ?? undefined;
    const recentContextTokens = input.recentContextTokens === undefined
      ? existing?.recentContextTokens
      : input.recentContextTokens ?? undefined;
    const recentContextMessages = input.recentContextMessages === undefined
      ? existing?.recentContextMessages
      : input.recentContextMessages ?? undefined;
    if (personaPrompt !== undefined && !personaPrompt.trim()) {
      throw new Error("Persona prompt must not be empty");
    }
    if (runtimeAdapter !== undefined && !runtimeAdapter.trim()) {
      throw new Error("Runtime adapter must not be empty");
    }
    if (Boolean(modelProvider) !== Boolean(modelId)) {
      throw new Error("Model provider and id must be configured together");
    }
    const timestamp = this.now().toISOString();
    return this.store.putAgentConfig({
      id: existing?.id ?? createResourceId("config"),
      workspaceId: input.workspaceId,
      agentIdentityId: input.agentIdentityId,
      personaRef: input.personaRef === undefined
        ? existing?.personaRef
        : input.personaRef ?? undefined,
      personaPrompt,
      runtimeAdapter,
      modelProvider,
      modelId,
      reasoningLevel,
      skillIds,
      handoffSummaryTokens,
      recentContextTokens,
      recentContextMessages,
      status: input.status ?? existing?.status ?? "active",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  async bindAgent(input: {
    conversationId: string;
    agentIdentityId: string;
    runtimeAdapter: string;
    runtimeSessionId: string;
    runtimeOwnerId?: string;
    conversationSequenceAtActivation?: number;
    origin?: RuntimeSessionHistoryOrigin;
    wakePolicy?: WakePolicy;
  }): Promise<ConversationAgentBindingRecord> {
    if (!input.runtimeAdapter.trim() || !input.runtimeSessionId.trim()) {
      throw new Error("Runtime adapter and session id are required");
    }
    validateRuntimeOwnerScope(input.runtimeOwnerId);
    const conversation = await this.client.getConversation(input.conversationId);
    const participant = conversation.participants.find(({ id }) => id === input.agentIdentityId);
    if (!participant || (participant.type !== "agent" && participant.type !== "service")) {
      throw new Error("Agent must participate in the Conversation");
    }
    const config = await this.store.getWorkspaceAgentConfig(
      conversation.workspaceId,
      input.agentIdentityId,
    );
    if (!config || config.status !== "active") {
      throw new Error("Active private Workspace agent configuration is required");
    }
    const existing = (await this.store.listConversationBindings(input.conversationId))
      .find(({ agentIdentityId }) => agentIdentityId === input.agentIdentityId);
    if (existing) throw new Error("Conversation agent binding already exists; replace it explicitly");
    const timestamp = this.now().toISOString();
    return this.store.putBinding({
      id: createResourceId("binding"),
      workspaceAgentConfigId: config.id,
      workspaceId: conversation.workspaceId,
      conversationId: input.conversationId,
      agentIdentityId: input.agentIdentityId,
      runtimeAdapter: input.runtimeAdapter,
      runtimeSessionId: input.runtimeSessionId,
      runtimeOwnerId: input.runtimeOwnerId,
      generation: 1,
      state: "connected",
      wakePolicy: input.wakePolicy ?? "mentions",
      lastActiveAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, {
      origin: input.origin ?? (input.runtimeOwnerId ? "started" : "attached"),
      conversationSequence: input.conversationSequenceAtActivation,
    });
  }

  async replaceSession(input: {
    bindingId: string;
    expectedGeneration: number;
    runtimeAdapter: string;
    runtimeSessionId: string;
    runtimeOwnerId?: string;
    conversationSequenceAtActivation?: number;
    origin?: RuntimeSessionHistoryOrigin;
  }): Promise<ConversationAgentBindingRecord> {
    const replaced = await this.store.replaceBindingSession(
      input.bindingId,
      input.expectedGeneration,
      input.runtimeAdapter,
      input.runtimeSessionId,
      this.now().toISOString(),
      input.runtimeOwnerId,
      {
        origin: input.origin ?? (input.runtimeOwnerId ? "started" : "attached"),
        conversationSequence: input.conversationSequenceAtActivation,
      },
    );
    if (!replaced) throw new Error("Binding generation changed; reload before replacing the session");
    return replaced;
  }
}

export type RestoreBindingOutcome =
  | "attached"
  | "lease_unavailable"
  | "invalid_binding"
  | "runtime_unavailable"
  | "runtime_offline"
  | "runtime_uncertain";

export interface RestoreConversationBindingsOptions {
  client: ConversationClient;
  store: RelayBindingStore;
  conversationId: string;
  /** Restore only these records when attaching one runner to an already-live Relay. */
  bindingIds?: readonly string[];
  /** Defer connected state until the caller has completed Relay attachment. */
  markConnected?: boolean;
  leaseOwner: string;
  runtimes: Readonly<Record<string, AgentRuntimePort>>;
  leaseDurationMs?: number;
  statusTimeoutMs?: number;
  resumeTimeoutMs?: number;
  now?: () => Date;
}

export class RestoredConversationBindings {
  readonly bindings: AgentConversationBinding[];
  private closed = false;
  private renewalTimer: NodeJS.Timeout | undefined;
  private renewalActive = false;
  private onLeaseLost: (() => void | Promise<void>) | undefined;

  constructor(
    bindings: AgentConversationBinding[],
    readonly outcomes: ReadonlyMap<string, RestoreBindingOutcome>,
    private readonly records: ConversationAgentBindingRecord[],
    private readonly store: RelayBindingStore,
    private readonly leaseOwner: string,
    private readonly leaseDurationMs: number,
    private readonly now: () => Date,
  ) {
    this.bindings = bindings;
    this.beginRenewal();
  }

  async markConnected(): Promise<boolean> {
    if (this.closed) return false;
    const timestamp = this.now().toISOString();
    const results = await Promise.all(this.records.map((record) => record.state === "sleeping"
      ? this.store.updateBindingState(
        record.id,
        record.generation,
        this.leaseOwner,
        "sleeping",
        record.lastVerifiedAt,
        timestamp,
        "sleeping",
      )
      : this.store.updateBindingState(
        record.id,
        record.generation,
        this.leaseOwner,
        "connected",
        timestamp,
        timestamp,
        record.state === "waking" ? "waking" : undefined,
        record.state === "waking"
          ? { lastActiveAt: timestamp, wakeRequestedAt: null }
          : { lastActiveAt: timestamp },
      )));
    return results.every(Boolean);
  }

  async markOffline(): Promise<boolean> {
    if (this.closed) return false;
    const timestamp = this.now().toISOString();
    const results = await Promise.all(this.records.map((record) =>
      this.store.updateBindingState(
        record.id,
        record.generation,
        this.leaseOwner,
        "offline",
        record.lastVerifiedAt,
        timestamp,
      )));
    return results.every(Boolean);
  }

  async renew(): Promise<boolean> {
    if (this.closed) return false;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.leaseDurationMs).toISOString();
    const results = await Promise.all(this.records.map((record) =>
      this.store.renewBindingLease(
        record.id,
        record.generation,
        this.leaseOwner,
        now.toISOString(),
        expiresAt,
      )));
    return results.every(Boolean);
  }

  startAutoRenew(onLeaseLost: () => void | Promise<void>): void {
    if (this.closed) throw new Error("Conversation bindings are closed");
    this.onLeaseLost = onLeaseLost;
    this.beginRenewal();
  }

  private beginRenewal(): void {
    if (this.renewalTimer || this.records.length === 0 || this.closed) return;
    const intervalMs = Math.max(1, Math.floor(this.leaseDurationMs / 3));
    this.renewalTimer = setInterval(() => {
      if (this.renewalActive || this.closed) return;
      this.renewalActive = true;
      void this.renew().then(async (renewed) => {
        if (!renewed && !this.closed) {
          if (this.renewalTimer) clearInterval(this.renewalTimer);
          this.renewalTimer = undefined;
          await Promise.resolve(this.onLeaseLost?.()).catch(() => undefined);
        }
      }).catch(async () => {
        if (!this.closed) {
          if (this.renewalTimer) clearInterval(this.renewalTimer);
          this.renewalTimer = undefined;
          await Promise.resolve(this.onLeaseLost?.()).catch(() => undefined);
        }
      }).finally(() => {
        this.renewalActive = false;
      });
    }, intervalMs);
    this.renewalTimer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = undefined;
    await Promise.all(this.records.map((record) =>
      this.store.releaseBindingLease(record.id, record.generation, this.leaseOwner)));
  }
}

export async function restoreConversationBindings(
  options: RestoreConversationBindingsOptions,
): Promise<RestoredConversationBindings> {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError("leaseDurationMs must be a positive integer");
  }
  const statusTimeoutMs = options.statusTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(statusTimeoutMs) || statusTimeoutMs < 1) {
    throw new RangeError("statusTimeoutMs must be a positive integer");
  }
  const resumeTimeoutMs = options.resumeTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(resumeTimeoutMs) || resumeTimeoutMs < 1 || resumeTimeoutMs > 2_147_483_647) {
    throw new RangeError("resumeTimeoutMs must be a supported positive timeout");
  }
  const now = options.now ?? (() => new Date());
  const conversation = await options.client.getConversation(options.conversationId);
  const [candidates, workspaceMembers, workspaceConfig] = await Promise.all([
    options.store.listConversationBindings(options.conversationId),
    options.client.listWorkspaceMembers(conversation.workspaceId),
    options.store.getWorkspaceConfig(conversation.workspaceId),
  ]);
  if (!workspaceConfig) throw new Error("Private Workspace configuration is required");
  const bindings: AgentConversationBinding[] = [];
  const records: ConversationAgentBindingRecord[] = [];
  const outcomes = new Map<string, RestoreBindingOutcome>();
  const provisionalRenewals = new Map<string, {
    record: ConversationAgentBindingRecord;
    timer: NodeJS.Timeout;
    inFlight: Set<Promise<unknown>>;
  }>();
  const stopProvisional = async (bindingId: string) => {
    const provisional = provisionalRenewals.get(bindingId);
    if (!provisional) return;
    clearInterval(provisional.timer);
    await Promise.allSettled([...provisional.inFlight]);
    provisionalRenewals.delete(bindingId);
  };
  const releaseProvisional = async (bindingId: string) => {
    const provisional = provisionalRenewals.get(bindingId);
    if (!provisional) return;
    await stopProvisional(bindingId);
    await options.store.releaseBindingLease(
      provisional.record.id,
      provisional.record.generation,
      options.leaseOwner,
    );
  };

  try {
    for (const candidate of candidates) {
    if (options.bindingIds && !options.bindingIds.includes(candidate.id)) continue;
    if (candidate.state === "disabled") continue;
    const timestamp = now();
    const leased = await options.store.acquireBindingLease(
      candidate.id,
      options.leaseOwner,
      timestamp.toISOString(),
      new Date(timestamp.getTime() + leaseDurationMs).toISOString(),
    );
    if (!leased) {
      outcomes.set(candidate.id, "lease_unavailable");
      continue;
    }
    const renewalIntervalMs = Math.max(1, Math.floor(leaseDurationMs / 3));
    const inFlight = new Set<Promise<unknown>>();
    const provisionalRenewal = setInterval(() => {
      const checkedAt = now();
      const renewal = options.store.renewBindingLease(
        leased.id,
        leased.generation,
        options.leaseOwner,
        checkedAt.toISOString(),
        new Date(checkedAt.getTime() + leaseDurationMs).toISOString(),
      );
      inFlight.add(renewal);
      void renewal.catch(() => undefined).finally(() => inFlight.delete(renewal));
    }, renewalIntervalMs);
    provisionalRenewal.unref();
    provisionalRenewals.set(leased.id, { record: leased, timer: provisionalRenewal, inFlight });
    const release = async () => releaseProvisional(leased.id);
    if (leased.runtimeOwnerId === undefined
      && (leased.state === "sleeping" || leased.state === "waking")) {
      // Never infer managed ownership for legacy bindings, even during recovery.
      outcomes.set(leased.id, "invalid_binding");
      await release();
      continue;
    }
    const [config, identity] = await Promise.all([
      options.store.getAgentConfig(leased.workspaceAgentConfigId),
      options.client.getIdentity(leased.agentIdentityId).catch(() => undefined),
    ]);
    const participant = conversation.participants.find(({ id }) => id === leased.agentIdentityId);
    const member = workspaceMembers.find(({ identityId }) => identityId === leased.agentIdentityId);
    if (leased.workspaceId !== conversation.workspaceId || !participant || !member
      || member.status !== "active" || !identity || identity.status !== "active"
      || (identity.type !== "agent" && identity.type !== "service")
      || !config || config.status !== "active" || config.workspaceId !== leased.workspaceId
      || config.agentIdentityId !== leased.agentIdentityId) {
      outcomes.set(leased.id, "invalid_binding");
      await release();
      continue;
    }
    const runtime = options.runtimes[leased.runtimeAdapter];
    if (!runtime) {
      outcomes.set(leased.id, "runtime_unavailable");
      await release();
      continue;
    }
    let managedSessionState: "active" | "suspended" | "unavailable" | undefined;
    let interruptedWakeRecovered = false;
    let recoveredWakeBinding: ConversationAgentBindingRecord | undefined;
    if (leased.runtimeOwnerId !== undefined) {
      if (!leased.runtimeOwnerId.trim()) {
        outcomes.set(leased.id, "invalid_binding");
        await release();
        continue;
      }
      if (!runtime.listManagedSessions) {
        outcomes.set(leased.id, "runtime_unavailable");
        await release();
        continue;
      }
      let managedSessions: Awaited<ReturnType<NonNullable<AgentRuntimePort["listManagedSessions"]>>>;
      try {
        managedSessions = await withRuntimeTimeout(
          runtime.listManagedSessions(leased.runtimeOwnerId),
          statusTimeoutMs,
          "Runtime session listing",
        );
      } catch {
        outcomes.set(leased.id, "runtime_uncertain");
        await release();
        continue;
      }
      const ownedSession = managedSessions.find((session) =>
        session.id === leased.runtimeSessionId && session.ownerId === leased.runtimeOwnerId);
      if (!ownedSession) {
        const verifiedAt = now().toISOString();
        const offline = await options.store.updateBindingState(
          leased.id,
          leased.generation,
          options.leaseOwner,
          "offline",
          verifiedAt,
          verifiedAt,
          leased.state,
          {
            managedSessionMissingAt: verifiedAt,
            ...((leased.state === "sleeping" || leased.state === "waking")
              ? { wakeRequestedAt: null }
              : {}),
          },
        );
        outcomes.set(leased.id, offline ? "runtime_offline" : "runtime_uncertain");
        await release();
        continue;
      }
      managedSessionState = ownedSession.state;
      if (managedSessionState === "unavailable") {
        outcomes.set(leased.id, "runtime_uncertain");
        await release();
        continue;
      }
      if (leased.state === "waking") {
        if (!runtime.resume) {
          outcomes.set(leased.id, "runtime_unavailable");
          await release();
          continue;
        }
        let resumed: { id: string; ownerId: string } | undefined;
        try {
          // Resume is idempotent and serialized by Runtime. Calling it for an already-
          // active worker also waits out any interrupted suspend/resume transition.
          resumed = await withRuntimeTimeout(
            runtime.resume(leased.runtimeSessionId, leased.runtimeOwnerId),
            resumeTimeoutMs,
            "Runtime session resume",
          );
        } catch {
          // A timed-out request may still complete inside Runtime; retain the sleeping fence.
        }
        if (resumed && (resumed.id !== leased.runtimeSessionId || resumed.ownerId !== leased.runtimeOwnerId)) {
          outcomes.set(leased.id, "runtime_uncertain");
          await release();
          continue;
        }
        if (resumed) {
          managedSessionState = "active";
        } else {
          const sleeping = await options.store.updateBindingState(
            leased.id,
            leased.generation,
            options.leaseOwner,
            "sleeping",
            leased.lastVerifiedAt,
            now().toISOString(),
            "waking",
            { wakeRequestedAt: null },
          );
          if (!sleeping) {
            outcomes.set(leased.id, "runtime_uncertain");
            await release();
            continue;
          }
          // Reattach behind the sleeping fence so the next message retries the
          // idempotent owner-scoped wake.
          interruptedWakeRecovered = true;
          recoveredWakeBinding = sleeping;
          managedSessionState = ownedSession.state;
        }
      }
    }
    let status: "idle" | "working" | "offline" | "uncertain" | "suspended";
    if ((leased.state === "sleeping" || interruptedWakeRecovered) && managedSessionState === "suspended") {
      // The owner-scoped listing is authoritative for a sleeping binding; a suspended
      // Runtime session may correctly report offline to ordinary status queries.
      status = "suspended";
    } else {
      try {
        status = await withRuntimeTimeout(
          runtime.status(leased.runtimeSessionId),
          statusTimeoutMs,
          "Runtime status query",
        );
      } catch {
        status = "uncertain";
      }
    }
    const verifiedAt = now().toISOString();
    let remainsSleeping = leased.state === "sleeping" || interruptedWakeRecovered;
    if (leased.state === "waking" && !interruptedWakeRecovered && status !== "idle") {
      const sleeping = await options.store.updateBindingState(
        leased.id,
        leased.generation,
        options.leaseOwner,
        "sleeping",
        leased.lastVerifiedAt,
        verifiedAt,
        "waking",
        { wakeRequestedAt: null },
      );
      if (!sleeping) {
        outcomes.set(leased.id, "runtime_uncertain");
        await release();
        continue;
      }
      recoveredWakeBinding = sleeping;
      interruptedWakeRecovered = true;
      remainsSleeping = true;
    }
    if (!remainsSleeping && status === "uncertain") {
      outcomes.set(leased.id, "runtime_uncertain");
      await release();
      continue;
    }
    if (!remainsSleeping && status === "offline") {
      outcomes.set(leased.id, "runtime_offline");
      await options.store.updateBindingState(
        leased.id,
        leased.generation,
        options.leaseOwner,
        "offline",
        verifiedAt,
        verifiedAt,
      );
      await release();
      continue;
    }
    const connected = options.markConnected === false || remainsSleeping
      ? recoveredWakeBinding ?? leased
      : await options.store.updateBindingState(
        leased.id,
        leased.generation,
        options.leaseOwner,
        "connected",
        verifiedAt,
        verifiedAt,
        leased.state === "waking" ? "waking" : undefined,
        leased.state === "waking"
          ? { lastActiveAt: verifiedAt, wakeRequestedAt: null }
          : { lastActiveAt: verifiedAt },
      );
    if (!connected) {
      await release();
      continue;
    }
    outcomes.set(connected.id, "attached");
    records.push(connected);
    bindings.push({
      participantId: connected.agentIdentityId,
      sessionId: connected.runtimeSessionId,
      runtime,
      wakePolicy: connected.wakePolicy,
      maxMessages: config.recentContextMessages ?? DEFAULT_RECENT_CONTEXT_MESSAGES,
      maxTokens: config.recentContextTokens ?? DEFAULT_RECENT_CONTEXT_TOKENS,
      diagnosticBinding: { id: connected.id, generation: connected.generation, workspaceId: connected.workspaceId },
      isSleeping: remainsSleeping,
      verifyLease: async () => {
        const checkedAt = now();
        return options.store.renewBindingLease(
          connected.id,
          connected.generation,
          options.leaseOwner,
          checkedAt.toISOString(),
          new Date(checkedAt.getTime() + leaseDurationMs).toISOString(),
        );
      },
      ensureAwake: connected.runtimeOwnerId ? async () => {
        const latest = await options.store.getBinding(connected.id);
        if (!latest || latest.generation !== connected.generation
          || latest.runtimeSessionId !== connected.runtimeSessionId
          || latest.runtimeOwnerId !== connected.runtimeOwnerId) {
          throw new Error("Managed binding changed before wake");
        }
        if (latest.state !== "sleeping" && latest.state !== "waking") return;
        const ownerId = latest.runtimeOwnerId;
        if (!ownerId || !runtime.listManagedSessions) {
          throw new Error("Managed session listing is unavailable");
        }
        const requestedAt = now().toISOString();
        const waking = await options.store.updateBindingState(
          latest.id,
          latest.generation,
          options.leaseOwner,
          "waking",
          latest.lastVerifiedAt,
          requestedAt,
          latest.state,
          { wakeRequestedAt: latest.wakeRequestedAt ?? requestedAt },
        );
        if (!waking) throw new Error("Managed binding lease changed before wake");
        try {
          const sessions = await withRuntimeTimeout(
            runtime.listManagedSessions(ownerId),
            statusTimeoutMs,
            "Runtime session listing",
          );
          const owned = sessions.find((session) =>
            session.id === latest.runtimeSessionId && session.ownerId === latest.runtimeOwnerId);
          if (!owned) {
            const verifiedAt = now().toISOString();
            const offline = await options.store.updateBindingState(
              latest.id,
              latest.generation,
              options.leaseOwner,
              "offline",
              verifiedAt,
              verifiedAt,
              "waking",
              { wakeRequestedAt: null, managedSessionMissingAt: verifiedAt },
            );
            if (!offline) throw new Error("Managed binding lease changed during missing-session recovery");
            return "missing";
          }
          if (owned.state === "unavailable") {
            throw new Error("Managed Runtime session is unavailable");
          }
          if (!runtime.resume) throw new Error("Managed Runtime resume is unavailable");
          // Runtime serializes idempotent resume with suspend. This is required even
          // when inventory says active because a timed-out suspend may still be settling.
          const resumed = await withRuntimeTimeout(
            runtime.resume(latest.runtimeSessionId, ownerId),
            resumeTimeoutMs,
            "Runtime session resume",
          );
          if (resumed.id !== latest.runtimeSessionId || resumed.ownerId !== ownerId) {
            throw new Error("Runtime resumed a different managed session");
          }
          const status = await withRuntimeTimeout(
            runtime.status(latest.runtimeSessionId),
            statusTimeoutMs,
            "Runtime status query",
          );
          if (status !== "idle") throw new Error("Managed Runtime session is not verified idle");
          const verifiedAt = now().toISOString();
          const awake = await options.store.updateBindingState(
            latest.id,
            latest.generation,
            options.leaseOwner,
            "connected",
            verifiedAt,
            verifiedAt,
            "waking",
            { lastActiveAt: verifiedAt, wakeRequestedAt: null },
          );
          if (!awake) throw new Error("Managed binding lease changed during wake");
        } catch (error) {
          await options.store.updateBindingState(
            latest.id,
            latest.generation,
            options.leaseOwner,
            "sleeping",
            latest.lastVerifiedAt,
            now().toISOString(),
            "waking",
            { wakeRequestedAt: null },
          ).catch(() => undefined);
          throw error;
        }
      } : undefined,
      onTurnSettled: connected.runtimeOwnerId ? async () => {
        const timestamp = now().toISOString();
        const touched = await options.store.updateBindingState(
          connected.id,
          connected.generation,
          options.leaseOwner,
          "connected",
          connected.lastVerifiedAt,
          timestamp,
          "connected",
          { lastActiveAt: timestamp },
        );
        if (!touched) throw new Error("Could not persist managed binding activity");
      } : undefined,
    });
    }

    // Stop and drain provisional renewal before transferring every surviving lease. Draining
    // first prevents an already-started renewal from racing a later close/release.
    await Promise.all([...provisionalRenewals.keys()].map(stopProvisional));
    return new RestoredConversationBindings(
      bindings,
      outcomes,
      records,
      options.store,
      options.leaseOwner,
      leaseDurationMs,
      now,
    );
  } catch (error) {
    await Promise.allSettled([...provisionalRenewals.keys()].map(releaseProvisional));
    throw error;
  }
}
