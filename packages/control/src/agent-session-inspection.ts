import type { ConversationClient } from "@minu/channels-core/client";
import type { ConversationAgentBindingRecord, RelayBindingStore, RuntimeSessionHistoryRecord, WorkspaceAgentConfig } from "@minu/channels-relay";
import { authorizeDiagnosticAccess } from "./agent-diagnostic-reads.ts";
import { LocalConfigurationRequestError } from "./configuration.ts";
import { safeSessionEvents } from "./agent-session-events.ts";
import { LOCAL_CONTROL_PROTOCOL_VERSION, type LocalAgentSessionInspection, type LocalAgentSessionEvents, type LocalRuntimeSessionProfile, type LocalReasoningLevel } from "./contracts.ts";

type Directory = Pick<ConversationClient, "getConversation" | "getWorkspace" | "listWorkspaceMembers" | "getIdentity">;
export interface SessionProfilePort {
  inspectSessionProfile?(id: string, owner: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  inspectSessionEvents?(id: string, owner: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}
type Store = Pick<RelayBindingStore, "getSessionInspectionRecords" | "getWorkspaceAgentConfig">;
const unavailable = () => new LocalConfigurationRequestError("Not found", 404, "unavailable");
const id = (value: unknown, max = 256): value is string => typeof value === "string" && value.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/.test(value) && !value.includes("..") && !value.includes("://") && !/^[a-zA-Z]:\//.test(value);
const time = (value: unknown): value is string => typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const levels: readonly LocalReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const number = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Independent allowlist at the adapter boundary, without depending on an unmerged Runtime package. */
export function safeSessionProfile(input: unknown): LocalRuntimeSessionProfile | undefined {
  const raw = object(input), model = object(raw.model), reasoning = object(raw.reasoning), skills = object(raw.skills);
  if (raw.version !== 1 || !time(raw.capturedAt)) return undefined;
  const profile: LocalRuntimeSessionProfile = { version: 1, capturedAt: raw.capturedAt,
    model: model.status === "verified" && id(model.provider, 100) && id(model.id, 300) ? { status: "verified", provider: model.provider, id: model.id } : { status: "not_verified" },
    reasoning: reasoning.status === "verified" && levels.includes(reasoning.level as LocalReasoningLevel) ? { status: "verified", level: reasoning.level as LocalReasoningLevel } : { status: "not_verified" },
    skills: { status: "not_verified" },
  };
  if (skills.status === "verified" && Array.isArray(skills.commandIds) && typeof skills.complete === "boolean") {
    const ids = skills.commandIds.slice(0, 64).filter((value): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value));
    profile.skills = { status: "verified", commandIds: [...new Set(ids)], complete: skills.complete && skills.commandIds.length <= 64 && ids.length === skills.commandIds.length };
  }
  return Buffer.byteLength(JSON.stringify(profile)) <= 16 * 1024 ? profile : undefined;
}
function savedProfile(config: WorkspaceAgentConfig | undefined): LocalAgentSessionInspection["saved"] {
  if (!config) return { status: "unconfigured" };
  if ((config.runtimeAdapter !== undefined && !id(config.runtimeAdapter, 100))
    || Boolean(config.modelProvider) !== Boolean(config.modelId)
    || (config.modelProvider !== undefined && (!id(config.modelProvider, 100) || !id(config.modelId, 300)))
    || (config.reasoningLevel !== undefined && !levels.includes(config.reasoningLevel))
    || (config.skillIds !== undefined && !Array.isArray(config.skillIds))) return { status: "unavailable" };
  const skills = config.skillIds?.slice(0, 64).filter(value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value)) ?? [];
  return { status: "available", profile: {
    ...(time(config.updatedAt) ? { updatedAt: config.updatedAt } : {}),
    ...(config.runtimeAdapter ? { adapter: config.runtimeAdapter } : {}),
    ...(config.modelProvider && config.modelId ? { model: { provider: config.modelProvider, id: config.modelId } } : {}),
    ...(config.reasoningLevel ? { reasoningLevel: config.reasoningLevel } : {}),
    skills: { selection: config.skillIds === undefined ? "default" : "explicit", ids: skills, complete: !config.skillIds || skills.length === config.skillIds.length },
    ...(number(config.recentContextTokens) ? { recentContextTokens: config.recentContextTokens } : {}),
    ...(number(config.recentContextMessages) ? { recentContextMessages: config.recentContextMessages } : {}),
    ...(number(config.handoffSummaryTokens) ? { handoffSummaryTokens: config.handoffSummaryTokens } : {}),
  } };
}
function bindingFence(binding: ConversationAgentBindingRecord | undefined) {
  return binding && JSON.stringify([binding.workspaceId, binding.conversationId, binding.agentIdentityId, binding.id, binding.generation,
    binding.runtimeAdapter, binding.runtimeSessionId, binding.runtimeOwnerId, binding.state]);
}

