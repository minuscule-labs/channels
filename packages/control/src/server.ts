import type {
  ConversationMetadata,
  ConversationMessage,
  CreateMessageInput,
  EffectiveConversationLifecycle,
  UpdateConversationLifecycleInput,
} from "@minu/channels-core/types";
import { ConversationClientError, ConversationValidationError, resolveMessageTargets } from "@minu/channels-core";
import { threadDefaultRecipient } from "@minu/channels-core/mentions";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { agentActionInput, LocalAgentActions } from "./agent-actions.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { LocalConfigurationRequestError } from "./configuration.ts";
import { DEFAULT_CONTROL_PORT, isLocalConversationsHostname } from "./local-host.ts";
import { LocalControlBrowserSessions, type LocalControlBrowserSession } from "./session.ts";

const execFileAsync = promisify(execFile);

function normalizedSelectedPath(stdout: string): string {
  const path = stdout.trim();
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

async function chooseLocalFolder(): Promise<string | undefined> {
  const signal = AbortSignal.timeout(2 * 60_000);
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", [
        "-e",
        "POSIX path of (choose folder with prompt \"Choose a MinuChannels Workspace source folder\")",
      ], { signal });
      return normalizedSelectedPath(stdout);
    } catch (error) {
      if (String((error as { stderr?: unknown }).stderr ?? "").includes("(-128)")) return undefined;
      throw new LocalConfigurationRequestError("Native folder selection failed; enter an absolute path instead", 409, "unavailable");
    }
  }
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Choose a MinuChannels Workspace source folder"], { signal });
      return normalizedSelectedPath(stdout);
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return undefined;
      throw new LocalConfigurationRequestError("Native folder selection requires zenity; enter an absolute path instead", 409, "unavailable");
    }
  }
  throw new LocalConfigurationRequestError("Native folder selection is unavailable; enter an absolute path instead", 409, "unavailable");
}
export {
  LocalControlBrowserSessions,
  type LocalControlAuditAction,
  type LocalControlAuditEvent,
  type LocalControlBrowserSession,
  type LocalControlBrowserSessionsOptions,
  type LocalControlLaunchExchange,
} from "./session.ts";
import type { LocalAgentDiagnosticReads } from "./agent-diagnostic-reads.ts";
import type { LocalAgentSessionInspections } from "./agent-session-inspection.ts";
import type { LocalDeliveryReads } from "./delivery-reads.ts";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalAgentActivity,
  type LocalAgentActionInput, type LocalAgentActionReceipt,
  type LocalAgentOperationHistory, type LocalAgentOperationDetail, type LocalAgentDiagnosticReport,
  type LocalAgentRuntimeOptions,
  type LocalAuthoredDocument,
  type LocalAuthoredDocumentRevision,
  type LocalAuthoredDocumentSummary,
  type LocalAuthoredSkillInvocationReceipt,
  type LocalAuthoredSkillInvocationPublicationReceipt,
  type LocalConversationAuthoredContext,
  type LocalConversationAuthoredSkillCatalog,
  type LocalBulkAgentLifecycleResponse,
  type LocalBulkAgentLifecycleResult,
  type LocalConversationAgent,
  type LocalConversationAgentsResponse,
  type LocalConversationWorkingFolders,
  type LocalConversationTurnFailuresResponse,
  type LocalControlCapabilities,
  type LocalControlHealth,
  type LocalLiveCapabilityState,
  type LocalRuntimeOptions,
  type LocalSessionContextMode,
  type LocalWakePolicy,
  type ProvisionLocalWorkspaceResult,
  type LocalWorkspaceAgentConfiguration,
  type LocalWorkspaceConfigurationSummary,
  type LocalConversationPresets,
  type ConversationPreset,
  type LocalConversationCreationSetup,
  type LocalConversationSettings,
} from "./contracts.ts";

export interface LocalControlConversationDirectory {
  getConversation(conversationId: string): Promise<ConversationMetadata>;
  listMessages?(conversationId: string, options?: { limit?: number }): Promise<ConversationMessage[]>;
  postMessage?(conversationId: string, input: CreateMessageInput, options?: { idempotencyKey?: string }): Promise<ConversationMessage>;
  listThreads?(conversationId: string): Promise<ConversationMetadata[]>;
  getConversationLifecycle?(conversationId: string): Promise<EffectiveConversationLifecycle>;
  updateConversationLifecycle?(
    conversationId: string,
    input: UpdateConversationLifecycleInput,
  ): Promise<EffectiveConversationLifecycle>;
}

export interface LocalControlBindingRecord {
  agentIdentityId: string;
  runtimeAdapter: string;
  runtimeSessionId: string;
  runtimeOwnerId?: string;
  state: "connected" | "sleeping" | "waking" | "offline" | "replacing" | "stopping" | "paused" | "disabled";
  wakePolicy: LocalWakePolicy;
  lastVerifiedAt?: string;
}

export interface LocalControlBindingDirectory {
  listConversationBindings(conversationId: string): Promise<LocalControlBindingRecord[]>;
}

export interface LocalControlRuntimeSessionCapabilities {
  version: 1;
  safeActivityEvents: boolean;
  interrupt: boolean;
  reconnectExisting: boolean;
  interactiveAttach: boolean;
  openDiagnostic: boolean;
  liveSkillVerification: boolean;
}

