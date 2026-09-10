import { createResourceId, type ChannelClient, type ChannelCursorStore } from "@minu/channels-core";
import type { AgentChannelBinding, AgentRuntimePort, WakePolicy } from "./relay.ts";

export interface RuntimeModelRef {
  provider: string;
  id: string;
}

export interface LocalWorkspaceConfig {
  workspaceId: string;
  rootUri: string;
  notesFolderId?: string;
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
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export type ChannelAgentBindingState = "connected" | "offline" | "replacing" | "disabled";

export interface ChannelAgentBindingRecord {
  id: string;
  workspaceAgentConfigId: string;
  workspaceId: string;
  channelId: string;
  agentIdentityId: string;
  executionEnvironmentId?: string;
  runtimeAdapter: string;
  runtimeSessionId: string;
  generation: number;
  state: ChannelAgentBindingState;
  wakePolicy: WakePolicy;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelayBindingStore extends ChannelCursorStore {
  putWorkspaceConfig(config: LocalWorkspaceConfig): Promise<LocalWorkspaceConfig>;
  getWorkspaceConfig(workspaceId: string): Promise<LocalWorkspaceConfig | undefined>;
  putAgentConfig(config: WorkspaceAgentConfig): Promise<WorkspaceAgentConfig>;
  getAgentConfig(configId: string): Promise<WorkspaceAgentConfig | undefined>;
  getWorkspaceAgentConfig(
    workspaceId: string,
    agentIdentityId: string,
  ): Promise<WorkspaceAgentConfig | undefined>;
  listWorkspaceAgentConfigs(workspaceId: string): Promise<WorkspaceAgentConfig[]>;
  putBinding(binding: ChannelAgentBindingRecord): Promise<ChannelAgentBindingRecord>;
  getBinding(bindingId: string): Promise<ChannelAgentBindingRecord | undefined>;
  deleteBinding(bindingId: string): Promise<void>;
  listChannelBindings(channelId: string): Promise<ChannelAgentBindingRecord[]>;
  listWorkspaceBindings(workspaceId: string): Promise<ChannelAgentBindingRecord[]>;
  acquireBindingLease(
    bindingId: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined>;
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
    state: ChannelAgentBindingState,
    lastVerifiedAt: string | undefined,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined>;
  replaceBindingSession(
    bindingId: string,
    expectedGeneration: number,
    runtimeAdapter: string,
    runtimeSessionId: string,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined>;
  disableBinding(
    bindingId: string,
    expectedGeneration: number,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined>;
  close?(): Promise<void> | void;
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

function copyBinding(binding: ChannelAgentBindingRecord): ChannelAgentBindingRecord {
  return { ...binding };
}

export class InMemoryRelayBindingStore implements RelayBindingStore {
  private readonly workspaceConfigs = new Map<string, LocalWorkspaceConfig>();
  private readonly agentConfigs = new Map<string, WorkspaceAgentConfig>();
  private readonly bindings = new Map<string, ChannelAgentBindingRecord>();
  private readonly cursors = new Map<string, number>();

  async putWorkspaceConfig(config: LocalWorkspaceConfig): Promise<LocalWorkspaceConfig> {
    this.workspaceConfigs.set(config.workspaceId, copyWorkspaceConfig(config));
    return copyWorkspaceConfig(config);
  }

  async getWorkspaceConfig(workspaceId: string): Promise<LocalWorkspaceConfig | undefined> {
    const config = this.workspaceConfigs.get(workspaceId);
    return config ? copyWorkspaceConfig(config) : undefined;
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

  async putBinding(binding: ChannelAgentBindingRecord): Promise<ChannelAgentBindingRecord> {
    if (this.bindings.has(binding.id)) throw new Error("Channel agent binding id already exists");
    const duplicate = [...this.bindings.values()].find(
      (candidate) => candidate.id !== binding.id
        && candidate.workspaceId === binding.workspaceId
        && candidate.channelId === binding.channelId
        && candidate.agentIdentityId === binding.agentIdentityId,
    );
    if (duplicate) throw new Error("Channel agent binding already exists");
    const sessionOwner = [...this.bindings.values()].find(
      (candidate) => candidate.id !== binding.id
        && candidate.runtimeAdapter === binding.runtimeAdapter
        && candidate.runtimeSessionId === binding.runtimeSessionId
        && candidate.state !== "disabled",
    );
    if (sessionOwner) throw new Error("Runtime session is already bound");
    this.bindings.set(binding.id, copyBinding(binding));
    return copyBinding(binding);
  }

  async getBinding(bindingId: string): Promise<ChannelAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    return binding ? copyBinding(binding) : undefined;
  }

  async deleteBinding(bindingId: string): Promise<void> {
    this.bindings.delete(bindingId);
  }

  async listChannelBindings(channelId: string): Promise<ChannelAgentBindingRecord[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.channelId === channelId)
      .map(copyBinding);
  }

  async listWorkspaceBindings(workspaceId: string): Promise<ChannelAgentBindingRecord[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.workspaceId === workspaceId)
      .map(copyBinding);
  }

  async acquireBindingLease(
    bindingId: string,
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
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
    state: ChannelAgentBindingState,
    lastVerifiedAt: string | undefined,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== generation || binding.leaseOwner !== leaseOwner
      || !binding.leaseExpiresAt || binding.leaseExpiresAt <= updatedAt) {
      return undefined;
    }
    binding.state = state;
    if (lastVerifiedAt) binding.lastVerifiedAt = lastVerifiedAt;
    binding.updatedAt = updatedAt;
    return copyBinding(binding);
  }

  async replaceBindingSession(
    bindingId: string,
    expectedGeneration: number,
    runtimeAdapter: string,
    runtimeSessionId: string,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== expectedGeneration) return undefined;
    const sessionOwner = [...this.bindings.values()].find(
      (candidate) => candidate.id !== bindingId
        && candidate.runtimeAdapter === runtimeAdapter
        && candidate.runtimeSessionId === runtimeSessionId
        && candidate.state !== "disabled",
    );
    if (sessionOwner) throw new Error("Runtime session is already bound");
    binding.runtimeAdapter = runtimeAdapter;
    binding.runtimeSessionId = runtimeSessionId;
    binding.generation += 1;
    // Remain visibly uncertain until the new session is leased, verified, and attached.
    binding.state = "replacing";
    delete binding.leaseOwner;
    delete binding.leaseExpiresAt;
    delete binding.lastVerifiedAt;
    binding.updatedAt = updatedAt;
    return copyBinding(binding);
  }

  async getCursor(channelId: string, participantId: string): Promise<number> {
    return this.cursors.get(`${channelId}:${participantId}`) ?? 0;
  }

  async setCursor(channelId: string, participantId: string, sequence: number): Promise<void> {
    const key = `${channelId}:${participantId}`;
    this.cursors.set(key, Math.max(this.cursors.get(key) ?? 0, sequence));
  }

  async disableBinding(
    bindingId: string,
    expectedGeneration: number,
    updatedAt: string,
  ): Promise<ChannelAgentBindingRecord | undefined> {
    const binding = this.bindings.get(bindingId);
    if (!binding || binding.generation !== expectedGeneration) return undefined;
    binding.generation += 1;
    binding.state = "disabled";
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
    private readonly client: ChannelClient,
    private readonly store: RelayBindingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async configureWorkspace(input: {
    workspaceId: string;
    rootUri: string;
    notesFolderId?: string | null;
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
      status: input.status ?? existing?.status ?? "active",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  async bindAgent(input: {
    channelId: string;
    agentIdentityId: string;
    runtimeAdapter: string;
    runtimeSessionId: string;
    wakePolicy?: WakePolicy;
  }): Promise<ChannelAgentBindingRecord> {
    if (!input.runtimeAdapter.trim() || !input.runtimeSessionId.trim()) {
      throw new Error("Runtime adapter and session id are required");
    }
    const channel = await this.client.getChannel(input.channelId);
    const participant = channel.participants.find(({ id }) => id === input.agentIdentityId);
    if (!participant || (participant.type !== "agent" && participant.type !== "service")) {
      throw new Error("Agent must participate in the Channel");
    }
    const config = await this.store.getWorkspaceAgentConfig(
      channel.workspaceId,
      input.agentIdentityId,
    );
    if (!config || config.status !== "active") {
      throw new Error("Active private Workspace agent configuration is required");
    }
    const existing = (await this.store.listChannelBindings(input.channelId))
      .find(({ agentIdentityId }) => agentIdentityId === input.agentIdentityId);
    if (existing) throw new Error("Channel agent binding already exists; replace it explicitly");
    const timestamp = this.now().toISOString();
    return this.store.putBinding({
      id: createResourceId("binding"),
      workspaceAgentConfigId: config.id,
      workspaceId: channel.workspaceId,
      channelId: input.channelId,
      agentIdentityId: input.agentIdentityId,
      runtimeAdapter: input.runtimeAdapter,
      runtimeSessionId: input.runtimeSessionId,
      generation: 1,
      state: "connected",
      wakePolicy: input.wakePolicy ?? "mentions",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async replaceSession(input: {
    bindingId: string;
    expectedGeneration: number;
    runtimeAdapter: string;
    runtimeSessionId: string;
  }): Promise<ChannelAgentBindingRecord> {
    const replaced = await this.store.replaceBindingSession(
      input.bindingId,
      input.expectedGeneration,
      input.runtimeAdapter,
      input.runtimeSessionId,
      this.now().toISOString(),
    );
    if (!replaced) throw new Error("Binding generation changed; reload before replacing the session");
    return replaced;
  }
}

export interface RestoreChannelBindingsOptions {
  client: ChannelClient;
  store: RelayBindingStore;
  channelId: string;
  /** Restore only these records when attaching one runner to an already-live Relay. */
  bindingIds?: readonly string[];
  /** Defer connected state until the caller has completed Relay attachment. */
  markConnected?: boolean;
  leaseOwner: string;
  runtimes: Readonly<Record<string, AgentRuntimePort>>;
  leaseDurationMs?: number;
  now?: () => Date;
}

export class RestoredChannelBindings {
  readonly bindings: AgentChannelBinding[];
  private closed = false;
  private renewalTimer: NodeJS.Timeout | undefined;
  private renewalActive = false;

  constructor(
    bindings: AgentChannelBinding[],
    private readonly records: ChannelAgentBindingRecord[],
    private readonly store: RelayBindingStore,
    private readonly leaseOwner: string,
    private readonly leaseDurationMs: number,
    private readonly now: () => Date,
  ) {
    this.bindings = bindings;
  }

  async markConnected(): Promise<boolean> {
    if (this.closed) return false;
    const timestamp = this.now().toISOString();
    const results = await Promise.all(this.records.map((record) =>
      this.store.updateBindingState(
        record.id,
        record.generation,
        this.leaseOwner,
        "connected",
        timestamp,
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
    if (this.closed) throw new Error("Channel bindings are closed");
    if (this.renewalTimer || this.records.length === 0) return;
    const intervalMs = Math.max(1, Math.floor(this.leaseDurationMs / 3));
    this.renewalTimer = setInterval(() => {
      if (this.renewalActive || this.closed) return;
      this.renewalActive = true;
      void this.renew().then(async (renewed) => {
        if (!renewed && !this.closed) {
          if (this.renewalTimer) clearInterval(this.renewalTimer);
          this.renewalTimer = undefined;
          await Promise.resolve(onLeaseLost()).catch(() => undefined);
        }
      }).catch(async () => {
        if (!this.closed) {
          if (this.renewalTimer) clearInterval(this.renewalTimer);
          this.renewalTimer = undefined;
          await Promise.resolve(onLeaseLost()).catch(() => undefined);
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

export async function restoreChannelBindings(
  options: RestoreChannelBindingsOptions,
): Promise<RestoredChannelBindings> {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError("leaseDurationMs must be a positive integer");
  }
  const now = options.now ?? (() => new Date());
  const channel = await options.client.getChannel(options.channelId);
  const [candidates, workspaceMembers, workspaceConfig] = await Promise.all([
    options.store.listChannelBindings(options.channelId),
    options.client.listWorkspaceMembers(channel.workspaceId),
    options.store.getWorkspaceConfig(channel.workspaceId),
  ]);
  if (!workspaceConfig) throw new Error("Private Workspace configuration is required");
  const bindings: AgentChannelBinding[] = [];
  const records: ChannelAgentBindingRecord[] = [];

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
    if (!leased) continue;
    const release = async () => options.store.releaseBindingLease(
      leased.id,
      leased.generation,
      options.leaseOwner,
    );
    const [config, identity] = await Promise.all([
      options.store.getAgentConfig(leased.workspaceAgentConfigId),
      options.client.getIdentity(leased.agentIdentityId).catch(() => undefined),
    ]);
    const participant = channel.participants.find(({ id }) => id === leased.agentIdentityId);
    const member = workspaceMembers.find(({ identityId }) => identityId === leased.agentIdentityId);
    if (leased.workspaceId !== channel.workspaceId || !participant || !member
      || member.status !== "active" || !identity || identity.status !== "active"
      || (identity.type !== "agent" && identity.type !== "service")
      || !config || config.status !== "active" || config.workspaceId !== leased.workspaceId
      || config.agentIdentityId !== leased.agentIdentityId) {
      await release();
      continue;
    }
    const runtime = options.runtimes[leased.runtimeAdapter];
    let reachable = false;
    if (runtime) {
      try {
        reachable = (await runtime.status(leased.runtimeSessionId)) !== "offline";
      } catch {
        reachable = false;
      }
    }
    const verifiedAt = now().toISOString();
    if (!runtime || !reachable) {
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
    const connected = options.markConnected === false
      ? leased
      : await options.store.updateBindingState(
        leased.id,
        leased.generation,
        options.leaseOwner,
        "connected",
        verifiedAt,
        verifiedAt,
      );
    if (!connected) {
      await release();
      continue;
    }
    records.push(connected);
    bindings.push({
      participantId: connected.agentIdentityId,
      sessionId: connected.runtimeSessionId,
      runtime,
      wakePolicy: connected.wakePolicy,
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
    });
  }

  return new RestoredChannelBindings(
    bindings,
    records,
    options.store,
    options.leaseOwner,
    leaseDurationMs,
    now,
  );
}
