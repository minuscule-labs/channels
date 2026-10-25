import type { ConversationClient } from "@minu/channels-core/client";
import { DELIVERY_LIMITS, deliveryDetail, deliverySummary, type DeliveryScope, type RelayBindingStore } from "@minu/channels-relay";
import { bindingFence, activationFence } from "./agent-session-inspection.ts";
import { authorizeDiagnosticAccess } from "./agent-diagnostic-reads.ts";
import { LocalConfigurationRequestError } from "./configuration.ts";
import type { DiagnosticRecorder } from "./diagnostics-recorder.ts";
import { LOCAL_CONTROL_PROTOCOL_VERSION, type LocalAgentDeliveryTrails } from "./contracts.ts";

type Directory = Pick<ConversationClient, "getConversation" | "getWorkspace" | "listWorkspaceMembers" | "getIdentity">;
type Records = Awaited<ReturnType<RelayBindingStore["getSessionInspectionRecords"]>>;
const id = (value: string) => /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const cursor = (value: string) => {
  if (!/^\d{1,16}:\d{1,16}$/.test(value)) return false;
  const [upper, before] = value.split(":").map(Number);
  return Number.isSafeInteger(upper) && Number.isSafeInteger(before) && upper! > 0 && before! > 0 && before! <= upper! + 1;
};
const denied = () => new LocalConfigurationRequestError("Not found", 404, "unavailable");
// Include the complete private selection and activation, including transition state. Never project this fence.
const fence = (records: Records) => JSON.stringify([records.bindings.map(bindingFence), activationFence(records.activation)]);
export class LocalDeliveryReads {
  private reading = new Set<string>();
  constructor(private options: { client: Directory; store: Pick<RelayBindingStore, "getSessionInspectionRecords">;
    reader?: Pick<DiagnosticRecorder, "deliveryHistory" | "deliveryDetail">; now?: () => Date }) {}
  private async authorize(conversationId: string, identityId: string, actor: string) {
    if (![conversationId, identityId, actor].every(id)) throw denied();
    const access = await authorizeDiagnosticAccess(this.options.client, conversationId, actor);
    if (!access.canViewDiagnostics || !access.conversation.participants.some(value => value.id === identityId && (value.type === "agent" || value.type === "service"))) throw denied();
    return access.conversation;
  }
  async read(conversationId: string, identityId: string, actor: string, options: { cursor?: string; trailId?: string; signal?: AbortSignal } = {}): Promise<LocalAgentDeliveryTrails> {
    const conversation = await this.authorize(conversationId, identityId, actor);
    if ((options.trailId !== undefined && !id(options.trailId)) || (options.cursor !== undefined && !cursor(options.cursor))) {
      throw new LocalConfigurationRequestError("Invalid trail selection", 400, "invalid");
    }
    const base = (): LocalAgentDeliveryTrails => ({ protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId, participantIdentityId: identityId,
      capturedAt: (this.options.now?.() ?? new Date()).toISOString(), availability: "unavailable",
      retention: { days: DELIVERY_LIMITS.days, terminalLimit: DELIVERY_LIMITS.terminal, eventLimit: DELIVERY_LIMITS.events } });
    options.signal?.throwIfAborted();
    const key = JSON.stringify([conversation.workspaceId, conversationId, identityId]);
    if (this.reading.has(key) || this.reading.size >= 16) { await this.authorize(conversationId, identityId, actor); return base(); }
    this.reading.add(key);
    const signal = AbortSignal.any([AbortSignal.timeout(2000), ...(options.signal ? [options.signal] : [])]);
    const task = (async (): Promise<LocalAgentDeliveryTrails> => {
      try {
        const before = await this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, identityId);
        signal.throwIfAborted();
        if (before.bindings.length !== 1 || !this.options.reader) return base();
        const binding = before.bindings[0]!, activation = before.activation;
        if (binding.workspaceId !== conversation.workspaceId || binding.conversationId !== conversationId || binding.agentIdentityId !== identityId
          || !binding.runtimeOwnerId || !activation || activation.mapping !== "managed" || activation.state !== "active"
          || activation.workspaceId !== binding.workspaceId || activation.conversationId !== conversationId || activation.agentIdentityId !== identityId
          || activation.bindingId !== binding.id || activation.bindingGeneration !== binding.generation || activation.runtimeAdapter !== binding.runtimeAdapter
          || activation.runtimeOwnerId !== binding.runtimeOwnerId || activation.managedSessionId !== binding.runtimeSessionId) return base();
        const scope: DeliveryScope = { workspaceId: binding.workspaceId, conversationId, participantIdentityId: identityId, bindingId: binding.id,
          generation: binding.generation, adapter: binding.runtimeAdapter, sessionId: binding.runtimeSessionId, ownerId: binding.runtimeOwnerId };
        const raw = await this.options.reader.deliveryHistory(scope, options.cursor);
        signal.throwIfAborted();
        if (!Array.isArray(raw.trails) || raw.trails.length > DELIVERY_LIMITS.page || typeof raw.recordingGap !== "boolean"
          || (raw.nextCursor !== undefined && !cursor(raw.nextCursor))) throw new Error("Unavailable");
        const trails = raw.trails.map(value => deliverySummary({ ...value, events: [] }));
        const selection = options.trailId ?? trails[0]?.trailId;
        const detail = selection ? await this.options.reader.deliveryDetail(scope, selection) : undefined;
        signal.throwIfAborted();
        const selected = detail ? deliveryDetail(detail) : undefined;
        if (selected && selected.trailId !== selection) throw new Error("Unavailable");
        const fresh = await this.authorize(conversationId, identityId, actor);
        signal.throwIfAborted();
        const after = await this.options.store.getSessionInspectionRecords(conversation.workspaceId, conversationId, identityId);
        signal.throwIfAborted();
        if (fresh.workspaceId !== conversation.workspaceId || fence(before) !== fence(after)) return { ...base(), availability: "changed" };
        const result: LocalAgentDeliveryTrails = { ...base(), availability: "available", history: { trails, recordingGap: raw.recordingGap,
          ...(raw.nextCursor ? { nextCursor: raw.nextCursor } : {}) }, ...(selected ? { selected } : {}) };
        return Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024 ? result : base();
      } finally { this.reading.delete(key); }
    })();
    let aborted: (() => void) | undefined, result: LocalAgentDeliveryTrails;
    try {
      result = await Promise.race([task, new Promise<never>((_, reject) => {
        aborted = () => reject(new DOMException("Trail read aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted();
      })]);
    } catch (error) { if (error instanceof LocalConfigurationRequestError) throw error; result = base(); }
    finally { if (aborted) signal.removeEventListener("abort", aborted); }
    options.signal?.throwIfAborted();
    if (result.availability !== "available") await this.authorize(conversationId, identityId, actor);
    options.signal?.throwIfAborted();
    return result;
  }
}