export interface LocalControlRuntimePort {
  forceStopManaged?(managedSessionId: string, ownerId: string): Promise<void>;
  status(sessionId: string): Promise<"idle" | "working" | "offline">;
  inspectSessionProfile?(managedSessionId: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  sessionCapabilities?(
    sessionId: string,
  ): Promise<LocalControlRuntimeSessionCapabilities>;
  activityEvents?(
    sessionId: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<{ phase: "working" | "using_tools" | "responding"; observedAt: string }>;
  interrupt?(sessionId: string): Promise<void>;
  openDiagnostic?(sessionId: string): Promise<void>;
}

export interface LocalControlAgentLifecyclePort {
  readonly available: boolean;
  fenceConversationAdmission?(conversationId: string): () => void;
  clearConversationAdmissionFence?(conversationId: string): void;
  startConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    contextMode?: LocalSessionContextMode,
  ): Promise<void>;
  autoStartConversationAgent?(conversationId: string, agentIdentityId: string, actorIdentityId: string, triggerMessageId: string): Promise<void>;
  replaceConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    contextMode?: LocalSessionContextMode,
  ): Promise<void>;
  stopConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  recoverConversationAgent?(conversationId: string, agentIdentityId: string, actorIdentityId: string, restart: boolean): Promise<void>;
  reconnectConversationAgent?(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  isAttached?(conversationId: string, agentIdentityId: string): boolean;
  refreshConversationWorkSnapshot?(conversationId: string): Promise<void>;
  agentWorkSnapshot?(conversationId: string, agentIdentityId: string): {
    activeTurns: number;
    queuedTurns: number;
    queuedTurnsExact: boolean;
    stopRequested?: boolean;
  } | undefined;
  isStarting?(conversationId: string, agentIdentityId: string): boolean;
  startAllConversationAgents?(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]>;
  stopAllConversationAgents?(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]>;
  cancelCurrentConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  listConversationTurnFailures?(
    conversationId: string,
    actorIdentityId: string,
    limit: number,
  ): Promise<LocalConversationTurnFailuresResponse>;
  activity?(conversationId: string, agentIdentityId: string): LocalAgentActivity | undefined;
}

export interface LocalControlConfigurationPort {
  listConversationPresets?(workspaceId: string, actor: string): Promise<LocalConversationPresets>;
  saveConversationPreset?(workspaceId: string, presetId: string, actor: string, input: unknown): Promise<ConversationPreset>;
  deleteConversationPreset?(workspaceId: string, presetId: string, actor: string, input: unknown): Promise<void>;
  createConversationWithSetup?(workspaceId: string, actor: string, input: unknown): Promise<ConversationMetadata>;
  getConversationSettings?(conversationId: string, actor: string): Promise<LocalConversationSettings>;
  updateConversationSettings?(conversationId: string, actor: string, input: unknown): Promise<LocalConversationSettings>;
  getConversationCreationSetup?(conversationId: string, actor: string): Promise<LocalConversationCreationSetup>;
  acceptAuthoredSkillInvocation?(conversationId: string, actorIdentityId: string, requestId: string, input: unknown): Promise<LocalAuthoredSkillInvocationReceipt>;
  getAuthoredSkillInvocation?(conversationId: string, actorIdentityId: string, requestId: string): Promise<LocalAuthoredSkillInvocationReceipt>;
  getAuthoredSkillInvocationPublication?(conversationId: string, actorIdentityId: string, requestId: string): Promise<LocalAuthoredSkillInvocationPublicationReceipt>;
  publishAuthoredSkillInvocation?(conversationId: string, actorIdentityId: string, input: unknown, assertSession?: () => void): Promise<LocalAuthoredSkillInvocationPublicationReceipt>;
  getConversationAuthoredSkillCatalog?(conversationId: string, actorIdentityId: string): Promise<LocalConversationAuthoredSkillCatalog>;
  getConversationAuthoredContext?(conversationId: string, actorIdentityId: string): Promise<LocalConversationAuthoredContext>;
  listAuthoredDocuments?(workspaceId: string, actorIdentityId: string): Promise<LocalAuthoredDocumentSummary[]>;
  getAuthoredDocument?(workspaceId: string, documentId: string, actorIdentityId: string): Promise<LocalAuthoredDocument>;
  listAuthoredDocumentRevisions?(workspaceId: string, documentId: string, actorIdentityId: string): Promise<LocalAuthoredDocumentRevision[]>;
  createAuthoredDocument?(workspaceId: string, actorIdentityId: string, input: unknown): Promise<LocalAuthoredDocument>;
  updateAuthoredDocument?(workspaceId: string, documentId: string, actorIdentityId: string, input: unknown): Promise<LocalAuthoredDocument>;
  provisionWorkspace?(actorIdentityId: string, input: unknown): Promise<ProvisionLocalWorkspaceResult>;
  getWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceConfigurationSummary>;
  getConversationWorkingFolders(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationWorkingFolders>;
  previewConversationWorkingFolder(
    conversationId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<{ relativePath: string }>;
  updateConversationWorkingFolders(
    conversationId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalConversationWorkingFolders>;
  getWorkspaceAgentConfiguration?(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceAgentConfiguration>;
  getWorkspaceRuntimeOptions(
    workspaceId: string,
    runtimeAdapter: string,
    actorIdentityId: string,
  ): Promise<LocalRuntimeOptions>;
  getAgentRuntimeOptions(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<LocalAgentRuntimeOptions>;
  updateAgentRuntimeModelPolicy(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalAgentRuntimeOptions>;
  updateWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary>;
  updateWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary>;
}

export interface LocalControlServiceOptions {
  conversations: LocalControlConversationDirectory;
  /** In-process Conversation service gate, held from head verification through lifecycle commit. */
  withConversationMessageAdmission?<T>(conversationId: string, operation: () => Promise<T>): Promise<T>;
  bindings: LocalControlBindingDirectory;
  runtimes: Readonly<Record<string, LocalControlRuntimePort>>;
  configuration?: LocalControlConfigurationPort;
  /** Default-disabled until the explicit publication boundary is independently approved. No UI setting. */
  authoredSkillPublicationEnabled?: boolean;
  lifecycle?: LocalControlAgentLifecyclePort;
  diagnosticReads?: Pick<LocalAgentDiagnosticReads, "history" | "detail" | "report">;
  sessionInspections?: Pick<LocalAgentSessionInspections, "read" | "events">;
  deliveryReads?: Pick<LocalDeliveryReads, "read">;
  statusTimeoutMs?: number;
}

const disabledCapabilities = {
  start: false,
  replace: false,
  stop: false,
  steer: false,
  interrupt: false,
  reconnect: false,
} as const;

const unavailableLiveCapabilities = {
  safeActivityEvents: "unavailable",
  interrupt: "unavailable",
  reconnectExisting: "unavailable",
  interactiveAttach: "unavailable",
  openDiagnostic: "unavailable",
  liveSkillVerification: "unavailable",
} as const;

const notVerifiedLiveCapabilities = {
  safeActivityEvents: "not_verified",
  interrupt: "not_verified",
  reconnectExisting: "not_verified",
  interactiveAttach: "not_verified",
  openDiagnostic: "not_verified",
  liveSkillVerification: "not_verified",
} as const;

function presentLiveCapabilities(
  capabilities: LocalControlRuntimeSessionCapabilities | undefined,
): NonNullable<LocalConversationAgent["diagnostics"]>["capabilities"] {
  if (!capabilities) return notVerifiedLiveCapabilities;
  const state = (available: boolean): LocalLiveCapabilityState =>
    available ? "available" : "unavailable";
  return {
    safeActivityEvents: state(capabilities.safeActivityEvents),
    interrupt: state(capabilities.interrupt),
    reconnectExisting: state(capabilities.reconnectExisting),
    interactiveAttach: state(capabilities.interactiveAttach),
    openDiagnostic: state(capabilities.openDiagnostic),
    liveSkillVerification: state(capabilities.liveSkillVerification),
  };
}

export class LocalControlService {
  private readonly statusTimeoutMs: number;
  private readonly lifecycleTransitions = new Map<string, Promise<EffectiveConversationLifecycle>>();
  private readonly agentActions = new LocalAgentActions();
  private readonly conversationSends = new Map<string, Promise<unknown>>();

  constructor(private readonly options: LocalControlServiceOptions) {
    this.statusTimeoutMs = options.statusTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.statusTimeoutMs) || this.statusTimeoutMs < 1) {
      throw new RangeError("statusTimeoutMs must be a positive integer");
    }
  }

  health(): LocalControlHealth {
    return { status: "ok", protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION };
  }

  async getConversationLifecycle(
    conversationId: string,
  ): Promise<EffectiveConversationLifecycle> {
    if (!this.options.conversations.getConversationLifecycle) {
      throw new LocalConfigurationRequestError("Conversation lifecycle is unavailable", 409, "unavailable");
    }
    return await this.options.conversations.getConversationLifecycle(conversationId);
  }

  async updateConversationLifecycle(
    conversationId: string,
    actorIdentityId: string,
    input: Omit<UpdateConversationLifecycleInput, "actorIdentityId">,
  ): Promise<EffectiveConversationLifecycle> {
    const prior = this.lifecycleTransitions.get(conversationId) ?? Promise.resolve({ state: "active" });
    const operation = prior.catch(() => ({ state: "active" } as EffectiveConversationLifecycle)).then(
      () => this.updateConversationLifecycleOnce(conversationId, actorIdentityId, input),
    );
    this.lifecycleTransitions.set(conversationId, operation);
    try {
      return await operation;
    } finally {
      if (this.lifecycleTransitions.get(conversationId) === operation) {
        this.lifecycleTransitions.delete(conversationId);
      }
    }
  }

  private async updateConversationLifecycleOnce(
    conversationId: string,
    actorIdentityId: string,
    input: Omit<UpdateConversationLifecycleInput, "actorIdentityId">,
  ): Promise<EffectiveConversationLifecycle> {
    if (!this.options.conversations.updateConversationLifecycle) {
      throw new LocalConfigurationRequestError("Conversation lifecycle is unavailable", 409, "unavailable");
    }
    if (!input || !["active", "snoozed", "settled"].includes(input.state)) {
      throw new LocalConfigurationRequestError("Conversation lifecycle state is invalid", 400, "invalid");
    }
    if (input.state === "snoozed" && (
      typeof input.snoozedUntil !== "string"
      || Number.isNaN(Date.parse(input.snoozedUntil))
      || Date.parse(input.snoozedUntil) <= Date.now()
    )) {
      throw new LocalConfigurationRequestError("Conversation snooze time must be in the future", 400, "invalid");
    }
    const conversation = await this.options.conversations.getConversation(conversationId);
    if (conversation.thread) throw new LocalConfigurationRequestError("Threads inherit the parent Conversation lifecycle", 409, "unavailable");
    const current = await this.getConversationLifecycle(conversationId);
    if (current.state === "settled" && input.state !== "active") {
      throw new LocalConfigurationRequestError("A settled Conversation must be reopened first", 409, "unavailable");
    }
    if (input.state === "active") {
      const lifecycle = await this.options.conversations.updateConversationLifecycle(conversationId, {
        actorIdentityId,
        state: "active",
      });
      this.options.lifecycle?.clearConversationAdmissionFence?.(conversationId);
      return lifecycle;
    }

    if (!this.options.withConversationMessageAdmission) {
      throw new LocalConfigurationRequestError("Conversation message admission coordination is unavailable", 409, "unavailable");
    }
    const releaseFence = this.options.lifecycle?.fenceConversationAdmission?.(conversationId);
    let committed = false;
    try {
      return await this.options.withConversationMessageAdmission(conversationId, async () => {
        let scopeIds = [conversationId];
        try {
          const threads = await this.options.conversations.listThreads?.(conversationId) ?? [];
          scopeIds = [conversationId, ...threads.map(({ id }) => id)];
          await Promise.all(scopeIds.map((id) => this.options.lifecycle?.refreshConversationWorkSnapshot?.(id)));
        } catch {
          throw new LocalConfigurationRequestError(
            "Conversation agent work could not be verified; retry",
            409,
            "unavailable",
          );
        }
        const agents = (await Promise.all(scopeIds.map(async (id) =>
          (await this.listConversationAgents(id)).agents.map((agent) => ({ ...agent, scopeId: id })),
        ))).flat();
        const unsafeAgents = agents.filter(({ state }) => !["unbound", "disabled", "stopped", "idle"].includes(state));
        if (unsafeAgents.length > 0 || agents.some((agent) => {
          if (agent.state !== "idle" || this.options.lifecycle?.isAttached?.(agent.scopeId, agent.identityId) !== true) return false;
          const work = this.options.lifecycle.agentWorkSnapshot?.(agent.scopeId, agent.identityId);
          return !work || work.activeTurns !== 0 || work.queuedTurns !== 0 || !work.queuedTurnsExact;
        })) {
          throw new LocalConfigurationRequestError(
            "All managed Conversation agents must be idle or stopped before snoozing or settling",
            409,
            "unavailable",
          );
        }
        for (const agent of agents.filter(({ state }) => state === "idle")) {
          if (!this.options.lifecycle) {
            throw new LocalConfigurationRequestError("Managed agent control is unavailable", 409, "unavailable");
          }
          await this.options.lifecycle.stopConversationAgent(agent.scopeId, agent.identityId, actorIdentityId);
        }
        const afterStop = (await Promise.all(scopeIds.map((id) => this.listConversationAgents(id)))).flatMap(({ agents }) => agents);
        if (afterStop.some(({ state }) => !["unbound", "disabled", "stopped"].includes(state))) {
          throw new LocalConfigurationRequestError(
            "Conversation agents changed while lifecycle was being updated; retry",
            409,
            "unavailable",
          );
        }
        const lifecycle = await this.options.conversations.updateConversationLifecycle!(conversationId, {
          actorIdentityId,
          state: input.state,
          ...(input.state === "snoozed" ? { snoozedUntil: input.snoozedUntil } : {}),
        });
        committed = true;
        return lifecycle;
      });
    } finally {
      // A persisted non-active lifecycle keeps the admission fence until an explicit reopen.
      if (!committed) releaseFence?.();
    }
  }

  capabilities(): LocalControlCapabilities {
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      features: {
        currentSession: true,
        conversationAgentStatus: true,
        workspaceConfigRead: Boolean(this.options.configuration),
        workspaceConfigWrite: Boolean(this.options.configuration),
        conversationWorkingFolders: Boolean(this.options.configuration),
        agentCreate: false,
        agentRuntimeOptions: Boolean(this.options.configuration),
        agentSkills: Boolean(this.options.configuration),
        authoredContent: Boolean(this.options.configuration?.getConversationAuthoredContext && this.options.configuration?.createAuthoredDocument),
        authoredSkillPublication: this.authoredSkillPublicationEnabled,
        agentStart: Boolean(this.options.lifecycle?.available),
        agentReplace: Boolean(this.options.lifecycle?.available),
        agentStop: Boolean(this.options.lifecycle?.available),
        agentBulkStart: Boolean(this.options.lifecycle?.available && this.options.lifecycle.startAllConversationAgents),
        agentBulkStop: Boolean(this.options.lifecycle?.available && this.options.lifecycle.stopAllConversationAgents),
        steer: false,
        interrupt: Boolean(this.options.lifecycle?.available),
        reconnect: Boolean(this.options.lifecycle?.available && this.options.lifecycle.reconnectConversationAgent),
      },
    };
  }

  async provisionWorkspace(actorIdentityId: string, input: unknown): Promise<ProvisionLocalWorkspaceResult> {
    if (!this.options.configuration?.provisionWorkspace) {
      throw new LocalConfigurationRequestError("Workspace provisioning unavailable", 404, "unavailable");
    }
    return this.options.configuration.provisionWorkspace(actorIdentityId, input);
  }

  async listConversationPresets(workspaceId: string, actor: string) {
    if (!this.options.configuration?.listConversationPresets) throw new LocalConfigurationRequestError("Conversation presets unavailable", 404, "unavailable");
    return this.options.configuration.listConversationPresets(workspaceId, actor);
  }

  async saveConversationPreset(workspaceId: string, presetId: string, actor: string, input: unknown) {
    if (!this.options.configuration?.saveConversationPreset) throw new LocalConfigurationRequestError("Conversation presets unavailable", 404, "unavailable");
    return this.options.configuration.saveConversationPreset(workspaceId, presetId, actor, input);
  }

  async deleteConversationPreset(workspaceId: string, presetId: string, actor: string, input: unknown) {
    if (!this.options.configuration?.deleteConversationPreset) throw new LocalConfigurationRequestError("Conversation presets unavailable", 404, "unavailable");
    return this.options.configuration.deleteConversationPreset(workspaceId, presetId, actor, input);
  }

  async createConversationWithSetup(workspaceId: string, actor: string, input: unknown) {
    if (!this.options.configuration?.createConversationWithSetup) throw new LocalConfigurationRequestError("Conversation creation unavailable", 404, "unavailable");
    return this.options.configuration.createConversationWithSetup(workspaceId, actor, input);
  }

  async getConversationSettings(conversationId: string, actor: string) {
    if (!this.options.configuration?.getConversationSettings) throw new LocalConfigurationRequestError("Conversation settings unavailable", 404, "unavailable");
    return this.options.configuration.getConversationSettings(conversationId, actor);
  }
  async updateConversationSettings(conversationId: string, actor: string, input: unknown) {
    if (!this.options.configuration?.updateConversationSettings) throw new LocalConfigurationRequestError("Conversation settings unavailable", 404, "unavailable");
    return this.options.configuration.updateConversationSettings(conversationId, actor, input);
  }

  async getConversationCreationSetup(conversationId: string, actor: string) {
    if (!this.options.configuration?.getConversationCreationSetup) throw new LocalConfigurationRequestError("Conversation setup unavailable", 404, "unavailable");
    return this.options.configuration.getConversationCreationSetup(conversationId, actor);
  }

  async getConversationWorkingFolders(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationWorkingFolders> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Conversation working folders unavailable", 404, "unavailable");
    }
    return this.options.configuration.getConversationWorkingFolders(conversationId, actorIdentityId);
  }

  async previewConversationWorkingFolder(
    conversationId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<{ relativePath: string }> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Conversation working folders unavailable", 404, "unavailable");
    }
    return this.options.configuration.previewConversationWorkingFolder(conversationId, actorIdentityId, input);
  }

  async updateConversationWorkingFolders(
    conversationId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalConversationWorkingFolders> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Conversation working folders unavailable", 404, "unavailable");
    }
    return this.options.configuration.updateConversationWorkingFolders(conversationId, actorIdentityId, input);
  }

