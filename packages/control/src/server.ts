import type {
  ConversationMetadata,
  EffectiveConversationLifecycle,
  UpdateConversationLifecycleInput,
} from "@minu/channels-core/types";
import { execFile } from "node:child_process";
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
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalAgentActivity,
  type LocalAgentRuntimeOptions,
  type LocalBulkAgentLifecycleResponse,
  type LocalBulkAgentLifecycleResult,
  type LocalConversationAgent,
  type LocalConversationAgentsResponse,
  type LocalConversationWorkingFolders,
  type LocalControlCapabilities,
  type LocalControlHealth,
  type LocalLiveCapabilityState,
  type LocalOpenDiagnosticResponse,
  type LocalRuntimeOptions,
  type LocalWakePolicy,
  type ProvisionLocalWorkspaceResult,
  type LocalWorkspaceAgentConfiguration,
  type LocalWorkspaceConfigurationSummary,
} from "./contracts.ts";

export interface LocalControlConversationDirectory {
  getConversation(conversationId: string): Promise<ConversationMetadata>;
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
  state: "connected" | "offline" | "replacing" | "disabled";
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
  status(sessionId: string): Promise<"idle" | "working" | "offline">;
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
  ): Promise<void>;
  replaceConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  stopConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  reconnectConversationAgent?(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  isAttached?(conversationId: string, agentIdentityId: string): boolean;
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
  openConversationAgentDiagnostic?(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  activity?(conversationId: string, agentIdentityId: string): LocalAgentActivity | undefined;
}

export interface LocalControlConfigurationPort {
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
  bindings: LocalControlBindingDirectory;
  runtimes: Readonly<Record<string, LocalControlRuntimePort>>;
  configuration?: LocalControlConfigurationPort;
  lifecycle?: LocalControlAgentLifecyclePort;
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

    const releaseFence = this.options.lifecycle?.fenceConversationAdmission?.(conversationId);
    let committed = false;
    try {
      const agents = (await this.listConversationAgents(conversationId)).agents;
      const unsafeAgents = agents.filter(({ state }) => !["unbound", "disabled", "idle"].includes(state));
      if (unsafeAgents.length > 0) {
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
        await this.options.lifecycle.stopConversationAgent(conversationId, agent.identityId, actorIdentityId);
      }
      const afterStop = await this.listConversationAgents(conversationId);
      if (afterStop.agents.some(({ state }) => state !== "unbound" && state !== "disabled")) {
        throw new LocalConfigurationRequestError(
          "Conversation agents changed while lifecycle was being updated; retry",
          409,
          "unavailable",
        );
      }
      const lifecycle = await this.options.conversations.updateConversationLifecycle(conversationId, {
        actorIdentityId,
        state: input.state,
        ...(input.state === "snoozed" ? { snoozedUntil: input.snoozedUntil } : {}),
      });
      committed = true;
      return lifecycle;
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

  async startConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    if (!this.options.lifecycle?.available) {
      throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.startConversationAgent(conversationId, identityId, actorIdentityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async replaceConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    if (!this.options.lifecycle?.available) {
      throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.replaceConversationAgent(conversationId, identityId, actorIdentityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async stopConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    if (!this.options.lifecycle?.available) {
      throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.stopConversationAgent(conversationId, identityId, actorIdentityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async reconnectConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    if (!this.options.lifecycle?.available || !this.options.lifecycle.reconnectConversationAgent) {
      throw new LocalConfigurationRequestError("Agent reconnect unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.reconnectConversationAgent(conversationId, identityId, actorIdentityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async startAllConversationAgents(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResponse> {
    if (!this.options.lifecycle?.available || !this.options.lifecycle.startAllConversationAgents) {
      throw new LocalConfigurationRequestError("Bulk agent lifecycle unavailable", 404, "unavailable");
    }
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      conversationId,
      results: await this.options.lifecycle.startAllConversationAgents(conversationId, actorIdentityId),
    };
  }

  async stopAllConversationAgents(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResponse> {
    if (!this.options.lifecycle?.available || !this.options.lifecycle.stopAllConversationAgents) {
      throw new LocalConfigurationRequestError("Bulk agent lifecycle unavailable", 404, "unavailable");
    }
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      conversationId,
      results: await this.options.lifecycle.stopAllConversationAgents(conversationId, actorIdentityId),
    };
  }

  async cancelCurrentConversationAgent(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalConversationAgent> {
    if (!this.options.lifecycle?.available) {
      throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.cancelCurrentConversationAgent(conversationId, identityId, actorIdentityId);
    return this.conversationAgent(conversationId, identityId);
  }

  async openConversationAgentDiagnostic(
    conversationId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalOpenDiagnosticResponse> {
    if (!this.options.lifecycle?.available || !this.options.lifecycle.openConversationAgentDiagnostic) {
      throw new LocalConfigurationRequestError("Agent diagnostic unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.openConversationAgentDiagnostic(conversationId, identityId, actorIdentityId);
    return { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, status: "opened" };
  }

  private async conversationAgent(conversationId: string, identityId: string): Promise<LocalConversationAgent> {
    const response = await this.listConversationAgents(conversationId);
    const agent = response.agents.find((candidate) => candidate.identityId === identityId);
    if (!agent) throw new LocalConfigurationRequestError("Conversation agent unavailable", 404, "unavailable");
    return agent;
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
    if (binding.state === "replacing") {
      return { ...base, ...details, state: "uncertain", capabilities: disabledCapabilities };
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
    const activity = this.options.lifecycle?.activity?.(conversation.id, identityId);
    const attached = this.options.lifecycle?.isAttached?.(conversation.id, identityId);
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
    const isAllowedPost = request.method === "POST" && (
      /^\/local\/conversations\/[^/]+\/agents\/[^/]+\/(start|reconnect|replace|stop|cancel-current|open-diagnostic)$/.test(requestPath)
      || /^\/local\/conversations\/[^/]+\/agents\/(start-all|stop-all)$/.test(requestPath)
      || requestPath === "/local/folders/select"
      || requestPath === "/local/workspaces"
      || /^\/local\/conversations\/[^/]+\/working-folders\/preview$/.test(requestPath)
    );
    if (request.method !== "GET" && request.method !== "PATCH" && request.method !== "PUT" && !isAllowedPost) {
      response.setHeader("allow", "GET, PATCH, PUT, POST");
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
      const agentDiagnosticMatch = path.match(/^\/local\/conversations\/([^/]+)\/agents\/([^/]+)\/open-diagnostic$/);
      if (agentDiagnosticMatch && browserSession && request.method === "POST") {
        const result = await options.service.openConversationAgentDiagnostic(
          decodeURIComponent(agentDiagnosticMatch[1]!),
          decodeURIComponent(agentDiagnosticMatch[2]!),
          browserSession.identityId,
        );
        json(response, 202, result, origin);
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
