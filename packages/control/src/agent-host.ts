import { ConversationClient } from "@minu/channels-core/client";
import {
  ConversationRuntimeRelay,
  LocalRelayDirectory,
  restoreConversationBindings,
  type AgentRuntimePort,
  type ConversationAgentBindingRecord,
  type ConversationWorkingFolder,
  type LocalWorkspaceConfig,
  type RelayBindingStore,
  type RestoredConversationBindings,
  type RestoreBindingOutcome,
  type RelayAgentActivity,
  type WorkspaceAgentConfig,
} from "@minu/channels-relay";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalConfigurationRequestError } from "./configuration.ts";
import type { LocalControlRuntimePort } from "./server.ts";
import type {
  LocalAgentRuntimeOptions,
  LocalBulkAgentLifecycleResult,
  LocalReasoningLevel,
} from "./contracts.ts";
import type { LocalControlAuditEvent } from "./session.ts";

export interface ManagedRuntimeStartConfig {
  cwd: string;
  appendSystemPrompt?: string;
  model?: { provider: string; id: string };
  reasoningLevel?: LocalReasoningLevel;
  skillIds?: string[];
}

export interface ManagedRuntimeSession {
  id: string;
}

export interface LocalManagedRuntimePort extends LocalControlRuntimePort, Partial<Omit<AgentRuntimePort, "status">> {
  start?(config: ManagedRuntimeStartConfig): Promise<ManagedRuntimeSession>;
  capabilities?(config?: { cwd?: string }): Promise<{
    models: Array<Omit<LocalAgentRuntimeOptions["models"][number], "enabled">>;
    reasoningLevels: LocalAgentRuntimeOptions["reasoningLevels"];
    skills: LocalAgentRuntimeOptions["skills"];
    defaultModel?: LocalAgentRuntimeOptions["defaultModel"];
    defaultReasoningLevel?: LocalAgentRuntimeOptions["defaultReasoningLevel"];
  }>;
  stop?(sessionId: string): Promise<void>;
}

interface BulkLifecycleTarget {
  identityId: string;
  binding?: ConversationAgentBindingRecord;
  duplicate: boolean;
}

class BulkSnapshotChangedError extends Error {}

type AttachmentResult = "attached" | RestoreBindingOutcome | "failed";

export interface LocalAgentHostDiagnosticEvent {
  category: "binding_restore" | "binding_lease";
  outcome: "attached" | "reattached" | "retrying" | "offline" | "uncertain" | "conflict" | "invalid" | "failed";
  conversationId: string;
  agentIdentityId: string;
  timestamp: string;
  attempt?: number;
}

interface BindingRecovery {
  conversationId: string;
  bindingId: string;
  agentIdentityId: string;
  generation: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface LocalAgentHostWorkSnapshot {
  state: "running" | "quiescing" | "quiesced" | "closed";
  activeTurns: number;
  queuedTurns: number;
  queuedTurnsExact: boolean;
  pendingLifecycle: number;
}

interface ConversationRunner {
  relay: ConversationRuntimeRelay;
  /** Relay ownership transitions are serialized per Conversation and readiness is explicit. */
  readiness: "starting" | "ready" | "stopping";
  ready: Promise<void>;
  resolveReady(): void;
  pendingAttaches: Set<string>;
  /** One independently renewed lease holder per attached Runtime binding. */
  restored: Map<string, RestoredConversationBindings>;
}

export interface LocalAgentHostOptions {
  client: ConversationClient;
  store: RelayBindingStore;
  runtimes: Readonly<Record<string, LocalManagedRuntimePort>>;
  now?: () => Date;
  leaseOwner?: string;
  stopStartedSessionsOnClose?: boolean;
  bindingLeaseDurationMs?: number;
  runtimeStatusTimeoutMs?: number;
  recoveryBackoffMs?: readonly number[];
  onAudit?(event: LocalControlAuditEvent): void;
  onDiagnostic?(event: LocalAgentHostDiagnosticEvent): void;
  onError?(error: Error): void;
}

function executableRuntime(runtime: LocalManagedRuntimePort | undefined): runtime is AgentRuntimePort & LocalManagedRuntimePort {
  return Boolean(runtime
    && typeof runtime.status === "function"
    && typeof runtime.send === "function"
    && typeof runtime.messages === "function");
}

function launchableRuntime(runtime: LocalManagedRuntimePort | undefined): runtime is AgentRuntimePort & LocalManagedRuntimePort & Required<Pick<LocalManagedRuntimePort, "start">> {
  return executableRuntime(runtime) && typeof runtime.start === "function";
}

function supportsOpenDiagnostic(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const fields = [
    "safeActivityEvents",
    "interrupt",
    "reconnectExisting",
    "interactiveAttach",
    "openDiagnostic",
    "liveSkillVerification",
  ];
  return candidate.version === 1
    && fields.every((field) => typeof candidate[field] === "boolean")
    && candidate.openDiagnostic === true;
}

function launchFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /model|reasoning|thinking|skill/i.test(message)
    ? "Configured agent model, reasoning, or skill is unavailable; update the launch profile and retry"
    : fallback;
}

function assertModelPolicy(
  workspaceConfig: LocalWorkspaceConfig,
  agentConfig: WorkspaceAgentConfig,
): void {
  if (!agentConfig.runtimeAdapter || !agentConfig.modelProvider || !agentConfig.modelId) return;
  const policy = workspaceConfig.runtimeModelPolicies?.[agentConfig.runtimeAdapter];
  if (policy && !policy.some(
    (model) => model.provider === agentConfig.modelProvider && model.id === agentConfig.modelId,
  )) {
    throw new LocalConfigurationRequestError(
      "Configured agent model is disabled for this Runtime",
      409,
      "unavailable",
    );
  }
}