function activationFence(row: RuntimeSessionHistoryRecord | undefined) {
  return row && JSON.stringify([row.id, row.workspaceId, row.conversationId, row.agentIdentityId, row.bindingId, row.bindingGeneration,
    row.runtimeAdapter, row.mapping, row.managedSessionId, row.runtimeOwnerId, row.legacyRuntimeSessionRef, row.state,
    row.origin, row.contextMode, row.conversationSequenceAtActivation, row.activatedAt]);
}

/** No Runtime creation/discovery, transcript/manifest access, cursor inference, lifecycle locks or writes. */
export class LocalAgentSessionInspections {
  private reading = new Set<string>();
  constructor(private options: { client: Directory; store: Store; runtimes: Readonly<Record<string, SessionProfilePort>>; now?: () => Date }) {}
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private async authorize(conversationId: string, identityId: string, actor: string) {
    if (![conversationId, identityId, actor].every(value => /^[a-zA-Z0-9_-]{1,256}$/.test(value))) throw unavailable();
    const access = await authorizeDiagnosticAccess(this.options.client, conversationId, actor);
    if (!access.canViewDiagnostics || !access.conversation.participants.some(value => value.id === identityId && (value.type === "agent" || value.type === "service"))) throw unavailable();
    return access.conversation;
  }
  async read(conversationId: string, identityId: string, actor: string): Promise<LocalAgentSessionInspection> {
    const conversation = await this.authorize(conversationId, identityId, actor);
    const base = (): LocalAgentSessionInspection => ({ protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId, participantIdentityId: identityId,
      capturedAt: this.now(), availability: "unavailable", running: { status: "not_verified" }, saved: { status: "unavailable" }, latestStart: "not_verified", lastStopBoundary: "not_recorded" });
    const key = JSON.stringify([conversation.workspaceId, conversationId, identityId]);
    if (this.reading.has(key) || this.reading.size >= 16) { await this.authorize(conversationId, identityId, actor); return base(); }
    this.reading.add(key);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = (async () => {
      try {
        const result = base();
        const before = await this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, identityId);
        controller.signal.throwIfAborted();
        const config = await this.options.store.getWorkspaceAgentConfig(conversation.workspaceId, identityId);
        result.saved = config && (config.workspaceId !== conversation.workspaceId || config.agentIdentityId !== identityId) ? { status: "unavailable" } : savedProfile(config);
        controller.signal.throwIfAborted();
        if (before.bindings.length > 1) return { ...result, availability: "conflict" as const };
        const binding = before.bindings[0];
        const activation = before.activation;
        if (!binding) result.availability = "unbound";
        else if (binding.workspaceId !== conversation.workspaceId || binding.conversationId !== conversationId || binding.agentIdentityId !== identityId) return result;
        else {
          const matches = activation && activation.state === "active" && activation.workspaceId === binding.workspaceId
            && activation.conversationId === conversationId && activation.agentIdentityId === identityId && activation.bindingId === binding.id
            && activation.bindingGeneration === binding.generation && activation.runtimeAdapter === binding.runtimeAdapter
            && (activation.mapping === "managed" ? activation.managedSessionId === binding.runtimeSessionId && activation.runtimeOwnerId === binding.runtimeOwnerId
              : activation.mapping === "legacy_unmapped" && binding.runtimeOwnerId === undefined && activation.legacyRuntimeSessionRef === binding.runtimeSessionId);
          if (!matches) return result;
          const managed = activation.mapping === "managed" && Boolean(binding.runtimeOwnerId);
          if (!["connected", "sleeping", "waking", "offline", "replacing", "stopping", "paused", "disabled"].includes(binding.state)
            || (activation.contextMode === "fresh" && !number(activation.conversationSequenceAtActivation))) return result;
          result.availability = managed ? "available" : "legacy";
          const origins = ["started", "resumed", "forked", "restored", "attached", "migrated"] as const;
          result.recorded = { bindingState: binding.state,
            origin: origins.includes(activation.origin) ? activation.origin : "unknown",
            ...(id(binding.runtimeAdapter, 100) ? { adapter: binding.runtimeAdapter } : {}),
            ...(managed && ["fresh", "with_context"].includes(activation.contextMode) ? { contextMode: activation.contextMode } : {}),
            ...(managed && number(activation.conversationSequenceAtActivation) ? { activationSequence: activation.conversationSequenceAtActivation } : {}),
            ...(time(activation.activatedAt) ? { activatedAt: activation.activatedAt } : {}),
          };
          const runtime = this.options.runtimes[binding.runtimeAdapter];
          if (managed && !["sleeping", "waking", "offline", "replacing", "stopping", "disabled"].includes(binding.state) && runtime?.inspectSessionProfile) {
            try {
              const raw = await runtime.inspectSessionProfile(binding.runtimeSessionId, binding.runtimeOwnerId!, { signal: controller.signal });
              controller.signal.throwIfAborted();
              const profile = safeSessionProfile(raw);
              if (profile) result.running = { status: "available", profile };
            } catch { controller.signal.throwIfAborted(); }
          }
        }
        controller.signal.throwIfAborted();
        const after = await this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, identityId);
        controller.signal.throwIfAborted();
        if (after.bindings.length !== before.bindings.length || bindingFence(after.bindings[0]) !== bindingFence(binding)
          || activationFence(after.activation) !== activationFence(activation)) return { ...base(), availability: "changed" as const };
        return { ...result, capturedAt: this.now() };
      } finally { this.reading.delete(key); }
    })();
    let result: LocalAgentSessionInspection;
    try {
      result = await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Session inspection unavailable")); }, 2000);
      })]);
    } catch { result = base(); }
    finally { clearTimeout(timer); }
    await this.authorize(conversationId, identityId, actor);
    return result;
  }

  /** Separate event projection: no saved configuration, raw logs, report inclusion or background subscription. */
  async events(conversationId: string, identityId: string, actor: string, options: { signal?: AbortSignal } = {}): Promise<LocalAgentSessionEvents> {
    const conversation = await this.authorize(conversationId, identityId, actor);
    const base = (): LocalAgentSessionEvents => ({ protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId, participantIdentityId: identityId,
      capturedAt: this.now(), availability: "unavailable" });
    options.signal?.throwIfAborted();
    const key = JSON.stringify([conversation.workspaceId, conversationId, identityId]);
    if (this.reading.has(key) || this.reading.size >= 16) { await this.authorize(conversationId, identityId, actor); return base(); }
    this.reading.add(key);
    const signal = AbortSignal.any([AbortSignal.timeout(2000), ...(options.signal ? [options.signal] : [])]);
    const task = (async (): Promise<LocalAgentSessionEvents> => {
      try {
        const before = await this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, identityId);
        signal.throwIfAborted();
        if (before.bindings.length !== 1) return base();
        const binding = before.bindings[0]!, activation = before.activation;
        if (binding.workspaceId !== conversation.workspaceId || binding.conversationId !== conversationId || binding.agentIdentityId !== identityId
          || !binding.runtimeOwnerId || !["connected", "paused"].includes(binding.state)
          || !activation || activation.state !== "active" || activation.mapping !== "managed"
          || activation.workspaceId !== binding.workspaceId || activation.conversationId !== conversationId || activation.agentIdentityId !== identityId
          || activation.bindingId !== binding.id || activation.bindingGeneration !== binding.generation || activation.runtimeAdapter !== binding.runtimeAdapter
          || activation.managedSessionId !== binding.runtimeSessionId || activation.runtimeOwnerId !== binding.runtimeOwnerId) return base();
        const runtime = this.options.runtimes[binding.runtimeAdapter];
        if (!runtime?.inspectSessionEvents) return base();
        let snapshot: LocalAgentSessionEvents["snapshot"];
        try { snapshot = safeSessionEvents(await runtime.inspectSessionEvents(binding.runtimeSessionId, binding.runtimeOwnerId, { signal })); }
        catch { signal.throwIfAborted(); }
        signal.throwIfAborted();
        // Authorize after content I/O, then take the final private identity fence with no later authorization await on success.
        const fresh = await this.authorize(conversationId, identityId, actor);
        signal.throwIfAborted();
        if (fresh.workspaceId !== conversation.workspaceId) return { ...base(), availability: "changed" };
        const after = await this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, identityId);
        signal.throwIfAborted();
        if (after.bindings.length !== 1 || bindingFence(after.bindings[0]) !== bindingFence(binding)
          || activationFence(after.activation) !== activationFence(activation)) return { ...base(), availability: "changed" };
        const result: LocalAgentSessionEvents = snapshot ? { ...base(), availability: "available", snapshot } : base();
        return Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024 ? result : base();
      } finally { this.reading.delete(key); }
    })();
    let aborted: (() => void) | undefined, result: LocalAgentSessionEvents;
    try {
      result = await Promise.race([task, new Promise<never>((_, reject) => {
        aborted = () => reject(new DOMException("Session events aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      })]);
    } catch (error) {
      if (error instanceof LocalConfigurationRequestError) throw error;
      result = base();
    } finally { if (aborted) signal.removeEventListener("abort", aborted); }
    options.signal?.throwIfAborted();
    if (result.availability !== "available") await this.authorize(conversationId, identityId, actor);
    options.signal?.throwIfAborted();
    return result;
  }
}
