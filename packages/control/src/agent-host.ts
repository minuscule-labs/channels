import { ChannelClient } from "@minu/channels-core/client";
import {
  ChannelRuntimeRelay,
  LocalRelayDirectory,
  restoreChannelBindings,
  type AgentRuntimePort,
  type ChannelAgentBindingRecord,
  type LocalWorkspaceConfig,
  type RelayBindingStore,
  type RestoredChannelBindings,
  type RelayAgentActivity,
  type WorkspaceAgentConfig,
} from "@minu/channels-relay";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
  }>;
  stop?(sessionId: string): Promise<void>;
}

interface BulkLifecycleTarget {
  identityId: string;
  binding?: ChannelAgentBindingRecord;
  duplicate: boolean;
}

class BulkSnapshotChangedError extends Error {}

interface ChannelRunner {
  relay: ChannelRuntimeRelay;
  /** Relay ownership transitions are serialized per Channel and readiness is explicit. */
  readiness: "starting" | "ready" | "stopping";
  ready: Promise<void>;
  resolveReady(): void;
  pendingAttaches: Set<string>;
  /** One independently renewed lease holder per attached Runtime binding. */
  restored: Map<string, RestoredChannelBindings>;
}

export interface LocalAgentHostOptions {
  client: ChannelClient;
  store: RelayBindingStore;
  runtimes: Readonly<Record<string, LocalManagedRuntimePort>>;
  now?: () => Date;
  leaseOwner?: string;
  stopStartedSessionsOnClose?: boolean;
  bindingLeaseDurationMs?: number;
  runtimeStatusTimeoutMs?: number;
  onAudit?(event: LocalControlAuditEvent): void;
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
    const details = await stat(directory);
    if (!details.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new LocalConfigurationRequestError(
      "Configured Workspace source is not an available directory",
      409,
      "unavailable",
    );
  }
  return directory;
}

export class LocalAgentHost {
  private readonly directory: LocalRelayDirectory;
  private readonly now: () => Date;
  private readonly leaseOwner: string;
  private readonly runners = new Map<string, ChannelRunner>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly attachingBindings = new Set<string>();
  private readonly startedSessions = new Map<string, {
    bindingId: string;
    runtime: LocalManagedRuntimePort;
    sessionId: string;
  }>();
  private closed = false;

  constructor(private readonly options: LocalAgentHostOptions) {
    this.directory = new LocalRelayDirectory(options.client, options.store, options.now);
    this.now = options.now ?? (() => new Date());
    this.leaseOwner = options.leaseOwner ?? `local-agent-host:${process.pid}:${randomUUID()}`;
  }

  get available(): boolean {
    return Object.values(this.options.runtimes).some(launchableRuntime);
  }

  async startAllChannelAgents(
    channelId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]> {
    return this.runBulkLifecycle("start", channelId, actorIdentityId);
  }

  async stopAllChannelAgents(
    channelId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]> {
    return this.runBulkLifecycle("stop", channelId, actorIdentityId);
  }

  async restore(): Promise<void> {
    if (!this.available || this.closed) return;
    const workspaces = await this.options.client.listWorkspaces();
    const bindingGroups = await Promise.all(
      workspaces.map((workspace) => this.options.store.listWorkspaceBindings(workspace.id)),
    );
    const channelIds = [...new Set(bindingGroups.flat()
      .filter((binding) => executableRuntime(this.options.runtimes[binding.runtimeAdapter]))
      .map((binding) => binding.channelId))];
    await Promise.all(channelIds.map((channelId) => this.refreshChannel(channelId).catch((error) => {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    })));
  }