  async acceptAuthoredSkillInvocation(conversationId: string, actorIdentityId: string, requestId: string, input: unknown): Promise<LocalAuthoredSkillInvocationReceipt> {
    if (!this.options.configuration?.acceptAuthoredSkillInvocation) {
      throw new LocalConfigurationRequestError("Skill invocation acceptance unavailable", 404, "unavailable");
    }
    return this.withConversationSendOrder(conversationId, () =>
      this.options.configuration!.acceptAuthoredSkillInvocation!(conversationId, actorIdentityId, requestId, input));
  }

  async getAuthoredSkillInvocation(conversationId: string, actorIdentityId: string, requestId: string): Promise<LocalAuthoredSkillInvocationReceipt> {
    if (!this.options.configuration?.getAuthoredSkillInvocation) {
      throw new LocalConfigurationRequestError("Skill invocation acceptance unavailable", 404, "unavailable");
    }
    return this.options.configuration.getAuthoredSkillInvocation(conversationId, actorIdentityId, requestId);
  }

  async getAuthoredSkillInvocationPublication(conversationId: string, actorIdentityId: string, requestId: string): Promise<LocalAuthoredSkillInvocationPublicationReceipt> {
    if (!this.options.configuration?.getAuthoredSkillInvocationPublication) {
      throw new LocalConfigurationRequestError("Skill invocation publication is unavailable", 404, "unavailable");
    }
    return this.options.configuration.getAuthoredSkillInvocationPublication(conversationId, actorIdentityId, requestId);
  }

  get authoredSkillPublicationEnabled(): boolean {
    return this.options.authoredSkillPublicationEnabled === true && !!this.options.configuration?.publishAuthoredSkillInvocation;
  }

  async publishAuthoredSkillInvocation(conversationId: string, actorIdentityId: string, input: unknown, assertSession?: () => void): Promise<LocalAuthoredSkillInvocationPublicationReceipt> {
    if (!this.authoredSkillPublicationEnabled) throw new LocalConfigurationRequestError("Skill invocation publication is unavailable", 404, "unavailable");
    return this.withConversationSendOrder(conversationId, () => {
      assertSession?.();
      return this.options.configuration!.publishAuthoredSkillInvocation!(conversationId, actorIdentityId, input, assertSession);
    });
  }

  async getConversationAuthoredSkillCatalog(conversationId: string, actorIdentityId: string): Promise<LocalConversationAuthoredSkillCatalog> {
    if (!this.options.configuration?.getConversationAuthoredSkillCatalog) {
      throw new LocalConfigurationRequestError("Skill catalog is unavailable", 404, "unavailable");
    }
    const catalog = await this.options.configuration.getConversationAuthoredSkillCatalog(conversationId, actorIdentityId);
    return { workspaceId: catalog.workspaceId, conversationId: catalog.conversationId, channelId: catalog.channelId,
      availability: "not_checked", ...(catalog.agents ? { agents: catalog.agents.map(agent => ({
        identityId: agent.identityId, state: agent.state, supported: agent.supported,
        skills: agent.skills.map(ref => ({ documentId: ref.documentId, source: ref.source, revision: ref.revision, contentHash: ref.contentHash })),
        harness: agent.harness.filter(value => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value)),
      })) } : {}), skills: catalog.skills.map(skill => ({
        documentId: skill.documentId, source: skill.source, revision: skill.revision, contentHash: skill.contentHash,
        name: skill.name, description: skill.description,
      })) };
  }

  async getConversationAuthoredContext(conversationId: string, actorIdentityId: string): Promise<LocalConversationAuthoredContext> {
    if (!this.options.configuration?.getConversationAuthoredContext) {
      throw new LocalConfigurationRequestError("Authored content unavailable", 404, "unavailable");
    }
    return this.options.configuration.getConversationAuthoredContext(conversationId, actorIdentityId);
  }

  async listAuthoredDocuments(workspaceId: string, actorIdentityId: string): Promise<LocalAuthoredDocumentSummary[]> {
    if (!this.options.configuration?.listAuthoredDocuments) {
      throw new LocalConfigurationRequestError("Authored content unavailable", 404, "unavailable");
    }
    return this.options.configuration.listAuthoredDocuments(workspaceId, actorIdentityId);
  }

  async getAuthoredDocument(workspaceId: string, documentId: string, actorIdentityId: string): Promise<LocalAuthoredDocument> {
    if (!this.options.configuration?.getAuthoredDocument) {
      throw new LocalConfigurationRequestError("Authored content unavailable", 404, "unavailable");
    }
    return this.options.configuration.getAuthoredDocument(workspaceId, documentId, actorIdentityId);
  }

  async listAuthoredDocumentRevisions(workspaceId: string, documentId: string, actorIdentityId: string): Promise<LocalAuthoredDocumentRevision[]> {
    if (!this.options.configuration?.listAuthoredDocumentRevisions) {
      throw new LocalConfigurationRequestError("Authored content unavailable", 404, "unavailable");
    }
    return this.options.configuration.listAuthoredDocumentRevisions(workspaceId, documentId, actorIdentityId);
  }

  async createAuthoredDocument(workspaceId: string, actorIdentityId: string, input: unknown): Promise<LocalAuthoredDocument> {
    if (!this.options.configuration?.createAuthoredDocument) {
      throw new LocalConfigurationRequestError("Authored content unavailable", 404, "unavailable");
    }
    return this.options.configuration.createAuthoredDocument(workspaceId, actorIdentityId, input);
  }

  async updateAuthoredDocument(workspaceId: string, documentId: string, actorIdentityId: string, input: unknown): Promise<LocalAuthoredDocument> {
    if (!this.options.configuration?.updateAuthoredDocument) {
      throw new LocalConfigurationRequestError("Authored content unavailable", 404, "unavailable");
    }
    return this.options.configuration.updateAuthoredDocument(workspaceId, documentId, actorIdentityId, input);
  }

