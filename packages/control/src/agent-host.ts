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
  type WorkspaceAgentConfig,
} from "@minu/channels-relay";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalConfigurationRequestError } from "./configuration.ts";
import type { LocalControlRuntimePort } from "./server.ts";
import type { LocalAgentRuntimeOptions, LocalReasoningLevel } from "./contracts.ts";
import type { LocalControlAuditEvent } from "./session.ts";

export interface ManagedRuntimeStartConfig {
  cwd: string;
  appendSystemPrompt?: string;
  model?: { provider: string; id: string };
  reasoningLevel?: LocalReasoningLevel;
}

export interface ManagedRuntimeSession {
  id: string;
}

export interface LocalManagedRuntimePort extends LocalControlRuntimePort, Partial<Omit<AgentRuntimePort, "status">> {
  start?(config: ManagedRuntimeStartConfig): Promise<ManagedRuntimeSession>;
  capabilities?(config?: { cwd?: string }): Promise<{
    models: Array<Omit<LocalAgentRuntimeOptions["models"][number], "enabled">>;
    reasoningLevels: LocalAgentRuntimeOptions["reasoningLevels"];
  }>;
  stop?(sessionId: string): Promise<void>;
}

interface ChannelRunner {
  relay: ChannelRuntimeRelay;
  restored: RestoredChannelBindings;
}

export interface LocalAgentHostOptions {
  client: ChannelClient;
  store: RelayBindingStore;
  runtimes: Readonly<Record<string, LocalManagedRuntimePort>>;
  now?: () => Date;
  leaseOwner?: string;
  stopStartedSessionsOnClose?: boolean;
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
  return /model|reasoning|thinking/i.test(message)
    ? "Configured agent model or reasoning is unavailable; update the launch profile and retry"
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
  ): Promise<void> {
    return this.exclusive(channelId, async () => {
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
        await this.assertBindingsIdle(bindings);
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
          await this.refreshChannelOnce(channelId);
          this.startedSessions.set(binding.id, {
            bindingId: binding.id,
            runtime,
            sessionId: session.id,
          });
        } catch (error) {
          if (bindingId) {
            await this.options.store.deleteBinding(bindingId).catch(() => undefined);
            await this.refreshChannelOnce(channelId).catch((restoreError) => {
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
  ): Promise<void> {
    return this.exclusive(channelId, async () => {
      let session: ManagedRuntimeSession | undefined;
      let runtime: (AgentRuntimePort & LocalManagedRuntimePort & Required<Pick<LocalManagedRuntimePort, "start">>) | undefined;
      let committed = false;
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
        await this.assertBindingsIdle(context.bindings, previous.id);
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
        });
        const replaced = await this.directory.replaceSession({
          bindingId: previous.id,
          expectedGeneration: previous.generation,
          runtimeAdapter: context.agentConfig.runtimeAdapter!,
          runtimeSessionId: session.id,
        });
        committed = true;
        const messages = await this.options.client.listMessages(channelId);
        await this.options.store.setCursor(
          channelId,
          agentIdentityId,
          messages.at(-1)?.sequence ?? 0,
        );
        await this.refreshChannelOnce(channelId).catch((error) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
        await this.stopRuntimeBestEffort(
          this.options.runtimes[previous.runtimeAdapter],
          previous.runtimeSessionId,
        );
        this.startedSessions.set(replaced.id, {
          bindingId: replaced.id,
          runtime,
          sessionId: session.id,
        });
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
        this.audit({
          action: "agent.session.replaced",
          outcome: "rejected",
          reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
          actorIdentityId,
          workspaceId,
          channelId,
          targetIdentityId: agentIdentityId,
        });
        if (error instanceof LocalConfigurationRequestError) throw error;
        throw new LocalConfigurationRequestError(
          launchFailureMessage(error, "Agent session could not be replaced"),
          409,
          "unavailable",
        );
      }
    });
  }

  async stopChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void> {
    return this.exclusive(channelId, async () => {
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
        if (target.state === "disabled") {
          throw new LocalConfigurationRequestError("Agent Channel session is already stopped", 409, "unavailable");
        }
        await this.assertBindingsIdle(
          context.bindings.filter((binding) => binding.id !== target.id),
        );
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
        this.startedSessions.delete(target.id);
        await this.refreshChannelOnce(channelId).catch((error) => {
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
        if (error instanceof LocalConfigurationRequestError) throw error;
        throw new LocalConfigurationRequestError("Agent session could not be stopped", 409, "unavailable");
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const runners = [...this.runners.values()];
    this.runners.clear();
    await Promise.allSettled(runners.map(async ({ relay, restored }) => {
      await relay.stop();
      await restored.close();
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
    return this.exclusive(channelId, () => this.refreshChannelOnce(channelId));
  }

  private async refreshChannelOnce(channelId: string): Promise<void> {
    const previous = this.runners.get(channelId);
    if (previous) {
      this.runners.delete(channelId);
      await previous.relay.stop();
      await previous.restored.close();
    }
    const runtimes = Object.fromEntries(
      Object.entries(this.options.runtimes).filter((entry): entry is [string, AgentRuntimePort] =>
        executableRuntime(entry[1])),
    );
    const restored = await restoreChannelBindings({
      client: this.options.client,
      store: this.options.store,
      channelId,
      leaseOwner: this.leaseOwner,
      runtimes,
    });
    if (restored.bindings.length === 0) {
      await restored.close();
      return;
    }
    const relay = new ChannelRuntimeRelay({
      client: this.options.client,
      channelId,
      bindings: restored.bindings,
      cursorStore: this.options.store,
      onError: (_binding, error) => this.options.onError?.(error),
    });
    try {
      await relay.start();
    } catch (error) {
      await restored.close();
      throw error;
    }
    const runner = { relay, restored };
    this.runners.set(channelId, runner);
    restored.startAutoRenew(async () => {
      if (this.runners.get(channelId) !== runner) return;
      this.runners.delete(channelId);
      await relay.stop();
      this.options.onError?.(new Error(`Agent host lease was lost for Channel ${channelId}`));
    });
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