async function workspaceDirectory(rootUri: string): Promise<string> {
  let directory: string;
  try {
    if (rootUri.startsWith("file:")) {
      directory = fileURLToPath(rootUri);
    } else {
      if (!isAbsolute(rootUri)) {
        throw new Error("Workspace source must be an absolute path or file URI");
      }
      directory = resolve(rootUri);
    }
  } catch {
    throw new LocalConfigurationRequestError(
      "Workspace source must be an absolute local path or file URI",
      409,
      "unavailable",
    );
  }
  try {
    const canonical = await realpath(directory);
    const details = await stat(canonical);
    if (!details.isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new LocalConfigurationRequestError(
      "Configured Workspace source is not an available directory",
      409,
      "unavailable",
    );
  }
}

function relativePathWithinWorkspace(workspaceRoot: string, selectedPath: string): boolean {
  const path = relative(workspaceRoot, selectedPath);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function conversationWorkingFolderGuidance(
  primaryCwd: string,
  folders: ReadonlyArray<{ folder: ConversationWorkingFolder; cwd: string }>,
): string {
  return [
    "Conversation working folders (paths below are relative to the current working directory):",
    "- Primary folder: .",
    ...folders.filter(({ folder }) => !folder.primary).map(({ cwd }) =>
      `- Additional folder: ${relative(primaryCwd, cwd).split(sep).join("/") || "."}`),
    "Working folders guide where you should work. They are not a filesystem sandbox.",
  ].join("\n");
}

export class LocalAgentHost {
  private readonly directory: LocalRelayDirectory;
  private readonly now: () => Date;
  private readonly leaseOwner: string;
  private readonly runners = new Map<string, ConversationRunner>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly attachingBindings = new Set<string>();
  private readonly recoveries = new Map<string, BindingRecovery>();
  private readonly recoveryBackoffMs: readonly number[];
  private readonly startedSessions = new Map<string, {
    bindingId: string;
    runtime: LocalManagedRuntimePort;
    sessionId: string;
  }>();
  private quiescing = false;
  private quiesced = false;
  private closed = false;

  constructor(private readonly options: LocalAgentHostOptions) {
    this.directory = new LocalRelayDirectory(options.client, options.store, options.now);
    this.now = options.now ?? (() => new Date());
    this.leaseOwner = options.leaseOwner ?? `local-agent-host:${process.pid}:${randomUUID()}`;
    this.recoveryBackoffMs = options.recoveryBackoffMs ?? [250, 500, 1_000, 2_000, 5_000];
    if (this.recoveryBackoffMs.length === 0 || this.recoveryBackoffMs.some(
      (delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 1,
    )) {
      throw new RangeError("recoveryBackoffMs must contain positive integers");
    }
  }

  get available(): boolean {
    return !this.closed && !this.quiescing
      && Object.values(this.options.runtimes).some(launchableRuntime);
  }

  workSnapshot(): LocalAgentHostWorkSnapshot {
    const relays = [...this.runners.values()].map(({ relay }) => relay.workSnapshot());
    return {
      state: this.closed ? "closed" : this.quiesced ? "quiesced" : this.quiescing ? "quiescing" : "running",
      activeTurns: relays.reduce((count, relay) => count + relay.activeTurns, 0),
      queuedTurns: relays.reduce((count, relay) => count + relay.queuedTurns, 0),
      queuedTurnsExact: relays.every((relay) => relay.queuedTurnsExact),
      pendingLifecycle: this.pending.size,
    };
  }

  async beginQuiesce(): Promise<LocalAgentHostWorkSnapshot> {
    if (this.closed) return this.workSnapshot();
    this.quiescing = true;
    for (const recovery of this.recoveries.values()) clearTimeout(recovery.timer);
    this.recoveries.clear();
    // Freeze Relay admission at the boundary. Operations already serialized before
    // it may still finish durable lifecycle changes, including a quiesced attach.
    for (const { relay } of this.runners.values()) relay.quiesce();
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()]);
    }
    return this.workSnapshot();
  }

  async waitForQuiesced(): Promise<LocalAgentHostWorkSnapshot> {
    await this.beginQuiesce();
    await Promise.all([...this.runners.values()].map(({ relay }) => relay.waitForQuiesced()));
    this.quiesced = true;
    return this.workSnapshot();
  }

  async startAllConversationAgents(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]> {
    return this.runBulkLifecycle("start", conversationId, actorIdentityId);
  }

  async stopAllConversationAgents(
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]> {
    return this.runBulkLifecycle("stop", conversationId, actorIdentityId);
  }

  async restore(): Promise<void> {
    if (!this.available || this.closed) return;
    const workspaces = await this.options.client.listWorkspaces();
    const bindingGroups = await Promise.all(
      workspaces.map((workspace) => this.options.store.listWorkspaceBindings(workspace.id)),
    );
    const conversationIds = [...new Set(bindingGroups.flat()
      .filter((binding) => binding.state !== "disabled")
      .map((binding) => binding.conversationId))];
    const records = bindingGroups.flat();
    await Promise.all(conversationIds.map((conversationId) => this.refreshConversation(conversationId).catch(() => {
      for (const record of records.filter(
        (candidate) => candidate.conversationId === conversationId && candidate.state !== "disabled",
      )) {
        this.handleAttachmentResult(record, "failed", "binding_restore");
      }
    })));
  }

  async startConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    expectedBinding?: null,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(conversationId, agentIdentityId), async () => {
      try {
        if (this.closed || this.quiescing) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const conversation = await this.options.client.getConversation(conversationId).catch(() => {
          throw new LocalConfigurationRequestError("Conversation is unavailable", 404, "unavailable");
        });
        const [workspace, members, actor, identity, workspaceConfig, agentConfig, bindings] = await Promise.all([
          this.options.client.getWorkspace(conversation.workspaceId),
          this.options.client.listWorkspaceMembers(conversation.workspaceId),
          this.options.client.getIdentity(actorIdentityId),
          this.options.client.getIdentity(agentIdentityId),
          this.options.store.getWorkspaceConfig(conversation.workspaceId),
          this.options.store.getWorkspaceAgentConfig(conversation.workspaceId, agentIdentityId),
          this.options.store.listConversationBindings(conversationId),
        ]);
        const actorMembership = members.find(({ identityId }) => identityId === actorIdentityId);
        if (actor.type !== "human" || actor.status !== "active" || actorMembership?.status !== "active"
          || (actorMembership.accessRole !== "owner" && actorMembership.accessRole !== "admin")) {
          throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
        }
        const agentMembership = members.find(({ identityId }) => identityId === agentIdentityId);
        const participant = conversation.participants.find(({ id }) => id === agentIdentityId);
        if (workspace.status !== "active" || identity.status !== "active"
          || (identity.type !== "agent" && identity.type !== "service")
          || agentMembership?.status !== "active" || participant?.status !== "active") {
          throw new LocalConfigurationRequestError(
            "Agent must be an active Conversation participant",
            409,
            "unavailable",
          );
        }
        if (expectedBinding === null
          && bindings.some((binding) => binding.agentIdentityId === agentIdentityId)) {
          throw new BulkSnapshotChangedError("Agent binding changed after bulk acceptance");
        }
        if (bindings.some((binding) => binding.agentIdentityId === agentIdentityId)) {
          throw new LocalConfigurationRequestError(
            "Agent already has a Conversation session; explicit replacement is required",
            409,
            "unavailable",
          );
        }
        if (!workspaceConfig || !agentConfig || agentConfig.status !== "active"
          || !agentConfig.runtimeAdapter) {
          throw new LocalConfigurationRequestError(
            "Configure the Workspace source and active agent Runtime before starting",
            409,
            "unavailable",
          );
        }
        assertModelPolicy(workspaceConfig, agentConfig);
        const runtime = this.options.runtimes[agentConfig.runtimeAdapter];
        if (!launchableRuntime(runtime)) {
          throw new LocalConfigurationRequestError(
            "Configured agent Runtime is unavailable",
            409,
            "unavailable",
          );
        }
        const launch = await this.resolveWorkingFolderLaunch(workspaceConfig, conversationId);
        let session: ManagedRuntimeSession | undefined;
        let bindingId: string | undefined;
        try {
          session = await runtime.start({
            cwd: launch.cwd,
            appendSystemPrompt: this.appendWorkingFolderGuidance(agentConfig.personaPrompt, launch.workingFolderGuidance),
            ...(agentConfig.modelProvider && agentConfig.modelId
              ? { model: { provider: agentConfig.modelProvider, id: agentConfig.modelId } }
              : {}),
            ...(agentConfig.reasoningLevel ? { reasoningLevel: agentConfig.reasoningLevel } : {}),
            ...(agentConfig.skillIds !== undefined ? { skillIds: [...agentConfig.skillIds] } : {}),
          });
          const messages = await this.options.client.listMessages(conversationId);
          await this.options.store.setCursor(
            conversationId,
            agentIdentityId,
            messages.at(-1)?.sequence ?? 0,
          );
          const binding = await this.directory.bindAgent({
            conversationId,
            agentIdentityId,
            runtimeAdapter: agentConfig.runtimeAdapter,
            runtimeSessionId: session.id,
          });
          bindingId = binding.id;
          if (await this.attachBinding(conversationId, binding.id) !== "attached") {
            throw new Error("Agent binding could not be attached to the Conversation Relay");
          }
          this.startedSessions.set(this.sessionKey(binding.id, session.id), {
            bindingId: binding.id,
            runtime,
            sessionId: session.id,
          });
        } catch (error) {
          if (bindingId) {
            await this.options.store.deleteBinding(bindingId).catch(() => undefined);
            await this.retireBinding(conversationId, agentIdentityId).catch((restoreError) => {
              this.options.onError?.(
                restoreError instanceof Error ? restoreError : new Error(String(restoreError)),
              );
            });
          }
          if (session && runtime.stop) await runtime.stop(session.id).catch(() => undefined);
          if (error instanceof LocalConfigurationRequestError) throw error;
          throw new LocalConfigurationRequestError(
            launchFailureMessage(error, "Agent session could not be started"),
            409,
            "unavailable",
          );
        }
        this.audit({
          action: "agent.session.started",
          outcome: "accepted",
          actorIdentityId,
          workspaceId: conversation.workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        const conversation = await this.options.client.getConversation(conversationId).catch(() => undefined);
        this.audit({
          action: "agent.session.started",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId: conversation?.workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
        throw error;
      }
    });
  }

  async replaceConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    expectedBinding?: Pick<ConversationAgentBindingRecord, "id" | "generation" | "state">,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(conversationId, agentIdentityId), async () => {
      let session: ManagedRuntimeSession | undefined;
      let runtime: (AgentRuntimePort & LocalManagedRuntimePort & Required<Pick<LocalManagedRuntimePort, "start">>) | undefined;
      let committed = false;
      let previousRuntime: LocalManagedRuntimePort | undefined;
      let previousSessionId: string | undefined;
      let workspaceId: string | undefined;
      try {
        if (this.closed || this.quiescing) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.configuredContext(conversationId, agentIdentityId, actorIdentityId);
        workspaceId = context.conversation.workspaceId;
        assertModelPolicy(context.workspaceConfig, context.agentConfig);
        const matches = context.bindings.filter((binding) => binding.agentIdentityId === agentIdentityId);
        if (matches.length !== 1) {
          throw new LocalConfigurationRequestError(
            matches.length === 0
              ? "Agent has no Conversation session; start it first"
              : "Agent Conversation session is uncertain",
            409,
            "unavailable",
          );
        }
        const previous = matches[0]!;
        if (expectedBinding && (previous.id !== expectedBinding.id
          || previous.generation !== expectedBinding.generation
          || previous.state !== expectedBinding.state)) {
          throw new BulkSnapshotChangedError("Agent binding changed after bulk acceptance");
        }
        previousRuntime = this.options.runtimes[previous.runtimeAdapter];
        previousSessionId = previous.runtimeSessionId;
        await this.assertBindingsIdle([previous], previous.id);
        runtime = context.runtime;
        session = await runtime.start({
          cwd: context.cwd,
          appendSystemPrompt: this.appendWorkingFolderGuidance(
            context.agentConfig.personaPrompt,
            context.workingFolderGuidance,
          ),
          ...(context.agentConfig.modelProvider && context.agentConfig.modelId
            ? { model: { provider: context.agentConfig.modelProvider, id: context.agentConfig.modelId } }
            : {}),
          ...(context.agentConfig.reasoningLevel
            ? { reasoningLevel: context.agentConfig.reasoningLevel }
            : {}),
          ...(context.agentConfig.skillIds !== undefined
            ? { skillIds: [...context.agentConfig.skillIds] }
            : {}),
        });
        const replaced = await this.directory.replaceSession({
          bindingId: previous.id,
          expectedGeneration: previous.generation,
          runtimeAdapter: context.agentConfig.runtimeAdapter!,
          runtimeSessionId: session.id,
        });
        committed = true;
        // The durable replacement now owns the new Runtime even if Relay reconciliation fails.
        this.startedSessions.set(this.sessionKey(replaced.id, session.id), {
          bindingId: replaced.id,
          runtime,
          sessionId: session.id,
        });
        const messages = await this.options.client.listMessages(conversationId);
        await this.options.store.setCursor(
          conversationId,
          agentIdentityId,
          messages.at(-1)?.sequence ?? 0,
        );
        await this.retireBinding(conversationId, agentIdentityId).catch((error) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
        if (await this.attachBinding(conversationId, replaced.id) !== "attached") {
          throw new LocalConfigurationRequestError(
            "Replacement Runtime could not be attached; its binding requires reconciliation",
            409,
            "unavailable",
          );
        }
        await this.stopRuntimeBestEffort(previousRuntime, previousSessionId);
        this.startedSessions.delete(this.sessionKey(previous.id, previous.runtimeSessionId));
        this.audit({
          action: "agent.session.replaced",
          outcome: "accepted",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        if (!committed && session && runtime?.stop) {
          await runtime.stop(session.id).catch(() => undefined);
        }
        if (committed && previousSessionId) {
          await this.stopRuntimeBestEffort(previousRuntime, previousSessionId);
          const records = await this.options.store.listConversationBindings(conversationId).catch(() => []);
          const binding = records.find(({ agentIdentityId }) => agentIdentityId === agentIdentityId);
          if (binding) this.startedSessions.delete(this.sessionKey(binding.id, previousSessionId));
        }
        this.audit({
          action: "agent.session.replaced",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
        if (error instanceof LocalConfigurationRequestError || error instanceof BulkSnapshotChangedError) throw error;
        if (committed) {
          throw new LocalConfigurationRequestError(
            "Replacement was committed but Relay reconciliation is incomplete",
            409,
            "unavailable",
          );
        }
        throw new LocalConfigurationRequestError(
          launchFailureMessage(error, "Agent session could not be replaced"),
          409,
          "unavailable",
        );
      }
    });
  }

  activity(conversationId: string, agentIdentityId: string): RelayAgentActivity | undefined {
    return this.runners.get(conversationId)?.relay.activity(agentIdentityId);
  }

  isAttached(conversationId: string, agentIdentityId: string): boolean {
    return this.runners.get(conversationId)?.restored.has(agentIdentityId) ?? false;
  }

  async reconnectConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(conversationId, agentIdentityId), async () => {
      let workspaceId: string | undefined;
      try {
        if (this.closed || this.quiescing) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.baseContext(conversationId, agentIdentityId, actorIdentityId);
        workspaceId = context.conversation.workspaceId;
        const matches = context.bindings.filter(({ agentIdentityId: candidate }) => candidate === agentIdentityId);
        if (matches.length !== 1) {
          throw new LocalConfigurationRequestError("Agent reconnect requires one existing Conversation session", 409, "unavailable");
        }
        const binding = matches[0]!;
        if (binding.state === "disabled" || binding.state === "replacing") {
          throw new LocalConfigurationRequestError("Agent session cannot be reconnected from its current state", 409, "unavailable");
        }
        if (this.isAttached(conversationId, agentIdentityId)) {
          throw new LocalConfigurationRequestError("Agent session is already connected", 409, "unavailable");
        }
        if (await this.attachBinding(conversationId, binding.id) !== "attached") {
          const current = await this.options.store.getBinding(binding.id);
          throw new LocalConfigurationRequestError(
            current?.state === "offline"
              ? "Existing Runtime session is unreachable; use New session instead"
              : "Existing Runtime session could not be reconnected",
            409,
            "unavailable",
          );
        }
        this.audit({
          action: "agent.session.reconnected",
          outcome: "accepted",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        this.audit({
          action: "agent.session.reconnected",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
        throw error;
      }
    });
  }

  async cancelCurrentConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(conversationId, agentIdentityId), async () => {
      let workspaceId: string | undefined;
      try {
        if (this.closed || this.quiescing) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.baseContext(conversationId, agentIdentityId, actorIdentityId);
        workspaceId = context.conversation.workspaceId;
        const runner = this.runners.get(conversationId);
        if (!runner) {
          throw new LocalConfigurationRequestError("Agent Conversation session is unavailable", 409, "unavailable");
        }
        await runner.relay.cancelCurrent(agentIdentityId, actorIdentityId);
        this.audit({
          action: "agent.turn.cancel.requested",
          outcome: "accepted",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        this.audit({
          action: "agent.turn.cancel.requested",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
        if (error instanceof LocalConfigurationRequestError) throw error;
        throw new LocalConfigurationRequestError(
          "Agent turn could not be canceled",
          409,
          "unavailable",
        );
      }
    });
  }

  async openConversationAgentDiagnostic(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(conversationId, agentIdentityId), async () => {
      let workspaceId: string | undefined;
      try {
        if (this.closed || this.quiescing) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.baseContext(conversationId, agentIdentityId, actorIdentityId);
        workspaceId = context.conversation.workspaceId;
        const matches = context.bindings.filter(
          ({ agentIdentityId: candidate }) => candidate === agentIdentityId,
        );
        if (matches.length !== 1 || matches[0]!.state !== "connected") {
          throw new LocalConfigurationRequestError("Agent diagnostic unavailable", 409, "unavailable");
        }
        const binding = matches[0]!;
        const runtime = this.options.runtimes[binding.runtimeAdapter];
        if (!runtime?.sessionCapabilities || !runtime.openDiagnostic) {
          throw new LocalConfigurationRequestError("Agent diagnostic unavailable", 409, "unavailable");
        }
        const [status, capabilities] = await Promise.all([
          this.runtimeStatus(runtime, binding.runtimeSessionId),
          this.withTimeout(
            runtime.sessionCapabilities(binding.runtimeSessionId),
            2_000,
            "Runtime capability query timed out",
          ),
        ]);
        if (status === "offline" || !supportsOpenDiagnostic(capabilities)) {
          throw new LocalConfigurationRequestError("Agent diagnostic unavailable", 409, "unavailable");
        }
        await this.withTimeout(
          runtime.openDiagnostic(binding.runtimeSessionId),
          2_000,
          "Runtime diagnostic opening timed out",
        );
        this.audit({
          action: "agent.diagnostic.opened",
          outcome: "accepted",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        this.audit({
          action: "agent.diagnostic.opened",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
        if (error instanceof LocalConfigurationRequestError) throw error;
        throw new LocalConfigurationRequestError(
          "Agent diagnostic could not be opened",
          409,
          "unavailable",
        );
      }
    });
  }

  async stopConversationAgent(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    expectedBinding?: Pick<ConversationAgentBindingRecord, "id" | "generation" | "state">,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(conversationId, agentIdentityId), async () => {
      let workspaceId: string | undefined;
      let committed = false;
      try {
        if (this.closed || this.quiescing) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.baseContext(conversationId, agentIdentityId, actorIdentityId);
        workspaceId = context.conversation.workspaceId;
        const matches = context.bindings.filter((binding) => binding.agentIdentityId === agentIdentityId);
        if (matches.length !== 1) {
          throw new LocalConfigurationRequestError(
            matches.length === 0 ? "Agent has no Conversation session" : "Agent Conversation session is uncertain",
            409,
            "unavailable",
          );
        }
        const target = matches[0]!;
        if (expectedBinding && (target.id !== expectedBinding.id
          || target.generation !== expectedBinding.generation
          || target.state !== expectedBinding.state)) {
          throw new BulkSnapshotChangedError("Agent binding changed after bulk acceptance");
        }
        if (target.state === "disabled") {
          throw new LocalConfigurationRequestError("Agent Conversation session is already stopped", 409, "unavailable");
        }
        const disabled = await this.options.store.disableBinding(
          target.id,
          target.generation,
          this.now().toISOString(),
        );
        if (!disabled) {
          throw new LocalConfigurationRequestError(
            "Agent binding changed; reload before stopping",
            409,
            "unavailable",
          );
        }
        committed = true;
        await this.stopRuntimeBestEffort(
          this.options.runtimes[target.runtimeAdapter],
          target.runtimeSessionId,
        );
        this.startedSessions.delete(this.sessionKey(target.id, target.runtimeSessionId));
        await this.retireBinding(conversationId, agentIdentityId).catch((error) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
        this.audit({
          action: "agent.session.stopped",
          outcome: "accepted",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        this.audit({
          action: "agent.session.stopped",
          outcome: committed ? "accepted" : "rejected",
          reason: committed
            ? undefined
            : error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: agentIdentityId,
        });
        if (committed) return;
        if (error instanceof LocalConfigurationRequestError || error instanceof BulkSnapshotChangedError) throw error;
        throw new LocalConfigurationRequestError("Agent session could not be stopped", 409, "unavailable");
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const recovery of this.recoveries.values()) clearTimeout(recovery.timer);
    this.recoveries.clear();
    // Operations that passed their availability check own their transition through completion.
    // Drain them (including Relay mutations they enqueue) before taking the shutdown snapshot.
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()]);
    }
    const runners = [...this.runners.values()];
    this.runners.clear();
    await Promise.allSettled(runners.map(async ({ relay, restored }) => {
      await relay.stop();
      await Promise.all([...restored.values()].map((binding) => binding.close()));
    }));
    if (this.options.stopStartedSessionsOnClose) {
      const sessions = [...this.startedSessions.values()];
      this.startedSessions.clear();
      await Promise.allSettled(sessions.map(async ({ bindingId, runtime, sessionId }) => {
        if (runtime.stop) await runtime.stop(sessionId);
        await this.options.store.deleteBinding(bindingId);
      }));
    }
  }

  private async runBulkLifecycle(
    action: "start" | "stop",
    conversationId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]> {
    let workspaceId: string | undefined;
    const aggregateAction = action === "start" ? "agents.bulk-started" : "agents.bulk-stopped";
    const itemAction = action === "start" ? "agent.session.bulk-started" : "agent.session.bulk-stopped";
    try {
      const targets = await this.bulkTargets(conversationId, actorIdentityId);
      workspaceId = targets.workspaceId;
      const results = await this.mapBounded(targets.targets, 3, async (target) => {
        let result: LocalBulkAgentLifecycleResult;
        try {
          result = action === "start"
            ? await this.bulkStartOne(conversationId, targets.workspaceId, target, actorIdentityId)
            : await this.bulkStopOne(conversationId, target, actorIdentityId);
        } catch {
          // Target-local storage, configuration, and Runtime failures are partial results.
          // Shared discovery/authorization above are the only aggregate rejection boundary.
          result = { identityId: target.identityId, outcome: "failed", reason: "unavailable" };
        }
        this.audit({
          action: itemAction,
          outcome: result.outcome === "failed" ? "rejected" : "accepted",
          reason: result.reason,
          actorIdentityId,
          workspaceId,
          conversationId,
          targetIdentityId: target.identityId,
        });
        return result;
      });
      this.audit({
        action: aggregateAction,
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
        conversationId,
      });
      return results;
    } catch (error) {
      this.audit({
        action: aggregateAction,
        outcome: "rejected",
        reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
        actorIdentityId,
        workspaceId,
        conversationId,
      });
      throw error;
    }
  }

  private async bulkTargets(conversationId: string, actorIdentityId: string): Promise<{
    workspaceId: string;
    targets: BulkLifecycleTarget[];
  }> {
    if (this.closed || this.quiescing) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
    const conversation = await this.options.client.getConversation(conversationId).catch(() => {
      throw new LocalConfigurationRequestError("Conversation is unavailable", 404, "unavailable");
    });
    const [workspace, members, actor, bindings] = await Promise.all([
      this.options.client.getWorkspace(conversation.workspaceId),
      this.options.client.listWorkspaceMembers(conversation.workspaceId),
      this.options.client.getIdentity(actorIdentityId),
      this.options.store.listConversationBindings(conversationId),
    ]);
    const actorMembership = members.find(({ identityId }) => identityId === actorIdentityId);
    if (workspace.status !== "active" || actor.type !== "human" || actor.status !== "active"
      || actorMembership?.status !== "active"
      || (actorMembership.accessRole !== "owner" && actorMembership.accessRole !== "admin")) {
      throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
    }
    return {
      workspaceId: conversation.workspaceId,
      targets: conversation.participants
        .filter((participant) => participant.status === "active"
          && (participant.type === "agent" || participant.type === "service"))
        .map(({ id }) => {
          const matches = bindings.filter(({ agentIdentityId }) => agentIdentityId === id);
          return { identityId: id, binding: matches[0], duplicate: matches.length > 1 };
        }),
    };
  }

  private async bulkStartOne(
    conversationId: string,
    workspaceId: string,
    target: BulkLifecycleTarget,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult> {
    const { identityId, binding } = target;
    if (target.duplicate || binding?.state === "replacing") {
      return { identityId, outcome: "skipped", reason: "uncertain" };
    }
    if (binding && binding.state !== "disabled") {
      if (binding.state === "offline") return { identityId, outcome: "skipped", reason: "offline" };
      const runtime = this.options.runtimes[binding.runtimeAdapter];
      if (!runtime) return { identityId, outcome: "skipped", reason: "offline" };
      try {
        const status = await this.runtimeStatus(runtime, binding.runtimeSessionId);
        return {
          identityId,
          outcome: "skipped",
          reason: status === "working" ? "already_running" : status === "idle" ? "already_idle" : "offline",
        };
      } catch {
        return { identityId, outcome: "skipped", reason: "offline" };
      }
    }
    const config = await this.options.store.getWorkspaceAgentConfig(workspaceId, identityId);
    if (!config || config.status !== "active" || !config.runtimeAdapter
      || !launchableRuntime(this.options.runtimes[config.runtimeAdapter])) {
      return { identityId, outcome: "skipped", reason: "unconfigured" };
    }
    try {
      if (binding?.state === "disabled") {
        await this.replaceConversationAgent(conversationId, identityId, actorIdentityId, binding);
      } else {
        await this.startConversationAgent(conversationId, identityId, actorIdentityId, null);
      }
      return { identityId, outcome: "started" };
    } catch (error) {
      return error instanceof BulkSnapshotChangedError
        ? { identityId, outcome: "skipped", reason: "uncertain" }
        : { identityId, outcome: "failed", reason: "unavailable" };
    }
  }

  private async bulkStopOne(
    conversationId: string,
    target: BulkLifecycleTarget,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult> {
    const { identityId, binding } = target;
    if (target.duplicate || binding?.state === "replacing") {
      return { identityId, outcome: "skipped", reason: "uncertain" };
    }
    if (!binding || binding.state === "disabled") {
      return { identityId, outcome: "skipped", reason: "already_idle" };
    }
    try {
      await this.stopConversationAgent(conversationId, identityId, actorIdentityId, binding);
      return { identityId, outcome: "stopped" };
    } catch (error) {
      return error instanceof BulkSnapshotChangedError
        ? { identityId, outcome: "skipped", reason: "uncertain" }
        : { identityId, outcome: "failed", reason: "unavailable" };
    }
  }

  private async mapBounded<T, R>(
    values: readonly T[],
    concurrency: number,
    operation: (value: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(values.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await operation(values[index]!);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async baseContext(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ) {
    const conversation = await this.options.client.getConversation(conversationId).catch(() => {
      throw new LocalConfigurationRequestError("Conversation is unavailable", 404, "unavailable");
    });
    const [workspace, members, actor, identity, bindings] = await Promise.all([
      this.options.client.getWorkspace(conversation.workspaceId),
      this.options.client.listWorkspaceMembers(conversation.workspaceId),
      this.options.client.getIdentity(actorIdentityId),
      this.options.client.getIdentity(agentIdentityId),
      this.options.store.listConversationBindings(conversationId),
    ]);
    const actorMembership = members.find(({ identityId }) => identityId === actorIdentityId);
    if (actor.type !== "human" || actor.status !== "active" || actorMembership?.status !== "active"
      || (actorMembership.accessRole !== "owner" && actorMembership.accessRole !== "admin")) {
      throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
    }
    const agentMembership = members.find(({ identityId }) => identityId === agentIdentityId);
    const participant = conversation.participants.find(({ id }) => id === agentIdentityId);
    if (workspace.status !== "active" || identity.status !== "active"
      || (identity.type !== "agent" && identity.type !== "service")
      || agentMembership?.status !== "active" || participant?.status !== "active") {
      throw new LocalConfigurationRequestError(
        "Agent must be an active Conversation participant",
        409,
        "unavailable",
      );
    }
    return { conversation, bindings };
  }

  private async configuredContext(
    conversationId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ) {
    const context = await this.baseContext(conversationId, agentIdentityId, actorIdentityId);
    const [workspaceConfig, agentConfig] = await Promise.all([
      this.options.store.getWorkspaceConfig(context.conversation.workspaceId),
      this.options.store.getWorkspaceAgentConfig(context.conversation.workspaceId, agentIdentityId),
    ]);
    if (!workspaceConfig || !agentConfig || agentConfig.status !== "active"
      || !agentConfig.runtimeAdapter) {
      throw new LocalConfigurationRequestError(
        "Configure the Workspace source and active agent Runtime before replacing",
        409,
        "unavailable",
      );
    }
    const runtime = this.options.runtimes[agentConfig.runtimeAdapter];
    if (!launchableRuntime(runtime)) {
      throw new LocalConfigurationRequestError(
        "Configured agent Runtime is unavailable",
        409,
        "unavailable",
      );
    }
    return {
      ...context,
      workspaceConfig,
      agentConfig,
      runtime,
      ...(await this.resolveWorkingFolderLaunch(workspaceConfig, conversationId)),
    };
  }

  private appendWorkingFolderGuidance(
    personaPrompt: string | undefined,
    guidance: string | undefined,
  ): string | undefined {
    return [personaPrompt, guidance].filter((value): value is string => Boolean(value)).join("\n\n") || undefined;
  }

  private async resolveWorkingFolderLaunch(
    workspaceConfig: LocalWorkspaceConfig,
    conversationId: string,
  ): Promise<{ cwd: string; workingFolderGuidance?: string }> {
    const workspaceRoot = await workspaceDirectory(workspaceConfig.rootUri);
    const folders = await this.options.store.getConversationWorkingFolders(workspaceConfig.workspaceId, conversationId);
    if (folders.length === 0) return { cwd: workspaceRoot };
    if (folders.length > 16 || folders.filter((folder) => folder.primary).length !== 1) {
      throw new LocalConfigurationRequestError("Configured Conversation working folders are unavailable", 409, "unavailable");
    }
    const canonicalPaths = new Set<string>();
    const resolved: Array<{ folder: ConversationWorkingFolder; cwd: string }> = [];
    for (const folder of folders) {
      if (!folder.relativePath || folder.relativePath === "." || isAbsolute(folder.relativePath)
        || folder.relativePath.split(/[\\/]/).includes("..")) {
        throw new LocalConfigurationRequestError("Configured Conversation working folders are unavailable", 409, "unavailable");
      }
      try {
        const selected = await realpath(resolve(workspaceRoot, folder.relativePath));
        if (!(await stat(selected)).isDirectory() || !relativePathWithinWorkspace(workspaceRoot, selected)
          || selected === workspaceRoot || canonicalPaths.has(selected)) {
          throw new Error("invalid working folder");
        }
        canonicalPaths.add(selected);
        resolved.push({ folder, cwd: selected });
      } catch {
        throw new LocalConfigurationRequestError("Configured Conversation working folders are unavailable", 409, "unavailable");
      }
    }
    const primary = resolved.find(({ folder }) => folder.primary);
    if (!primary) {
      throw new LocalConfigurationRequestError("Configured Conversation working folders are unavailable", 409, "unavailable");
    }
    return {
      cwd: primary.cwd,
      workingFolderGuidance: conversationWorkingFolderGuidance(primary.cwd, resolved),
    };
  }

  private async assertBindingsIdle(
    bindings: ConversationAgentBindingRecord[],
    allowUnreachableBindingId?: string,
  ): Promise<void> {
    for (const binding of bindings) {
      if (binding.state === "disabled") continue;
      const runtime = this.options.runtimes[binding.runtimeAdapter];
      if (!runtime) {
        if (binding.id === allowUnreachableBindingId) continue;
        throw new LocalConfigurationRequestError(
          "Conversation agent status is uncertain; retry before changing sessions",
          409,
          "unavailable",
        );
      }
      try {
        if ((await this.runtimeStatus(runtime, binding.runtimeSessionId)) === "working") {
          throw new LocalConfigurationRequestError(
            "Conversation has active agent work; retry when it is idle",
            409,
            "unavailable",
          );
        }
      } catch (error) {
        if (error instanceof LocalConfigurationRequestError) throw error;
        if (binding.id !== allowUnreachableBindingId) {
          throw new LocalConfigurationRequestError(
            "Conversation agent status is uncertain; retry before changing sessions",
            409,
            "unavailable",
          );
        }
        // Explicit replacement may proceed for its unreachable target; the confirmation warns that effects remain.
      }
    }
  }

  private async runtimeStatus(
    runtime: LocalManagedRuntimePort,
    sessionId: string,
  ): Promise<"idle" | "working" | "offline"> {
    return this.withTimeout(runtime.status(sessionId), 2_000, "Runtime status timed out");
  }

  private async stopRuntimeBestEffort(
    runtime: LocalManagedRuntimePort | undefined,
    sessionId: string,
  ): Promise<void> {
    if (!runtime?.stop) return;
    try {
      if ((await this.runtimeStatus(runtime, sessionId)) === "offline") return;
      await this.withTimeout(runtime.stop(sessionId), 15_000, "Runtime stop timed out");
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), milliseconds);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async refreshConversation(conversationId: string): Promise<void> {
    const records = await this.options.store.listConversationBindings(conversationId);
    await Promise.all(records
      .filter((record) => record.state !== "disabled")
      .map(async (record) => {
        let result: AttachmentResult;
        try {
          result = await this.attachBinding(conversationId, record.id);
        } catch {
          result = "failed";
        }
        this.handleAttachmentResult(record, result, "binding_restore");
      }));
  }

  private async attachBinding(conversationId: string, bindingId: string): Promise<AttachmentResult> {
    const lockKey = `relay:${conversationId}`;
    const reserved = await this.exclusive(lockKey, async () => {
      if (this.attachingBindings.has(bindingId)) return false;
      this.attachingBindings.add(bindingId);
      return true;
    });
    if (!reserved) return "lease_unavailable";

    const runtimes = Object.fromEntries(
      Object.entries(this.options.runtimes).filter((entry): entry is [string, AgentRuntimePort] =>
        executableRuntime(entry[1])),
    );
    let restored: RestoredConversationBindings | undefined;
    let runner: ConversationRunner | undefined;
    let ownsStartup = false;
    let attached = false;
    try {
      restored = await restoreConversationBindings({
        client: this.options.client,
        store: this.options.store,
        conversationId,
        bindingIds: [bindingId],
        markConnected: false,
        leaseOwner: this.leaseOwner,
        leaseDurationMs: this.options.bindingLeaseDurationMs,
        statusTimeoutMs: this.options.runtimeStatusTimeoutMs,
        now: this.now,
        runtimes,
      });
      const binding = restored.bindings[0];
      if (!binding) return restored.outcomes.get(bindingId) ?? "failed";
      const recoveryRecord = await this.options.store.getBinding(bindingId);
      if (!recoveryRecord) throw new Error("Agent binding disappeared during attachment");

      ({ runner, ownsStartup } = await this.exclusive(lockKey, async () => {
        let current = this.runners.get(conversationId);
        let created = false;
        if (!current) {
          let resolveReady!: () => void;
          const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
          current = {
            relay: new ConversationRuntimeRelay({
              client: this.options.client,
              conversationId,
              bindings: [binding],
              cursorStore: this.options.store,
              onError: (_binding, error) => this.options.onError?.(error),
            }),
            readiness: "starting",
            ready,
            resolveReady,
            pendingAttaches: new Set(),
            restored: new Map(),
          };
          this.runners.set(conversationId, current);
          created = true;
        }
        if (current.readiness === "stopping") throw new Error("Conversation Relay is stopping");
        current.pendingAttaches.add(binding.participantId);
        return { runner: current, ownsStartup: created };
      }));

      if (ownsStartup) {
        await runner.relay.start();
        attached = true;
      } else {
        await runner.ready;
        if (runner.readiness !== "ready" || this.runners.get(conversationId) !== runner) {
          throw new Error("Conversation Relay did not become ready");
        }
        await runner.relay.attach(binding);
        attached = true;
      }
      if (!await restored.markConnected()) {
        throw new Error("Agent binding changed before Relay attachment completed");
      }

      await this.exclusive(lockKey, async () => {
        if (this.runners.get(conversationId) !== runner || runner!.readiness === "stopping") {
          throw new Error("Conversation Relay ownership changed during attachment");
        }
        runner!.restored.set(binding.participantId, restored!);
        runner!.pendingAttaches.delete(binding.participantId);
        if (ownsStartup) {
          runner!.readiness = "ready";
          runner!.resolveReady();
        }
      });
      restored.startAutoRenew(async () => {
        await this.retireBinding(conversationId, binding.participantId);
        this.scheduleRecovery(recoveryRecord, 0, "binding_lease");
      });
      this.cancelRecovery(bindingId);
      return "attached";
    } catch (error) {
      if (attached && runner) await runner.relay.retire(
        restored?.bindings[0]?.participantId ?? "",
      ).catch(() => undefined);
      let relayToStop: ConversationRuntimeRelay | undefined;
      await this.exclusive(lockKey, async () => {
        if (!runner || this.runners.get(conversationId) !== runner) return;
        const participantId = restored?.bindings[0]?.participantId;
        if (participantId) runner.pendingAttaches.delete(participantId);
        if (ownsStartup || (runner.restored.size === 0 && runner.pendingAttaches.size === 0)) {
          runner.readiness = "stopping";
          runner.resolveReady();
          this.runners.delete(conversationId);
          relayToStop = runner.relay;
        }
      });
      await relayToStop?.stop().catch(() => undefined);
      throw error;
    } finally {
      if (!runner?.restored.has(restored?.bindings[0]?.participantId ?? "")) {
        await restored?.close().catch(() => undefined);
      }
      await this.exclusive(lockKey, async () => { this.attachingBindings.delete(bindingId); });
    }
  }

  private handleAttachmentResult(
    record: ConversationAgentBindingRecord,
    result: AttachmentResult,
    category: LocalAgentHostDiagnosticEvent["category"],
    attempt = 0,
  ): void {
    switch (result) {
      case "attached":
        this.cancelRecovery(record.id);
        this.diagnostic({
          category,
          outcome: category === "binding_lease" ? "reattached" : "attached",
          conversationId: record.conversationId,
          agentIdentityId: record.agentIdentityId,
        });
        return;
      case "runtime_offline":
      case "invalid_binding":
      case "runtime_unavailable":
        this.cancelRecovery(record.id);
        this.diagnostic({
          category,
          outcome: result === "runtime_offline"
            ? "offline"
            : result === "invalid_binding"
              ? "invalid"
              : "uncertain",
          conversationId: record.conversationId,
          agentIdentityId: record.agentIdentityId,
        });
        return;
      case "runtime_uncertain":
      case "lease_unavailable":
      case "failed":
        this.scheduleRecovery(record, attempt, category, result);
        return;
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled attachment result: ${exhaustive}`);
      }
    }
  }

  private scheduleRecovery(
    record: ConversationAgentBindingRecord,
    attempt: number,
    category: LocalAgentHostDiagnosticEvent["category"],
    result: AttachmentResult = "runtime_uncertain",
  ): void {
    if (this.closed || this.quiescing || record.state === "disabled" || this.recoveries.has(record.id)) return;
    const delayMs = this.recoveryBackoffMs[Math.min(attempt, this.recoveryBackoffMs.length - 1)]!;
    const timer = setTimeout(() => {
      this.recoveries.delete(record.id);
      void this.recoverBinding(record, attempt + 1, category).catch(() => {
        this.handleAttachmentResult(record, "failed", category, attempt + 1);
      });
    }, delayMs);
    timer.unref();
    this.recoveries.set(record.id, {
      conversationId: record.conversationId,
      bindingId: record.id,
      agentIdentityId: record.agentIdentityId,
      generation: record.generation,
      attempt,
      timer,
    });
    if (attempt < this.recoveryBackoffMs.length) {
      this.diagnostic({
        category,
        outcome: result === "lease_unavailable" ? "conflict" : result === "failed" ? "failed" : "retrying",
        conversationId: record.conversationId,
        agentIdentityId: record.agentIdentityId,
        attempt: attempt + 1,
      });
    }
  }

  private async recoverBinding(
    expected: ConversationAgentBindingRecord,
    attempt: number,
    category: LocalAgentHostDiagnosticEvent["category"],
  ): Promise<void> {
    if (this.closed || this.quiescing) return;
    const key = this.bindingKey(expected.conversationId, expected.agentIdentityId);
    await this.exclusive(key, async () => {
      if (this.closed || this.quiescing) return;
      const current = await this.options.store.getBinding(expected.id);
      if (!current || current.generation !== expected.generation || current.state === "disabled") {
        this.cancelRecovery(expected.id);
        return;
      }
      if (this.isAttached(current.conversationId, current.agentIdentityId)) {
        this.handleAttachmentResult(current, "attached", category);
        return;
      }
      let result: AttachmentResult;
      try {
        result = await this.attachBinding(current.conversationId, current.id);
      } catch {
        result = "failed";
      }
      this.handleAttachmentResult(current, result, category, attempt);
    });
  }

  private cancelRecovery(bindingId: string): void {
    const recovery = this.recoveries.get(bindingId);
    if (!recovery) return;
    clearTimeout(recovery.timer);
    this.recoveries.delete(bindingId);
  }

  private diagnostic(event: Omit<LocalAgentHostDiagnosticEvent, "timestamp">): void {
    try {
      this.options.onDiagnostic?.({ ...event, timestamp: this.now().toISOString() });
    } catch {
      // Diagnostics must never alter attachment or lease ownership.
    }
  }

  private async retireBinding(conversationId: string, participantId: string): Promise<void> {
    const lockKey = `relay:${conversationId}`;
    const ownership = await this.exclusive(lockKey, async () => {
      const runner = this.runners.get(conversationId);
      if (!runner) return undefined;
      const restored = runner.restored.get(participantId);
      runner.restored.delete(participantId);
      // retire() removes routing synchronously before awaiting only this binding's queue.
      const drained = runner.relay.retire(participantId);
      return { runner, restored, drained };
    });
    if (!ownership) return;
    await ownership.drained;
    await ownership.restored?.close();

    const relayToStop = await this.exclusive(lockKey, async () => {
      const { runner } = ownership;
      if (this.runners.get(conversationId) !== runner
        || runner.restored.size > 0 || runner.pendingAttaches.size > 0) return undefined;
      runner.readiness = "stopping";
      runner.resolveReady();
      this.runners.delete(conversationId);
      return runner.relay;
    });
    await relayToStop?.stop();
  }

  private bindingKey(conversationId: string, agentIdentityId: string): string {
    return `${conversationId}:${agentIdentityId}`;
  }

  private sessionKey(bindingId: string, sessionId: string): string {
    return `${bindingId}:${sessionId}`;
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.pending.set(key, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }

  private audit(event: Omit<LocalControlAuditEvent, "timestamp">): void {
    try {
      this.options.onAudit?.({ ...event, timestamp: this.now().toISOString() });
    } catch {
      // Audit sinks must not affect agent lifecycle.
    }
  }
}