  async getWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.getWorkspaceConfiguration(workspaceId, actorIdentityId);
  }

  async getWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceAgentConfiguration> {
    if (!this.options.configuration?.getWorkspaceAgentConfiguration) {
      throw new LocalConfigurationRequestError("Agent configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.getWorkspaceAgentConfiguration(
      workspaceId,
      agentIdentityId,
      actorIdentityId,
    );
  }

  async getWorkspaceRuntimeOptions(
    workspaceId: string,
    runtimeAdapter: string,
    actorIdentityId: string,
  ): Promise<LocalRuntimeOptions> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.getWorkspaceRuntimeOptions(
      workspaceId,
      runtimeAdapter,
      actorIdentityId,
    );
  }

  async getAgentRuntimeOptions(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<LocalAgentRuntimeOptions> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.getAgentRuntimeOptions(
      workspaceId,
      agentIdentityId,
      actorIdentityId,
    );
  }

  async updateAgentRuntimeModelPolicy(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalAgentRuntimeOptions> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Runtime model configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.updateAgentRuntimeModelPolicy(
      workspaceId,
      agentIdentityId,
      actorIdentityId,
      input,
    );
  }

  async updateWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.updateWorkspaceConfiguration(workspaceId, actorIdentityId, input);
  }

  async updateWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.updateWorkspaceAgentConfiguration(
      workspaceId,
      agentIdentityId,
      actorIdentityId,
      input,
    );
  }

  private async withStopAdmissionFence<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const releaseFence = this.options.lifecycle?.fenceConversationAdmission?.(conversationId);
    try {
      // Do not hold the Conversation message gate while stopping: an in-flight Relay
      // response may need that same gate before its drain can settle.
      return await operation();
    } finally {
      releaseFence?.();
    }
  }

  async postConversationMessage(conversationId: string, actorIdentityId: string, input: unknown, idempotencyKey?: string): Promise<ConversationMessage> {
    return this.withConversationSendOrder(conversationId, () => this.postConversationMessageOnce(conversationId, actorIdentityId, input, idempotencyKey));
  }

  // Manual activation snapshots and saved sends must be ordered together.
  // Stop/cancellation deliberately remain outside this queue.
  private async withConversationSendOrder<T>(conversationId: string, execute: () => Promise<T>): Promise<T> {
    const prior = this.conversationSends.get(conversationId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(execute);
    this.conversationSends.set(conversationId, operation);
    try { return await operation; }
    finally { if (this.conversationSends.get(conversationId) === operation) this.conversationSends.delete(conversationId); }
  }

  private async postConversationMessageOnce(conversationId: string, actorIdentityId: string, value: unknown, idempotencyKey?: string): Promise<ConversationMessage> {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || Buffer.byteLength(idempotencyKey, "utf8") > 255) {
      throw new LocalConfigurationRequestError("A valid idempotency key is required", 400, "invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new LocalConfigurationRequestError("A message is required", 400, "invalid");
    }
    const input = value as CreateMessageInput;
    if (input.authoredInvocationId !== undefined) throw new LocalConfigurationRequestError("Skill messages require private publication", 400, "invalid");
    if (input.participantId !== actorIdentityId) throw new LocalConfigurationRequestError("Message author must match the browser session", 403, "forbidden");
    if (typeof input.body !== "string") throw new LocalConfigurationRequestError("Message body must be a string", 400, "invalid");
    const directory = this.options.conversations;
    if (!directory.listMessages || !directory.postMessage) throw new LocalConfigurationRequestError("Conversation sending is unavailable", 404, "unavailable");
    try {
      const conversation = await directory.getConversation(conversationId);
      if (!conversation.participants.some(({ id, type, status }) => id === actorIdentityId && type === "human" && status !== "disabled")) {
        throw new LocalConfigurationRequestError("An active human participant is required", 403, "forbidden");
      }
      let targets = resolveMessageTargets(conversation, input);
      // Browser sends always include the displayed targets (even []). Omitted
      // targets retain human-only API defaults without borrowing anyone else's selection.
      if (input.to === undefined && !targets.length) {
        const messages = await directory.listMessages(conversationId);
        const reply = input.replyTo ? messages.find(({ id }) => id === input.replyTo) : undefined;
        // Keep omitted-target compatibility deterministic for exact retries:
        // later sends must not reinterpret an older request's effective payload.
        const first = messages.find((message) => message.participantId === actorIdentityId);
        const initial = first?.to.length === 1 && first.to[0] !== "@conversation" ? first.to[0] : undefined;
        const fallback = reply?.participantId ?? (first ? initial : threadDefaultRecipient(conversation));
        if (fallback && conversation.participants.some(({ id, status }) => id === fallback && status !== "disabled")) targets = [fallback];
      }
      const message = await directory.postMessage(conversationId, { ...input, to: targets }, { idempotencyKey });
      const agents = message.to.includes("@conversation") ? [] : conversation.participants
        .filter(({ id, type, status }) => message.to.includes(id) && (type === "agent" || type === "service") && status === "active");
      const lifecycle = this.options.lifecycle;
      if (agents.length && lifecycle?.available && lifecycle.autoStartConversationAgent && this.options.configuration) {
        try { await this.options.configuration.getWorkspaceConfiguration(conversation.workspaceId, actorIdentityId); }
        catch (error) {
          if (error instanceof LocalConfigurationRequestError && error.status === 403) return message;
          throw error;
        }
        const results = await Promise.allSettled(agents.map(({ id }) =>
          lifecycle.autoStartConversationAgent!(conversationId, id, actorIdentityId, message.id)));
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
      return message;
    } catch (error) {
      if (error instanceof ConversationClientError || error instanceof ConversationValidationError) {
        const status = error instanceof ConversationValidationError ? 400
          : error.status === 400 ? 400 : error.status === 403 ? 403 : error.status === 404 ? 404 : error.status === 413 ? 413 : 409;
        throw new LocalConfigurationRequestError(error.message, status, status === 403 ? "forbidden" : status === 400 ? "invalid" : "unavailable");
      }
      throw error;
    }
  }

  async startConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
    contextMode: LocalSessionContextMode = "with_context",
  ): Promise<LocalConversationAgent> {
    await this.runLegacyAgentAction(conversationId, actorIdentityId, contextMode === "fresh" ? "start-fresh" : "start", identityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async replaceConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
    contextMode: LocalSessionContextMode = "with_context",
  ): Promise<LocalConversationAgent> {
    await this.runLegacyAgentAction(conversationId, actorIdentityId, contextMode === "fresh" ? "replace-fresh" : "replace", identityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async stopConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    await this.runLegacyAgentAction(conversationId, actorIdentityId, "stop", identityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async reconnectConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    await this.runLegacyAgentAction(conversationId, actorIdentityId, "reconnect", identityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async startAllConversationAgents(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResponse> {
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      conversationId,
      results: await this.runLegacyAgentAction(conversationId, actorIdentityId, "start-all") ?? [],
    };
  }

  async stopAllConversationAgents(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResponse> {
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      conversationId,
      results: await this.runLegacyAgentAction(conversationId, actorIdentityId, "stop-all") ?? [],
    };
  }

  async cancelCurrentConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    await this.runLegacyAgentAction(conversationId, actorIdentityId, "cancel", identityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async listConversationTurnFailures(
    conversationId: string,
    actorIdentityId: string,
    limit: number,
  ): Promise<LocalConversationTurnFailuresResponse> {
    if (!this.options.lifecycle?.listConversationTurnFailures) {
      throw new LocalConfigurationRequestError("Not found", 404, "unavailable");
    }
    return this.options.lifecycle.listConversationTurnFailures(conversationId, actorIdentityId, limit);
  }

  async agentSessionInspection(conversationId: string, identityId: string, actorIdentityId: string) {
    if (!this.options.sessionInspections) throw new LocalConfigurationRequestError("Not found", 404, "unavailable");
    return this.options.sessionInspections.read(conversationId, identityId, actorIdentityId);
  }

  async agentDeliveryTrails(conversationId: string, identityId: string, actorIdentityId: string, options: { cursor?: string; trailId?: string; signal?: AbortSignal }) {
    if (!this.options.deliveryReads) throw new LocalConfigurationRequestError("Not found", 404, "unavailable");
    return this.options.deliveryReads.read(conversationId, identityId, actorIdentityId, options);
  }

  async agentSessionEvents(conversationId: string, identityId: string, actorIdentityId: string, signal?: AbortSignal) {
    if (!this.options.sessionInspections) throw new LocalConfigurationRequestError("Not found", 404, "unavailable");
    return this.options.sessionInspections.events(conversationId, identityId, actorIdentityId, { signal });
  }

  async agentOperationHistory(conversationId: string, identityId: string, actorIdentityId: string, cursor?: string): Promise<LocalAgentOperationHistory> {
    if (!this.options.diagnosticReads) throw new LocalConfigurationRequestError("Not found", 404, "unavailable");
    return this.options.diagnosticReads.history(conversationId, identityId, actorIdentityId, cursor);
  }

  async agentOperationDetail(conversationId: string, identityId: string, actorIdentityId: string, operationId: string): Promise<LocalAgentOperationDetail> {
    if (!this.options.diagnosticReads) throw new LocalConfigurationRequestError("Not found", 404, "unavailable");
    return this.options.diagnosticReads.detail(conversationId, identityId, actorIdentityId, operationId);
  }

  async agentDiagnosticReport(conversationId: string, identityId: string, actorIdentityId: string, operationId: string): Promise<LocalAgentDiagnosticReport> {
    if (!this.options.diagnosticReads) throw new LocalConfigurationRequestError("Not found", 404, "unavailable");
    return this.options.diagnosticReads.report(conversationId, identityId, actorIdentityId, operationId,
      async () => {
        const [conversation, records] = await Promise.all([
          this.options.conversations.getConversation(conversationId),
          this.options.bindings.listConversationBindings(conversationId),
        ]);
        const participant = conversation.participants.find(({ id, type }) => id === identityId && (type === "agent" || type === "service"));
        return participant ? this.presentAgent(conversation, identityId, participant.status, records) : undefined;
      });
  }

  private async authorizeAgentActions(conversationId: string, actorIdentityId: string) {
    const conversation = await this.options.conversations.getConversation(conversationId);
    if (!this.options.configuration) throw new LocalConfigurationRequestError("Participant actions unavailable", 404, "unavailable");
    // Fresh workspace/identity authorization on acceptance and every receipt read.
    await this.options.configuration.getWorkspaceConfiguration(conversation.workspaceId, actorIdentityId);
    return conversation;
  }

  async submitAgentAction(conversationId: string, actorIdentityId: string, value: unknown): Promise<LocalAgentActionReceipt> {
    const input = agentActionInput(value);
    const conversation = await this.authorizeAgentActions(conversationId, actorIdentityId);
    if (input.identityId && !conversation.participants.some(({ id, type, status }) => id === input.identityId && (type === "agent" || type === "service") && status !== "disabled")) {
      throw new LocalConfigurationRequestError("Active Conversation participant required", 409, "unavailable");
    }
    this.agentActions.start(conversationId, actorIdentityId, input, () => this.executeAgentAction(conversationId, actorIdentityId, input));
    return this.agentActions.read(conversationId, input.requestId)!;
  }

  async readAgentAction(conversationId: string, actorIdentityId: string, requestId: string): Promise<LocalAgentActionReceipt> {
    await this.authorizeAgentActions(conversationId, actorIdentityId);
    const receipt = this.agentActions.read(conversationId, requestId);
    if (!receipt) throw new LocalConfigurationRequestError("Participant action outcome unavailable", 404, "unavailable");
    return receipt;
  }

  async pendingAgentActions(conversationId: string, actorIdentityId: string): Promise<LocalAgentActionReceipt[]> {
    await this.authorizeAgentActions(conversationId, actorIdentityId);
    return this.agentActions.pending(conversationId);
  }

  private runLegacyAgentAction(conversationId: string, actorIdentityId: string, action: LocalAgentActionInput["action"], identityId?: string) {
    const input = { requestId: randomUUID(), action, ...(identityId ? { identityId } : {}) };
    return this.agentActions.start(conversationId, actorIdentityId, input, () => this.executeAgentAction(conversationId, actorIdentityId, input)).completion;
  }

  private async executeAgentAction(conversationId: string, actorIdentityId: string, input: LocalAgentActionInput): Promise<LocalBulkAgentLifecycleResult[] | undefined> {
    const lifecycle = this.options.lifecycle;
    if (!lifecycle?.available) throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    const id = input.identityId!;
    switch (input.action) {
      case "start": case "start-fresh":
        await this.withConversationSendOrder(conversationId, () => lifecycle.startConversationAgent(conversationId, id, actorIdentityId,
          input.action === "start-fresh" ? "fresh" : "with_context")); break;
      case "replace": case "replace-fresh":
        await this.withConversationSendOrder(conversationId, () => lifecycle.replaceConversationAgent(conversationId, id, actorIdentityId,
          input.action === "replace-fresh" ? "fresh" : "with_context")); break;
      case "stop":
        // Shared request admission and the host binding fence isolate this target;
        // a Conversation-wide fence would also reject unrelated participants.
        await lifecycle.stopConversationAgent(conversationId, id, actorIdentityId); break;
      case "stop-runtime": case "restart-runtime":
        if (!lifecycle.recoverConversationAgent) throw new LocalConfigurationRequestError("Runtime recovery unavailable", 404, "unavailable");
        await lifecycle.recoverConversationAgent(conversationId, id, actorIdentityId, input.action === "restart-runtime"); break;
      case "cancel": await lifecycle.cancelCurrentConversationAgent(conversationId, id, actorIdentityId); break;
      case "reconnect":
        if (!lifecycle.reconnectConversationAgent) throw new LocalConfigurationRequestError("Agent reconnect unavailable", 404, "unavailable");
        await lifecycle.reconnectConversationAgent(conversationId, id, actorIdentityId); break;
      case "start-all":
        if (!lifecycle.startAllConversationAgents) throw new LocalConfigurationRequestError("Bulk agent lifecycle unavailable", 404, "unavailable");
        return this.withConversationSendOrder(conversationId, () => lifecycle.startAllConversationAgents!(conversationId, actorIdentityId));
      case "stop-all":
        if (!lifecycle.stopAllConversationAgents) throw new LocalConfigurationRequestError("Bulk agent lifecycle unavailable", 404, "unavailable");
        return this.withStopAdmissionFence(conversationId, () => lifecycle.stopAllConversationAgents!(conversationId, actorIdentityId));
    }
    return undefined;
  }

  async conversationAgent(conversationId: string, identityId: string): Promise<LocalConversationAgent> {
    const [conversation, records] = await Promise.all([
      this.options.conversations.getConversation(conversationId), this.options.bindings.listConversationBindings(conversationId),
    ]);
    const participant = conversation.participants.find(({ id, type }) => id === identityId && (type === "agent" || type === "service"));
    if (!participant) throw new LocalConfigurationRequestError("Conversation agent unavailable", 404, "unavailable");
    return this.presentAgent(conversation, identityId, participant.status, records);
  }

  async listConversationAgents(conversationId: string): Promise<LocalConversationAgentsResponse> {
    const [conversation, records] = await Promise.all([
      this.options.conversations.getConversation(conversationId),
      this.options.bindings.listConversationBindings(conversationId),
    ]);
    const agents = await Promise.all(conversation.participants
      .filter(({ type }) => type === "agent" || type === "service")
      .map((participant) => this.presentAgent(conversation, participant.id, participant.status, records)));
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      conversationId: conversation.id,
      agents,
    };
  }

  private async presentAgent(
    conversation: ConversationMetadata,
    identityId: string,
    membershipStatus: "active" | "disabled" | undefined,
    records: LocalControlBindingRecord[],
  ): Promise<LocalConversationAgent> {
    const agent = await this.presentAgentStatus(conversation, identityId, membershipStatus, records);
    const matches = records.filter(record => record.agentIdentityId === identityId);
    const target = matches.length === 1 ? matches[0] : undefined;
    if (membershipStatus !== "disabled" && agent.state !== "starting" && target?.state !== "disabled"
      && target?.runtimeOwnerId && this.options.lifecycle?.available && this.options.lifecycle.recoverConversationAgent
      && this.options.runtimes[target.runtimeAdapter]?.forceStopManaged) {
      return { ...agent, capabilities: { ...agent.capabilities, recover: true } };
    }
    return agent;
  }

  private async presentAgentStatus(
    conversation: ConversationMetadata,
    identityId: string,
    membershipStatus: "active" | "disabled" | undefined,
    records: LocalControlBindingRecord[],
  ): Promise<LocalConversationAgent> {
    const matches = records.filter(({ agentIdentityId }) => agentIdentityId === identityId);
    const base = { workspaceId: conversation.workspaceId, conversationId: conversation.id, identityId };
    if (membershipStatus === "disabled") {
      return { ...base, state: "disabled", capabilities: disabledCapabilities };
    }
    if (this.options.lifecycle?.isStarting?.(conversation.id, identityId)) {
      return { ...base, state: "starting", capabilities: disabledCapabilities };
    }
    if (matches.length === 0) {
      return {
        ...base,
        state: "unbound",
        capabilities: {
          ...disabledCapabilities,
          start: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    if (matches.length > 1) {
      return { ...base, state: "uncertain", capabilities: disabledCapabilities };
    }
    const binding = matches[0]!;
    const details = { wakePolicy: binding.wakePolicy, lastVerifiedAt: binding.lastVerifiedAt };
    if (binding.state === "stopping") {
      return {
        ...base,
        ...details,
        state: "uncertain",
        capabilities: {
          ...disabledCapabilities,
          stop: Boolean(this.options.lifecycle?.available),
          replace: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    if (binding.state === "paused") {
      return {
        ...base,
        ...details,
        state: "stopped",
        capabilities: {
          ...disabledCapabilities,
          start: Boolean(this.options.lifecycle?.available),
          replace: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    if (binding.state === "disabled") {
      return {
        ...base,
        ...details,
        state: "disabled",
        capabilities: {
          ...disabledCapabilities,
          replace: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    if (binding.state === "replacing" || binding.state === "waking") {
      return { ...base, ...details, state: "uncertain", capabilities: disabledCapabilities };
    }
    if (binding.state === "sleeping") {
      if (this.options.lifecycle?.isAttached?.(conversation.id, identityId) !== true) {
        return { ...base, ...details, state: "uncertain", capabilities: disabledCapabilities };
      }
      const work = this.options.lifecycle.agentWorkSnapshot?.(conversation.id, identityId);
      if (!work || work.activeTurns !== 0 || work.queuedTurns !== 0 || !work.queuedTurnsExact) {
        return {
          ...base,
          ...details,
          state: "uncertain",
          diagnostics: {
            connection: "connected",
            queuedTurns: work?.queuedTurns ?? 0,
            queuedTurnsExact: work?.queuedTurnsExact ?? false,
            lastVerifiedAt: binding.lastVerifiedAt,
            capabilities: notVerifiedLiveCapabilities,
          },
          capabilities: disabledCapabilities,
        };
      }
      return {
        ...base,
        ...details,
        state: "idle",
        diagnostics: {
          connection: "connected",
          queuedTurns: 0,
          queuedTurnsExact: true,
          lastVerifiedAt: binding.lastVerifiedAt,
          capabilities: notVerifiedLiveCapabilities,
        },
        capabilities: {
          ...disabledCapabilities,
          stop: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    const runtime = this.options.runtimes[binding.runtimeAdapter];
    if (!runtime) {
      return {
        ...base,
        ...details,
        state: "offline",
        diagnostics: {
          connection: "offline",
          queuedTurns: 0,
          queuedTurnsExact: true,
          lastVerifiedAt: binding.lastVerifiedAt,
          capabilities: unavailableLiveCapabilities,
        },
        capabilities: {
          ...disabledCapabilities,
          replace: Boolean(this.options.lifecycle?.available),
          stop: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    const work = this.options.lifecycle?.agentWorkSnapshot?.(conversation.id, identityId);
    const activity = this.options.lifecycle?.activity?.(conversation.id, identityId);
    const attached = this.options.lifecycle?.isAttached?.(conversation.id, identityId);
    if (work?.stopRequested) {
      return {
        ...base,
        ...details,
        state: "uncertain",
        diagnostics: {
          connection: "connected",
          queuedTurns: work.queuedTurns,
          queuedTurnsExact: work.queuedTurnsExact,
          lastVerifiedAt: binding.lastVerifiedAt,
          capabilities: notVerifiedLiveCapabilities,
        },
        capabilities: disabledCapabilities,
      };
    }
    if (activity) {
      const liveCapabilities = await this.readRuntimeCapabilities(runtime, binding.runtimeSessionId);
      const diagnosticCapabilities = presentLiveCapabilities(liveCapabilities);
      const safeActivity = {
        phase: activity.phase,
        triggerMessageId: activity.triggerMessageId,
        triggerSequence: activity.triggerSequence,
        startedAt: activity.startedAt,
        queuedTurns: activity.queuedTurns,
        queuedTurnsExact: activity.queuedTurnsExact,
        ...(activity.phase === "retrying" && activity.retryAttempt !== undefined
          ? { retryAttempt: activity.retryAttempt }
          : {}),
      };
      return {
        ...base,
        ...details,
        state: "running",
        activity: safeActivity,
        diagnostics: {
          connection: "connected",
          phase: safeActivity.phase,
          startedAt: safeActivity.startedAt,
          queuedTurns: safeActivity.queuedTurns,
          queuedTurnsExact: safeActivity.queuedTurnsExact,
          lastVerifiedAt: binding.lastVerifiedAt,
          capabilities: diagnosticCapabilities,
        },
        capabilities: {
          ...disabledCapabilities,
          stop: Boolean(this.options.lifecycle?.available),
          interrupt: Boolean(
            this.options.lifecycle?.available
            && runtime.interrupt
            && liveCapabilities?.interrupt === true
            && activity.phase !== "canceling",
          ),
        },
      };
    }
    try {
      const [status, liveCapabilities] = await Promise.all([
        this.readRuntimeStatus(runtime, binding.runtimeSessionId),
        this.readRuntimeCapabilities(runtime, binding.runtimeSessionId),
      ]);
      const diagnosticCapabilities = presentLiveCapabilities(liveCapabilities);
      if (attached === false && status !== "offline") {
        return {
          ...base,
          ...details,
          state: "disconnected",
          diagnostics: {
            connection: "disconnected",
            queuedTurns: 0,
            queuedTurnsExact: true,
            lastVerifiedAt: binding.lastVerifiedAt,
            capabilities: diagnosticCapabilities,
          },
          capabilities: {
            ...disabledCapabilities,
            reconnect: Boolean(
              this.options.lifecycle?.available
              && this.options.lifecycle.reconnectConversationAgent
              && liveCapabilities?.reconnectExisting === true
            ),
            replace: false,
            stop: Boolean(this.options.lifecycle?.available),
          },
        };
      }
      if (status === "working") {
        return {
          ...base,
          ...details,
          state: "running",
          diagnostics: {
            connection: "connected",
            queuedTurns: 0,
            queuedTurnsExact: true,
            lastVerifiedAt: binding.lastVerifiedAt,
            capabilities: diagnosticCapabilities,
          },
          capabilities: {
            ...disabledCapabilities,
            stop: Boolean(this.options.lifecycle?.available),
          },
        };
      }
      if (status === "idle" && attached === true) {
        if (!work || work.activeTurns !== 0 || work.queuedTurns !== 0 || !work.queuedTurnsExact) {
          return {
            ...base,
            ...details,
            state: "uncertain",
            diagnostics: {
              connection: "connected",
              queuedTurns: work?.queuedTurns ?? 0,
              queuedTurnsExact: work?.queuedTurnsExact ?? false,
              lastVerifiedAt: binding.lastVerifiedAt,
              capabilities: diagnosticCapabilities,
            },
            capabilities: disabledCapabilities,
          };
        }
      }
      return {
        ...base,
        ...details,
        state: status === "idle" ? "idle" : "offline",
        diagnostics: {
          connection: status === "idle" ? "connected" : "offline",
          queuedTurns: 0,
          queuedTurnsExact: true,
          lastVerifiedAt: binding.lastVerifiedAt,
          capabilities: status === "offline"
            ? unavailableLiveCapabilities
            : diagnosticCapabilities,
        },
        capabilities: {
          ...disabledCapabilities,
          replace: Boolean(this.options.lifecycle?.available),
          stop: Boolean(this.options.lifecycle?.available),
        },
      };
    } catch {
      return {
        ...base,
        ...details,
        state: "uncertain",
        diagnostics: {
          connection: "uncertain",
          queuedTurns: 0,
          queuedTurnsExact: true,
          lastVerifiedAt: binding.lastVerifiedAt,
          capabilities: notVerifiedLiveCapabilities,
        },
        capabilities: {
          ...disabledCapabilities,
          stop: Boolean(this.options.lifecycle?.available),
        },
      };
    }
  }

  private async readRuntimeCapabilities(
    runtime: LocalControlRuntimePort,
    sessionId: string,
  ): Promise<LocalControlRuntimeSessionCapabilities | undefined> {
    if (!runtime.sessionCapabilities) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        runtime.sessionCapabilities(sessionId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Runtime capability query timed out")),
            this.statusTimeoutMs,
          );
        }),
      ]);
      const fields = [
        "safeActivityEvents",
        "interrupt",
        "reconnectExisting",
        "interactiveAttach",
        "openDiagnostic",
        "liveSkillVerification",
      ] as const;
      if (value?.version !== 1 || fields.some((field) => typeof value[field] !== "boolean")) {
        return undefined;
      }
      return {
        version: 1,
        safeActivityEvents: value.safeActivityEvents,
        interrupt: value.interrupt,
        reconnectExisting: value.reconnectExisting,
        interactiveAttach: value.interactiveAttach,
        openDiagnostic: value.openDiagnostic,
        liveSkillVerification: value.liveSkillVerification,
      };
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async readRuntimeStatus(
    runtime: LocalControlRuntimePort,
    sessionId: string,
  ): Promise<"idle" | "working" | "offline"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runtime.status(sessionId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Runtime status timed out")), this.statusTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface LocalControlHttpServerOptions {
  service: LocalControlService;
  host?: "127.0.0.1" | "::1";
  port?: number;
  allowedOrigins?: readonly string[];
  /** Required by the real daemon; optional for isolated read-only fixtures. */
  browserSessions?: LocalControlBrowserSessions;
  selectLocalFolder?: () => Promise<string | undefined>;
}

export interface LocalControlHttpServer {
  endpoint: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown, origin?: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
  }
  response.end(JSON.stringify(body));
}

async function readSessionContextMode(request: IncomingMessage): Promise<LocalSessionContextMode | undefined> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (!request.headers["transfer-encoding"] && contentLength === 0) return undefined;
  const input = await readJson(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalConfigurationRequestError("Session context mode is invalid", 400, "invalid");
  }
  const contextMode = (input as { contextMode?: unknown }).contextMode;
  if (contextMode === undefined) return undefined;
  if (contextMode === "with_context" || contextMode === "fresh") return contextMode;
  throw new LocalConfigurationRequestError("Session context mode is invalid", 400, "invalid");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new LocalConfigurationRequestError("Content-Type must be application/json", 400, "invalid");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) {
      throw new LocalConfigurationRequestError("Configuration request is too large", 413, "invalid");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new LocalConfigurationRequestError("Invalid JSON", 400, "invalid");
  }
}

function requestHostname(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function isAllowedHost(hostname: string | undefined): boolean {
  return isLocalConversationsHostname(hostname);
}

export async function createLocalControlHttpServer(
  options: LocalControlHttpServerOptions,
): Promise<LocalControlHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const server = createServer((request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!isAllowedHost(requestHostname(request))) {
      json(response, 403, { error: "Forbidden host" });
      return;
    }
    if (origin && !allowedOrigins.has(origin)) {
      json(response, 403, { error: "Forbidden origin" });
      return;
    }
    const requestPath = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    const catalogMatch = requestPath.match(/^\/local\/conversations\/([^/]+)\/authored-skill-catalog$/);
    if (catalogMatch) {
      response.setHeader("cache-control", "no-store");
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        json(response, 405, { error: "Method not allowed" }, origin);
        return;
      }
    }
    const publicationMatch = requestPath.match(/^\/local\/conversations\/([^/]+)\/skill-invocation-publications$/);
    if (publicationMatch && request.method !== "GET" && !(request.method === "POST" && options.service.authoredSkillPublicationEnabled)) {
      response.setHeader("allow", options.service.authoredSkillPublicationEnabled ? "GET, POST" : "GET");
      json(response, 405, { error: "Method not allowed" }, origin);
      return;
    }
    const isAllowedPost = request.method === "POST" && (
      /^\/local\/conversations\/[^/]+\/agents\/[^/]+\/(start|reconnect|replace|stop|cancel-current)$/.test(requestPath)
      || /^\/local\/conversations\/[^/]+\/agents\/(start-all|stop-all)$/.test(requestPath)
      || /^\/local\/conversations\/[^/]+\/agent-actions$/.test(requestPath)
      || /^\/local\/conversations\/[^/]+\/skill-invocations$/.test(requestPath)
      || (publicationMatch !== null && options.service.authoredSkillPublicationEnabled)
      || /^\/local\/conversations\/[^/]+\/messages$/.test(requestPath)
      || requestPath === "/local/folders/select"
      || requestPath === "/local/workspaces"
      || /^\/local\/workspaces\/[^/]+\/conversations$/.test(requestPath)
      || /^\/local\/workspaces\/[^/]+\/authored-documents$/.test(requestPath)
      || /^\/local\/conversations\/[^/]+\/working-folders\/preview$/.test(requestPath)
    );
    const isAllowedDelete = request.method === "DELETE"
      && /^\/local\/workspaces\/[^/]+\/conversation-presets\/[^/]+$/.test(requestPath);
    if (request.method !== "GET" && request.method !== "PATCH" && request.method !== "PUT" && !isAllowedPost && !isAllowedDelete) {
      response.setHeader("allow", "GET, PATCH, PUT, POST, DELETE");
      json(response, 405, { error: "Method not allowed" }, origin);
      return;
    }

    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const path = url.pathname;
      if (path === "/local/session/bootstrap" && options.browserSessions) {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          json(response, 405, { error: "Method not allowed" }, origin);
          return;
        }
        const exchange = options.browserSessions.exchangeLaunchCode(url.searchParams.get("code") ?? undefined);
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        if (!exchange) {
          json(response, 401, { error: "Invalid or expired launch code" }, origin);
          return;
        }
        response.statusCode = 303;
        response.setHeader("set-cookie", exchange.cookie);
        response.setHeader("location", exchange.redirectUrl);
        response.end();
        return;
      }
      const browserSession: LocalControlBrowserSession | undefined =
        options.browserSessions?.authenticate(request.headers.cookie);
      if (options.browserSessions && !browserSession) {
        json(response, 401, { error: "Local browser session required" }, origin);
        return;
      }
      if (browserSession?.renewalCookie) response.setHeader("set-cookie", browserSession.renewalCookie);
      if (path === "/local/session" && request.method === "GET") {
        if (!browserSession) {
          json(response, 404, { error: "Browser session binding unavailable" }, origin);
          return;
        }
        json(response, 200, {
          protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
          identityId: browserSession.identityId,
        }, origin);
        return;
      }
      if (path === "/local/health" && request.method === "GET") {
        json(response, 200, options.service.health(), origin);
        return;
      }
      if (path === "/local/capabilities" && request.method === "GET") {
        json(response, 200, options.service.capabilities(), origin);
        return;
      }
      const threadSendMatch = path.match(/^\/local\/conversations\/([^/]+)\/messages$/);
      if (threadSendMatch && request.method === "POST" && browserSession) {
        const message = await options.service.postConversationMessage(decodeURIComponent(threadSendMatch[1]!), browserSession.identityId,
          await readJson(request), typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined);
        const fresh = options.browserSessions?.authenticate(request.headers.cookie);
        if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== browserSession.identityId) {
          json(response, 401, { error: "Local browser session required" }, origin);
          return;
        }
        json(response, 201, { message }, origin);
        return;
      }
      const actionMatch = path.match(/^\/local\/conversations\/([^/]+)\/agent-actions(?:\/([^/]+))?$/);
      if (actionMatch && browserSession && (request.method === "GET" || (request.method === "POST" && !actionMatch[2]))) {
        const conversationId = decodeURIComponent(actionMatch[1]!);
        const value = request.method === "POST"
          ? await options.service.submitAgentAction(conversationId, browserSession.identityId, await readJson(request))
          : actionMatch[2]
            ? await options.service.readAgentAction(conversationId, browserSession.identityId, decodeURIComponent(actionMatch[2]))
            : { actions: await options.service.pendingAgentActions(conversationId, browserSession.identityId) };
        const fresh = options.browserSessions?.authenticate(request.headers.cookie);
        if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== browserSession.identityId) {
          json(response, 401, { error: "Local browser session required" }, origin);
          return;
        }
        json(response, request.method === "POST" ? 202 : 200, value, origin);
        return;
      }
      const agentStatusMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)$/);
      if (agentStatusMatch && request.method === "GET") {
        json(response, 200, { agent: await options.service.conversationAgent(decodeURIComponent(agentStatusMatch[1]!), decodeURIComponent(agentStatusMatch[2]!)) }, origin);
        return;
      }
      const diagnosticMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)\/(operations(?:\/([^/]+))?|diagnostic-report|session-inspection|session-events|delivery-trails)$/);
      if (diagnosticMatch && request.method === "GET" && browserSession) {
        const conversationId = decodeURIComponent(diagnosticMatch[1]!);
        const identityId = decodeURIComponent(diagnosticMatch[2]!);
        const operationId = diagnosticMatch[4] ? decodeURIComponent(diagnosticMatch[4]) : undefined;
        const events = diagnosticMatch[3] === "session-events";
        const trails = diagnosticMatch[3] === "delivery-trails";
        if (trails && [...url.searchParams.keys()].some(key => !["cursor", "trailId"].includes(key) || url.searchParams.getAll(key).length !== 1)) {
          throw new LocalConfigurationRequestError("Invalid trail query", 400, "invalid");
        }
        if (events && url.search) throw new LocalConfigurationRequestError("Invalid event query", 400, "invalid");
        const controller = new AbortController();
        const disconnected = () => controller.abort();
        if (events || trails) response.once("close", disconnected);
        let value;
        try {
          value = trails
            ? await options.service.agentDeliveryTrails(conversationId, identityId, browserSession.identityId, { signal: controller.signal,
              cursor: url.searchParams.get("cursor") ?? undefined, trailId: url.searchParams.get("trailId") ?? undefined })
            : events
            ? await options.service.agentSessionEvents(conversationId, identityId, browserSession.identityId, controller.signal)
            : diagnosticMatch[3] === "session-inspection"
            ? await options.service.agentSessionInspection(conversationId, identityId, browserSession.identityId)
            : diagnosticMatch[3] === "diagnostic-report"
            ? await options.service.agentDiagnosticReport(conversationId, identityId, browserSession.identityId, url.searchParams.get("operationId") ?? "")
            : operationId
              ? await options.service.agentOperationDetail(conversationId, identityId, browserSession.identityId, operationId)
              : await options.service.agentOperationHistory(conversationId, identityId, browserSession.identityId, url.searchParams.get("cursor") ?? undefined);
        } finally { response.off("close", disconnected); }
        if (response.destroyed) return;
        // Do not release a privileged response after the authenticating session expired/rebound during I/O.
        const fresh = options.browserSessions?.authenticate(request.headers.cookie);
        if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== browserSession.identityId) {
          json(response, 401, { error: "Local browser session required" }, origin);
          return;
        }
        json(response, 200, value, origin);
        return;
      }
      const turnFailuresMatch = path.match(/^\/local\/conversations\/([^/]+)\/turn-failures$/);
      if (turnFailuresMatch && browserSession && request.method === "GET") {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 20 : /^[1-9]\d*$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          json(response, 400, { error: "limit must be an integer from 1 through 100" }, origin);
          return;
        }
        json(response, 200, await options.service.listConversationTurnFailures(
          decodeURIComponent(turnFailuresMatch[1]!),
          browserSession.identityId,
          limit,
        ), origin);
        return;
      }
      const conversationLifecycleMatch = path.match(/^\/local\/conversations\/([^/]+)\/lifecycle$/);
      if (conversationLifecycleMatch && request.method === "GET" && browserSession) {
        json(response, 200, {
          lifecycle: await options.service.getConversationLifecycle(decodeURIComponent(conversationLifecycleMatch[1]!)),
        }, origin);
        return;
      }
      if (conversationLifecycleMatch && request.method === "PATCH" && browserSession) {
        json(response, 200, {
          lifecycle: await options.service.updateConversationLifecycle(
            decodeURIComponent(conversationLifecycleMatch[1]!),
            browserSession.identityId,
            (await readJson(request)) as Omit<UpdateConversationLifecycleInput, "actorIdentityId">,
          ),
        }, origin);
        return;
      }
      if (path === "/local/folders/select" && request.method === "POST" && browserSession) {
        const selectedPath = await (options.selectLocalFolder ?? chooseLocalFolder)();
        if (selectedPath === undefined) {
          response.statusCode = 204;
          if (origin) response.setHeader("access-control-allow-origin", origin);
          response.setHeader("access-control-allow-credentials", "true");
          response.end();
        } else {
          json(response, 200, { path: selectedPath }, origin);
        }
        return;
      }
      if (path === "/local/workspaces" && request.method === "POST" && browserSession) {
        json(response, 201, await options.service.provisionWorkspace(
          browserSession.identityId,
          await readJson(request),
        ), origin);
        return;
      }
      const presetsMatch = path.match(/^\/local\/workspaces\/([^/]+)\/conversation-presets(?:\/([^/]+))?$/);
      if (presetsMatch && browserSession) {
        const workspaceId = decodeURIComponent(presetsMatch[1]!);
        const presetId = presetsMatch[2] && decodeURIComponent(presetsMatch[2]);
        if (!presetId && request.method === "GET") {
          json(response, 200, await options.service.listConversationPresets(workspaceId, browserSession.identityId), origin);
          return;
        }
        if (presetId && request.method === "PUT") {
          json(response, 200, await options.service.saveConversationPreset(workspaceId, presetId, browserSession.identityId, await readJson(request)), origin);
          return;
        }
        if (presetId && request.method === "DELETE") {
          await options.service.deleteConversationPreset(workspaceId, presetId, browserSession.identityId, await readJson(request));
          json(response, 200, { deleted: true }, origin);
          return;
        }
      }
      const createWithSetupMatch = path.match(/^\/local\/workspaces\/([^/]+)\/conversations$/);
      if (createWithSetupMatch && browserSession && request.method === "POST") {
        json(response, 201, { conversation: await options.service.createConversationWithSetup(
          decodeURIComponent(createWithSetupMatch[1]!), browserSession.identityId, await readJson(request),
        ) }, origin);
        return;
      }
      const conversationSettingsMatch = path.match(/^\/local\/conversations\/([^/]+)\/settings$/);
      if (conversationSettingsMatch && browserSession && (request.method === "GET" || request.method === "PUT")) {
        const id = decodeURIComponent(conversationSettingsMatch[1]!);
        json(response, 200, request.method === "GET"
          ? await options.service.getConversationSettings(id, browserSession.identityId)
          : await options.service.updateConversationSettings(id, browserSession.identityId, await readJson(request)), origin);
        return;
      }
      const creationSetupMatch = path.match(/^\/local\/conversations\/([^/]+)\/creation-setup$/);
      if (creationSetupMatch && browserSession && request.method === "GET") {
        json(response, 200, await options.service.getConversationCreationSetup(decodeURIComponent(creationSetupMatch[1]!), browserSession.identityId), origin);
        return;
      }
      if (publicationMatch && browserSession) {
        let conversationId: string;
        try { conversationId = decodeURIComponent(publicationMatch[1]!); }
        catch { throw new LocalConfigurationRequestError("Invalid Conversation", 400, "invalid"); }
        const assertSession = () => {
          const fresh = options.browserSessions?.authenticate(request.headers.cookie);
          if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== browserSession.identityId) {
            throw new LocalConfigurationRequestError("Local browser session required", 401, "forbidden");
          }
        };
        let receipt: LocalAuthoredSkillInvocationPublicationReceipt;
        if (request.method === "POST") {
          if (url.searchParams.has("requestId")) throw new LocalConfigurationRequestError("Publication selection must be in the request body", 400, "invalid");
          receipt = await options.service.publishAuthoredSkillInvocation(conversationId, browserSession.identityId, await readJson(request), assertSession);
        } else {
          const keys = url.searchParams.getAll("requestId");
          if (keys.length !== 1) throw new LocalConfigurationRequestError("One requestId is required", 400, "invalid");
          receipt = await options.service.getAuthoredSkillInvocationPublication(conversationId, browserSession.identityId, keys[0]!);
        }
        assertSession();
        response.setHeader("cache-control", "no-store");
        json(response, 200, receipt, origin);
        return;
      }
      const invocationMatch = path.match(/^\/local\/conversations\/([^/]+)\/skill-invocations(?:\/([^/]+))?$/);
      if (invocationMatch && browserSession) {
        const conversationId = decodeURIComponent(invocationMatch[1]!);
        const requestId = invocationMatch[2] ? decodeURIComponent(invocationMatch[2]) : undefined;
        if ((requestId && request.method !== "GET") || (!requestId && request.method !== "POST")) {
          response.setHeader("allow", requestId ? "GET" : "POST");
          json(response, 405, { error: "Method not allowed" }, origin);
          return;
        }
        const receipt = requestId
          ? await options.service.getAuthoredSkillInvocation(conversationId, browserSession.identityId, requestId)
          : await options.service.acceptAuthoredSkillInvocation(conversationId, browserSession.identityId,
            typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "", await readJson(request));
        const fresh = options.browserSessions?.authenticate(request.headers.cookie);
        if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== browserSession.identityId) {
          json(response, 401, { error: "Local browser session required" }, origin);
          return;
        }
        response.setHeader("cache-control", "no-store");
        json(response, requestId ? 200 : 202, receipt, origin);
        return;
      }
      if (catalogMatch && browserSession) {
        if (url.search) throw new LocalConfigurationRequestError("Skill catalog does not accept query parameters", 400, "invalid");
        let conversationId: string;
        try { conversationId = decodeURIComponent(catalogMatch[1]!); }
        catch { throw new LocalConfigurationRequestError("Invalid Conversation", 400, "invalid"); }
        const result = await options.service.getConversationAuthoredSkillCatalog(conversationId, browserSession.identityId);
        const fresh = options.browserSessions?.authenticate(request.headers.cookie);
        if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== browserSession.identityId) {
          json(response, 401, { error: "Local browser session required" }, origin);
          return;
        }
        json(response, 200, result, origin);
        return;
      }
      const authoredContextMatch = path.match(/^\/local\/conversations\/([^/]+)\/authored-context$/);
      if (authoredContextMatch && browserSession && request.method === "GET") {
        const result = await options.service.getConversationAuthoredContext(decodeURIComponent(authoredContextMatch[1]!), browserSession.identityId);
        const fresh = options.browserSessions?.authenticate(request.headers.cookie);
        if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== browserSession.identityId) {
          json(response, 401, { error: "Local browser session required" }, origin);
          return;
        }
        response.setHeader("cache-control", "no-store");
        json(response, 200, result, origin);
        return;
      }
      const authoredDocumentsMatch = path.match(/^\/local\/workspaces\/([^/]+)\/authored-documents(?:\/([^/]+)(\/revisions)?)?$/);
      if (authoredDocumentsMatch && browserSession) {
        const workspaceId = decodeURIComponent(authoredDocumentsMatch[1]!);
        const documentId = authoredDocumentsMatch[2] ? decodeURIComponent(authoredDocumentsMatch[2]) : undefined;
        const history = Boolean(authoredDocumentsMatch[3]);
        const allowed = history ? ["GET"] : documentId ? ["GET", "PATCH"] : ["GET", "POST"];
        if (!allowed.includes(request.method ?? "")) {
          response.setHeader("allow", allowed.join(", "));
          json(response, 405, { error: "Method not allowed" }, origin);
          return;
        }
        const actorIdentityId = browserSession.identityId;
        const result = documentId
          ? history
            ? await options.service.listAuthoredDocumentRevisions(workspaceId, documentId, actorIdentityId)
            : request.method === "PATCH"
              ? await options.service.updateAuthoredDocument(workspaceId, documentId, actorIdentityId, await readJson(request))
              : await options.service.getAuthoredDocument(workspaceId, documentId, actorIdentityId)
          : request.method === "POST"
            ? await options.service.createAuthoredDocument(workspaceId, actorIdentityId, await readJson(request))
            : await options.service.listAuthoredDocuments(workspaceId, actorIdentityId);
        const fresh = options.browserSessions?.authenticate(request.headers.cookie);
        if (!fresh || fresh.scope !== browserSession.scope || fresh.identityId !== actorIdentityId) {
          json(response, 401, { error: "Local browser session required" }, origin);
          return;
        }
        response.setHeader("cache-control", "no-store");
        json(response, request.method === "POST" ? 201 : 200, result, origin);
        return;
      }
      const workspaceConfigMatch = path.match(/^\/local\/workspaces\/([^/]+)\/config$/);
      if (workspaceConfigMatch && browserSession) {
        const workspaceId = decodeURIComponent(workspaceConfigMatch[1]!);
        const result = request.method === "GET"
          ? await options.service.getWorkspaceConfiguration(workspaceId, browserSession.identityId)
          : await options.service.updateWorkspaceConfiguration(
            workspaceId,
            browserSession.identityId,
            await readJson(request),
          );
        json(response, 200, result, origin);
        return;
      }
      const workspaceRuntimeOptionsMatch = path.match(
        /^\/local\/workspaces\/([^/]+)\/runtime-options$/,
      );
      if (workspaceRuntimeOptionsMatch && browserSession && request.method === "GET") {
        const result = await options.service.getWorkspaceRuntimeOptions(
          decodeURIComponent(workspaceRuntimeOptionsMatch[1]!),
          url.searchParams.get("adapter") ?? "",
          browserSession.identityId,
        );
        json(response, 200, result, origin);
        return;
      }
      const agentRuntimeOptionsMatch = path.match(
        /^\/local\/workspaces\/([^/]+)\/agents\/([^/]+)\/runtime-options$/,
      );
      if (agentRuntimeOptionsMatch && browserSession
        && (request.method === "GET" || request.method === "PUT")) {
        const workspaceId = decodeURIComponent(agentRuntimeOptionsMatch[1]!);
        const agentIdentityId = decodeURIComponent(agentRuntimeOptionsMatch[2]!);
        const result = request.method === "GET"
          ? await options.service.getAgentRuntimeOptions(
            workspaceId,
            agentIdentityId,
            browserSession.identityId,
          )
          : await options.service.updateAgentRuntimeModelPolicy(
            workspaceId,
            agentIdentityId,
            browserSession.identityId,
            await readJson(request),
          );
        json(response, 200, result, origin);
        return;
      }
      const agentConfigMatch = path.match(/^\/local\/workspaces\/([^/]+)\/agents\/([^/]+)\/config$/);
      if (agentConfigMatch && browserSession
        && (request.method === "GET" || request.method === "PATCH")) {
        const workspaceId = decodeURIComponent(agentConfigMatch[1]!);
        const agentIdentityId = decodeURIComponent(agentConfigMatch[2]!);
        const result = request.method === "GET"
          ? await options.service.getWorkspaceAgentConfiguration(
            workspaceId,
            agentIdentityId,
            browserSession.identityId,
          )
          : await options.service.updateWorkspaceAgentConfiguration(
            workspaceId,
            agentIdentityId,
            browserSession.identityId,
            await readJson(request),
          );
        json(response, 200, result, origin);
        return;
      }
      const workingFoldersPreviewMatch = path.match(/^\/local\/conversations\/([^/]+)\/working-folders\/preview$/);
      if (workingFoldersPreviewMatch && browserSession && request.method === "POST") {
        json(response, 200, await options.service.previewConversationWorkingFolder(
          decodeURIComponent(workingFoldersPreviewMatch[1]!),
          browserSession.identityId,
          await readJson(request),
        ), origin);
        return;
      }
      const workingFoldersMatch = path.match(/^\/local\/conversations\/([^/]+)\/working-folders$/);
      if (workingFoldersMatch && browserSession
        && (request.method === "GET" || request.method === "PUT")) {
        const conversationId = decodeURIComponent(workingFoldersMatch[1]!);
        const result = request.method === "GET"
          ? await options.service.getConversationWorkingFolders(conversationId, browserSession.identityId)
          : await options.service.updateConversationWorkingFolders(
            conversationId,
            browserSession.identityId,
            await readJson(request),
          );
        json(response, 200, result, origin);
        return;
      }
      const bulkStartMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/start-all$/);
      if (bulkStartMatch && browserSession && request.method === "POST") {
        const result = await options.service.startAllConversationAgents(
          decodeURIComponent(bulkStartMatch[1]!),
          browserSession.identityId,
        );
        json(response, 200, result, origin);
        return;
      }
      const bulkStopMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/stop-all$/);
      if (bulkStopMatch && browserSession && request.method === "POST") {
        const result = await options.service.stopAllConversationAgents(
          decodeURIComponent(bulkStopMatch[1]!),
          browserSession.identityId,
        );
        json(response, 200, result, origin);
        return;
      }
      const agentStartMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)\/start$/);
      if (agentStartMatch && browserSession && request.method === "POST") {
        const agent = await options.service.startConversationAgent(
          decodeURIComponent(agentStartMatch[1]!),
          decodeURIComponent(agentStartMatch[2]!),
          browserSession.identityId,
          await readSessionContextMode(request),
        );
        json(response, 201, { agent }, origin);
        return;
      }
      const agentReconnectMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)\/reconnect$/);
      if (agentReconnectMatch && browserSession && request.method === "POST") {
        const agent = await options.service.reconnectConversationAgent(
          decodeURIComponent(agentReconnectMatch[1]!),
          decodeURIComponent(agentReconnectMatch[2]!),
          browserSession.identityId,
        );
        json(response, 200, { agent }, origin);
        return;
      }
      const agentReplaceMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)\/replace$/);
      if (agentReplaceMatch && browserSession && request.method === "POST") {
        const agent = await options.service.replaceConversationAgent(
          decodeURIComponent(agentReplaceMatch[1]!),
          decodeURIComponent(agentReplaceMatch[2]!),
          browserSession.identityId,
          await readSessionContextMode(request),
        );
        json(response, 200, { agent }, origin);
        return;
      }
      const agentStopMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)\/stop$/);
      if (agentStopMatch && browserSession && request.method === "POST") {
        const agent = await options.service.stopConversationAgent(
          decodeURIComponent(agentStopMatch[1]!),
          decodeURIComponent(agentStopMatch[2]!),
          browserSession.identityId,
        );
        json(response, 200, { agent }, origin);
        return;
      }
      const agentCancelMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)\/cancel-current$/);
      if (agentCancelMatch && browserSession && request.method === "POST") {
        const agent = await options.service.cancelCurrentConversationAgent(
          decodeURIComponent(agentCancelMatch[1]!),
          decodeURIComponent(agentCancelMatch[2]!),
          browserSession.identityId,
        );
        json(response, 202, { agent }, origin);
        return;
      }
      const match = path.match(/^\/local\/conversations\/([^/]+)\/agents$/);
      if (match && request.method === "GET") {
        const result = await options.service.listConversationAgents(decodeURIComponent(match[1]!));
        json(response, 200, result, origin);
        return;
      }
      json(response, 404, { error: "Not found" }, origin);
    })().catch((error: unknown) => {
      if (!response.headersSent && error instanceof LocalConfigurationRequestError) {
        json(response, error.status, { error: error.message }, origin);
      } else if (!response.headersSent) {
        json(response, 502, { error: "Local control status unavailable" }, origin);
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_CONTROL_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const endpointHost = host === "::1" ? "[::1]" : host;
  return {
    endpoint: `http://${endpointHost}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