  async startChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    expectedBinding?: null,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(channelId, agentIdentityId), async () => {
      try {
        if (this.closed) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const channel = await this.options.client.getChannel(channelId).catch(() => {
          throw new LocalConfigurationRequestError("Channel is unavailable", 404, "unavailable");
        });
        const [workspace, members, actor, identity, workspaceConfig, agentConfig, bindings] = await Promise.all([
          this.options.client.getWorkspace(channel.workspaceId),
          this.options.client.listWorkspaceMembers(channel.workspaceId),
          this.options.client.getIdentity(actorIdentityId),
          this.options.client.getIdentity(agentIdentityId),
          this.options.store.getWorkspaceConfig(channel.workspaceId),
          this.options.store.getWorkspaceAgentConfig(channel.workspaceId, agentIdentityId),
          this.options.store.listChannelBindings(channelId),
        ]);
        const actorMembership = members.find(({ identityId }) => identityId === actorIdentityId);
        if (actor.type !== "human" || actor.status !== "active" || actorMembership?.status !== "active"
          || (actorMembership.accessRole !== "owner" && actorMembership.accessRole !== "admin")) {
          throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
        }
        const agentMembership = members.find(({ identityId }) => identityId === agentIdentityId);
        const participant = channel.participants.find(({ id }) => id === agentIdentityId);
        if (workspace.status !== "active" || identity.status !== "active"
          || (identity.type !== "agent" && identity.type !== "service")
          || agentMembership?.status !== "active" || participant?.status !== "active") {
          throw new LocalConfigurationRequestError(
            "Agent must be an active Channel participant",
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
            "Agent already has a Channel session; explicit replacement is required",
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
        const cwd = await workspaceDirectory(workspaceConfig.rootUri);
        let session: ManagedRuntimeSession | undefined;
        let bindingId: string | undefined;
        try {
          session = await runtime.start({
            cwd,
            appendSystemPrompt: agentConfig.personaPrompt,
            ...(agentConfig.modelProvider && agentConfig.modelId
              ? { model: { provider: agentConfig.modelProvider, id: agentConfig.modelId } }
              : {}),
            ...(agentConfig.reasoningLevel ? { reasoningLevel: agentConfig.reasoningLevel } : {}),
            ...(agentConfig.skillIds !== undefined ? { skillIds: [...agentConfig.skillIds] } : {}),
          });
          const messages = await this.options.client.listMessages(channelId);
          await this.options.store.setCursor(
            channelId,
            agentIdentityId,
            messages.at(-1)?.sequence ?? 0,
          );
          const binding = await this.directory.bindAgent({
            channelId,
            agentIdentityId,
            runtimeAdapter: agentConfig.runtimeAdapter,
            runtimeSessionId: session.id,
          });
          bindingId = binding.id;
          if (!await this.attachBinding(channelId, binding.id)) {
            throw new Error("Agent binding could not be attached to the Channel Relay");
          }
          this.startedSessions.set(this.sessionKey(binding.id, session.id), {
            bindingId: binding.id,
            runtime,
            sessionId: session.id,
          });
        } catch (error) {
          if (bindingId) {
            await this.options.store.deleteBinding(bindingId).catch(() => undefined);
            await this.retireBinding(channelId, agentIdentityId).catch((restoreError) => {
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
          workspaceId: channel.workspaceId,
          channelId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        const channel = await this.options.client.getChannel(channelId).catch(() => undefined);
        this.audit({
          action: "agent.session.started",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId: channel?.workspaceId,
          channelId,
          targetIdentityId: agentIdentityId,
        });
        throw error;
      }
    });
  }

  async replaceChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    expectedBinding?: Pick<ChannelAgentBindingRecord, "id" | "generation" | "state">,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(channelId, agentIdentityId), async () => {
      let session: ManagedRuntimeSession | undefined;
      let runtime: (AgentRuntimePort & LocalManagedRuntimePort & Required<Pick<LocalManagedRuntimePort, "start">>) | undefined;
      let committed = false;
      let previousRuntime: LocalManagedRuntimePort | undefined;
      let previousSessionId: string | undefined;
      let workspaceId: string | undefined;
      try {
        if (this.closed) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.configuredContext(channelId, agentIdentityId, actorIdentityId);
        workspaceId = context.channel.workspaceId;
        assertModelPolicy(context.workspaceConfig, context.agentConfig);
        const matches = context.bindings.filter((binding) => binding.agentIdentityId === agentIdentityId);
        if (matches.length !== 1) {
          throw new LocalConfigurationRequestError(
            matches.length === 0
              ? "Agent has no Channel session; start it first"
              : "Agent Channel session is uncertain",
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
          appendSystemPrompt: context.agentConfig.personaPrompt,
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
        const messages = await this.options.client.listMessages(channelId);
        await this.options.store.setCursor(
          channelId,
          agentIdentityId,
          messages.at(-1)?.sequence ?? 0,
        );
        await this.retireBinding(channelId, agentIdentityId).catch((error) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
        if (!await this.attachBinding(channelId, replaced.id)) {
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
          channelId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        if (!committed && session && runtime?.stop) {
          await runtime.stop(session.id).catch(() => undefined);
        }
        if (committed && previousSessionId) {
          await this.stopRuntimeBestEffort(previousRuntime, previousSessionId);
          const records = await this.options.store.listChannelBindings(channelId).catch(() => []);
          const binding = records.find(({ agentIdentityId }) => agentIdentityId === agentIdentityId);
          if (binding) this.startedSessions.delete(this.sessionKey(binding.id, previousSessionId));
        }
        this.audit({
          action: "agent.session.replaced",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          channelId,
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

  activity(channelId: string, agentIdentityId: string): RelayAgentActivity | undefined {
    return this.runners.get(channelId)?.relay.activity(agentIdentityId);
  }

  isAttached(channelId: string, agentIdentityId: string): boolean {
    return this.runners.get(channelId)?.restored.has(agentIdentityId) ?? false;
  }

  async reconnectChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(channelId, agentIdentityId), async () => {
      let workspaceId: string | undefined;
      try {
        if (this.closed) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.baseContext(channelId, agentIdentityId, actorIdentityId);
        workspaceId = context.channel.workspaceId;
        const matches = context.bindings.filter(({ agentIdentityId: candidate }) => candidate === agentIdentityId);
        if (matches.length !== 1) {
          throw new LocalConfigurationRequestError("Agent reconnect requires one existing Channel session", 409, "unavailable");
        }
        const binding = matches[0]!;
        if (binding.state === "disabled" || binding.state === "replacing") {
          throw new LocalConfigurationRequestError("Agent session cannot be reconnected from its current state", 409, "unavailable");
        }
        if (this.isAttached(channelId, agentIdentityId)) {
          throw new LocalConfigurationRequestError("Agent session is already connected", 409, "unavailable");
        }
        if (!await this.attachBinding(channelId, binding.id, true)) {
          const current = await this.options.store.getBinding(binding.id);
          throw new LocalConfigurationRequestError(
            current?.state === "offline"
              ? "Existing Runtime session is unreachable; start fresh instead"
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
          channelId,
          targetIdentityId: agentIdentityId,
        });
      } catch (error) {
        this.audit({
          action: "agent.session.reconnected",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          channelId,
          targetIdentityId: agentIdentityId,
        });
        throw error;
      }
    });
  }

  async cancelCurrentChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void> {
    let workspaceId: string | undefined;
    try {
      if (this.closed) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
      const context = await this.baseContext(channelId, agentIdentityId, actorIdentityId);
      workspaceId = context.channel.workspaceId;
      const runner = this.runners.get(channelId);
      if (!runner) {
        throw new LocalConfigurationRequestError("Agent Channel session is unavailable", 409, "unavailable");
      }
      await runner.relay.cancelCurrent(agentIdentityId, actorIdentityId);
      this.audit({
        action: "agent.turn.cancel.requested",
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
        channelId,
        targetIdentityId: agentIdentityId,
      });
    } catch (error) {
      this.audit({
        action: "agent.turn.cancel.requested",
        outcome: "rejected",
        reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
        actorIdentityId,
        workspaceId,
        channelId,
        targetIdentityId: agentIdentityId,
      });
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError(
        "Agent turn could not be canceled",
        409,
        "unavailable",
      );
    }
  }

  async stopChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    expectedBinding?: Pick<ChannelAgentBindingRecord, "id" | "generation" | "state">,
  ): Promise<void> {
    return this.exclusive(this.bindingKey(channelId, agentIdentityId), async () => {
      let workspaceId: string | undefined;
      let committed = false;
      try {
        if (this.closed) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
        const context = await this.baseContext(channelId, agentIdentityId, actorIdentityId);
        workspaceId = context.channel.workspaceId;
        const matches = context.bindings.filter((binding) => binding.agentIdentityId === agentIdentityId);
        if (matches.length !== 1) {
          throw new LocalConfigurationRequestError(
            matches.length === 0 ? "Agent has no Channel session" : "Agent Channel session is uncertain",
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
          throw new LocalConfigurationRequestError("Agent Channel session is already stopped", 409, "unavailable");
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
        await this.retireBinding(channelId, agentIdentityId).catch((error) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
        this.audit({
          action: "agent.session.stopped",
          outcome: "accepted",
          actorIdentityId,
          workspaceId,
          channelId,
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
          channelId,
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
    channelId: string,
    actorIdentityId: string,
  ): Promise<LocalBulkAgentLifecycleResult[]> {
    let workspaceId: string | undefined;
    const aggregateAction = action === "start" ? "agents.bulk-started" : "agents.bulk-stopped";
    const itemAction = action === "start" ? "agent.session.bulk-started" : "agent.session.bulk-stopped";
    try {
      const targets = await this.bulkTargets(channelId, actorIdentityId);
      workspaceId = targets.workspaceId;
      const results = await this.mapBounded(targets.targets, 3, async (target) => {
        let result: LocalBulkAgentLifecycleResult;
        try {
          result = action === "start"
            ? await this.bulkStartOne(channelId, targets.workspaceId, target, actorIdentityId)
            : await this.bulkStopOne(channelId, target, actorIdentityId);
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
          channelId,
          targetIdentityId: target.identityId,
        });
        return result;
      });
      this.audit({
        action: aggregateAction,
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
        channelId,
      });
      return results;
    } catch (error) {
      this.audit({
        action: aggregateAction,
        outcome: "rejected",
        reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
        actorIdentityId,
        workspaceId,
        channelId,
      });
      throw error;
    }
  }

  private async bulkTargets(channelId: string, actorIdentityId: string): Promise<{
    workspaceId: string;
    targets: BulkLifecycleTarget[];
  }> {
    if (this.closed) throw new LocalConfigurationRequestError("Agent host is unavailable", 409, "unavailable");
    const channel = await this.options.client.getChannel(channelId).catch(() => {
      throw new LocalConfigurationRequestError("Channel is unavailable", 404, "unavailable");
    });
    const [workspace, members, actor, bindings] = await Promise.all([
      this.options.client.getWorkspace(channel.workspaceId),
      this.options.client.listWorkspaceMembers(channel.workspaceId),
      this.options.client.getIdentity(actorIdentityId),
      this.options.store.listChannelBindings(channelId),
    ]);
    const actorMembership = members.find(({ identityId }) => identityId === actorIdentityId);
    if (workspace.status !== "active" || actor.type !== "human" || actor.status !== "active"
      || actorMembership?.status !== "active"
      || (actorMembership.accessRole !== "owner" && actorMembership.accessRole !== "admin")) {
      throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
    }
    return {
      workspaceId: channel.workspaceId,
      targets: channel.participants
        .filter((participant) => participant.status === "active"
          && (participant.type === "agent" || participant.type === "service"))
        .map(({ id }) => {
          const matches = bindings.filter(({ agentIdentityId }) => agentIdentityId === id);
          return { identityId: id, binding: matches[0], duplicate: matches.length > 1 };
        }),
    };
  }

  private async bulkStartOne(
    channelId: string,
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
        await this.replaceChannelAgent(channelId, identityId, actorIdentityId, binding);
      } else {
        await this.startChannelAgent(channelId, identityId, actorIdentityId, null);
      }
      return { identityId, outcome: "started" };
    } catch (error) {
      return error instanceof BulkSnapshotChangedError
        ? { identityId, outcome: "skipped", reason: "uncertain" }
        : { identityId, outcome: "failed", reason: "unavailable" };
    }
  }

  private async bulkStopOne(
    channelId: string,
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
      await this.stopChannelAgent(channelId, identityId, actorIdentityId, binding);
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
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ) {
    const channel = await this.options.client.getChannel(channelId).catch(() => {
      throw new LocalConfigurationRequestError("Channel is unavailable", 404, "unavailable");
    });
    const [workspace, members, actor, identity, bindings] = await Promise.all([
      this.options.client.getWorkspace(channel.workspaceId),
      this.options.client.listWorkspaceMembers(channel.workspaceId),
      this.options.client.getIdentity(actorIdentityId),
      this.options.client.getIdentity(agentIdentityId),
      this.options.store.listChannelBindings(channelId),
    ]);
    const actorMembership = members.find(({ identityId }) => identityId === actorIdentityId);
    if (actor.type !== "human" || actor.status !== "active" || actorMembership?.status !== "active"
      || (actorMembership.accessRole !== "owner" && actorMembership.accessRole !== "admin")) {
      throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
    }
    const agentMembership = members.find(({ identityId }) => identityId === agentIdentityId);
    const participant = channel.participants.find(({ id }) => id === agentIdentityId);
    if (workspace.status !== "active" || identity.status !== "active"
      || (identity.type !== "agent" && identity.type !== "service")
      || agentMembership?.status !== "active" || participant?.status !== "active") {
      throw new LocalConfigurationRequestError(
        "Agent must be an active Channel participant",
        409,
        "unavailable",
      );
    }
    return { channel, bindings };
  }

  private async configuredContext(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ) {
    const context = await this.baseContext(channelId, agentIdentityId, actorIdentityId);
    const [workspaceConfig, agentConfig] = await Promise.all([
      this.options.store.getWorkspaceConfig(context.channel.workspaceId),
      this.options.store.getWorkspaceAgentConfig(context.channel.workspaceId, agentIdentityId),
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
      cwd: await workspaceDirectory(workspaceConfig.rootUri),
    };
  }

  private async assertBindingsIdle(
    bindings: ChannelAgentBindingRecord[],
    allowUnreachableBindingId?: string,
  ): Promise<void> {
    for (const binding of bindings) {
      if (binding.state === "disabled") continue;
      const runtime = this.options.runtimes[binding.runtimeAdapter];
      if (!runtime) {
        if (binding.id === allowUnreachableBindingId) continue;
        throw new LocalConfigurationRequestError(
          "Channel agent status is uncertain; retry before changing sessions",
          409,
          "unavailable",
        );
      }
      try {
        if ((await this.runtimeStatus(runtime, binding.runtimeSessionId)) === "working") {
          throw new LocalConfigurationRequestError(
            "Channel has active agent work; retry when it is idle",
            409,
            "unavailable",
          );
        }
      } catch (error) {
        if (error instanceof LocalConfigurationRequestError) throw error;
        if (binding.id !== allowUnreachableBindingId) {
          throw new LocalConfigurationRequestError(
            "Channel agent status is uncertain; retry before changing sessions",
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

  private async refreshChannel(channelId: string): Promise<void> {
    const records = await this.options.store.listChannelBindings(channelId);
    await Promise.all(records
      .filter((record) => record.state !== "disabled")
      .map((record) => this.attachBinding(channelId, record.id)));
  }

  private async attachBinding(channelId: string, bindingId: string, markOfflineOnFailure = false): Promise<boolean> {
    const lockKey = `relay:${channelId}`;
    const reserved = await this.exclusive(lockKey, async () => {
      if (this.attachingBindings.has(bindingId)) return false;
      this.attachingBindings.add(bindingId);
      return true;
    });
    if (!reserved) return false;

    const runtimes = Object.fromEntries(
      Object.entries(this.options.runtimes).filter((entry): entry is [string, AgentRuntimePort] =>
        executableRuntime(entry[1])),
    );
    let restored: RestoredChannelBindings | undefined;
    let runner: ChannelRunner | undefined;
    let ownsStartup = false;
    let attached = false;
    try {
      restored = await restoreChannelBindings({
        client: this.options.client,
        store: this.options.store,
        channelId,
        bindingIds: [bindingId],
        markConnected: false,
        leaseOwner: this.leaseOwner,
        leaseDurationMs: this.options.bindingLeaseDurationMs,
        statusTimeoutMs: this.options.runtimeStatusTimeoutMs,
        runtimes,
      });
      const binding = restored.bindings[0];
      if (!binding) return false;

      ({ runner, ownsStartup } = await this.exclusive(lockKey, async () => {
        let current = this.runners.get(channelId);
        let created = false;
        if (!current) {
          let resolveReady!: () => void;
          const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
          current = {
            relay: new ChannelRuntimeRelay({
              client: this.options.client,
              channelId,
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
          this.runners.set(channelId, current);
          created = true;
        }
        if (current.readiness === "stopping") throw new Error("Channel Relay is stopping");
        current.pendingAttaches.add(binding.participantId);
        return { runner: current, ownsStartup: created };
      }));

      if (ownsStartup) {
        await runner.relay.start();
        attached = true;
      } else {
        await runner.ready;
        if (runner.readiness !== "ready" || this.runners.get(channelId) !== runner) {
          throw new Error("Channel Relay did not become ready");
        }
        await runner.relay.attach(binding);
        attached = true;
      }
      if (!await restored.markConnected()) {
        throw new Error("Agent binding changed before Relay attachment completed");
      }

      await this.exclusive(lockKey, async () => {
        if (this.runners.get(channelId) !== runner || runner!.readiness === "stopping") {
          throw new Error("Channel Relay ownership changed during attachment");
        }
        runner!.restored.set(binding.participantId, restored!);
        runner!.pendingAttaches.delete(binding.participantId);
        if (ownsStartup) {
          runner!.readiness = "ready";
          runner!.resolveReady();
        }
      });
      restored.startAutoRenew(async () => {
        await this.retireBinding(channelId, binding.participantId);
        this.options.onError?.(new Error(`Agent host lease was lost for binding ${binding.participantId}`));
      });
      return true;
    } catch (error) {
      if (markOfflineOnFailure) await restored?.markOffline().catch(() => undefined);
      if (attached && runner) await runner.relay.retire(
        restored?.bindings[0]?.participantId ?? "",
      ).catch(() => undefined);
      let relayToStop: ChannelRuntimeRelay | undefined;
      await this.exclusive(lockKey, async () => {
        if (!runner || this.runners.get(channelId) !== runner) return;
        const participantId = restored?.bindings[0]?.participantId;
        if (participantId) runner.pendingAttaches.delete(participantId);
        if (ownsStartup || (runner.restored.size === 0 && runner.pendingAttaches.size === 0)) {
          runner.readiness = "stopping";
          runner.resolveReady();
          this.runners.delete(channelId);
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

  private async retireBinding(channelId: string, participantId: string): Promise<void> {
    const lockKey = `relay:${channelId}`;
    const ownership = await this.exclusive(lockKey, async () => {
      const runner = this.runners.get(channelId);
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
      if (this.runners.get(channelId) !== runner
        || runner.restored.size > 0 || runner.pendingAttaches.size > 0) return undefined;
      runner.readiness = "stopping";
      runner.resolveReady();
      this.runners.delete(channelId);
      return runner.relay;
    });
    await relayToStop?.stop();
  }

  private bindingKey(channelId: string, agentIdentityId: string): string {
    return `${channelId}:${agentIdentityId}`;
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
