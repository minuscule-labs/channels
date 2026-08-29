import { ChannelClient } from "@minu/channels-core/client";
import {
  ChannelRuntimeRelay,
  LocalRelayDirectory,
  restoreChannelBindings,
  type AgentRuntimePort,
  type RelayBindingStore,
  type RestoredChannelBindings,
} from "@minu/channels-relay";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalConfigurationRequestError } from "./configuration.ts";
import type { LocalControlRuntimePort } from "./server.ts";
import type { LocalControlAuditEvent } from "./session.ts";

export interface ManagedRuntimeStartConfig {
  cwd: string;
  appendSystemPrompt?: string;
}

export interface ManagedRuntimeSession {
  id: string;
}

export interface LocalManagedRuntimePort extends LocalControlRuntimePort, Partial<Omit<AgentRuntimePort, "status">> {
  start?(config: ManagedRuntimeStartConfig): Promise<ManagedRuntimeSession>;
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
          throw new LocalConfigurationRequestError("Agent session could not be started", 409, "unavailable");
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
