import type { ConversationMetadata } from "@minu/channels-core/types";
import type { ConversationClient } from "@minu/channels-core/client";
import type { AgentCredentialRecord } from "@minu/channels-relay-storage-drizzle";
import { AgentCredentialError, type AgentCredentialService } from "./agent-credentials.ts";

export interface AgentInspectionTarget {
  conversationId: string;
  workspaceId: string;
  /** Internal metadata for the status projector only; not an API response. */
  conversation: ConversationMetadata;
}

export interface AgentInspectionAuthorizationOptions {
  credentials: Pick<AgentCredentialService, "authenticate" | "authorizeAdministrator">;
  conversations: Pick<ConversationClient, "getConversation">;
  /** Required, fail-closed resource-policy port; role/scope alone must not override restrictions. */
  canInspectTarget(principalIdentityId: string, target: ConversationMetadata): Promise<boolean>;
  now?: () => Date;
}

function unavailable(): never { throw new AgentCredentialError(404, "target_unavailable"); }
function invalid(): never { throw new AgentCredentialError(400, "invalid_request"); }
function publicId(value: unknown): value is string {
  // Existing IDs are opaque (including legacy/custom IDs), but must be safe path selectors.
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}
function requestTarget(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "conversationId") || !publicId(input.conversationId)) invalid();
  return input.conversationId;
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentCredentialError(503, "inspection_unavailable");
}

/** Stop waiting on abort; this does not claim cancellation of an underlying port's I/O. */
async function waitFor<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkSignal(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new AgentCredentialError(503, "inspection_unavailable")); };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => { checkSignal(signal); return operation(); }).then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** Inspection-only boundary. No discovery, browser selection, role labels or Runtime caller bindings. */
export class AgentInspectionAuthorization {
  constructor(private readonly options: AgentInspectionAuthorizationOptions) {}

  private async authenticate(secret: string): Promise<AgentCredentialRecord> {
    try { return await this.options.credentials.authenticate(secret); }
    catch (error) {
      if (error instanceof AgentCredentialError && error.status === 401) {
        throw new AgentCredentialError(401, "unauthenticated");
      }
      throw new AgentCredentialError(503, "inspection_unavailable");
    }
  }

  private async target(record: AgentCredentialRecord, id: string, signal?: AbortSignal): Promise<AgentInspectionTarget> {
    checkSignal(signal);
    if (!record.capabilities.includes("conversation.inspect")) unavailable();
    try {
      await this.options.credentials.authorizeAdministrator(record.workspaceId, record.principalIdentityId);
      checkSignal(signal);
      const conversation = await this.options.conversations.getConversation(id);
      checkSignal(signal);
      if (conversation.id !== id || conversation.workspaceId !== record.workspaceId) unavailable();
      const grants = record.scope.mode === "locked" ? [record.scope] : record.scope.grants;
      const direct = grants.some(grant => grant.conversationId === id);
      const parentId = conversation.thread?.parentConversationId;
      if (!direct && !(parentId && grants.some(grant => grant.conversationId === parentId && grant.includeThreads))) unavailable();
      if (parentId) {
        if (!publicId(parentId) || parentId === id) unavailable();
        const parent = await this.options.conversations.getConversation(parentId);
        checkSignal(signal);
        // Current Channels threads have one parent Conversation, not arbitrary ancestry traversal.
        if (parent.id !== parentId || parent.workspaceId !== record.workspaceId || parent.thread) unavailable();
        if (!await this.options.canInspectTarget(record.principalIdentityId, parent)) unavailable();
        checkSignal(signal);
      }
      if (!await this.options.canInspectTarget(record.principalIdentityId, conversation)) unavailable();
      checkSignal(signal);
      // Resource-policy reads may be slow; principal authority must still hold after them.
      await this.options.credentials.authorizeAdministrator(record.workspaceId, record.principalIdentityId);
      checkSignal(signal);
      return { conversationId: id, workspaceId: record.workspaceId, conversation };
    } catch (error) {
      if (signal?.aborted) throw new AgentCredentialError(503, "inspection_unavailable");
      // Missing, wrong-workspace, restricted, out-of-scope and lost-principal targets are indistinguishable.
      if (error instanceof AgentCredentialError && error.status === 503) {
        throw new AgentCredentialError(503, "inspection_unavailable");
      }
      unavailable();
    }
  }

  /**
   * Execute one read, revalidate, then synchronously release. The adapter must serialize in release;
   * it must not await more work or expose the read result outside this callback. B4/B5 own deadline/
   * cancellation of I/O and status projection. No policy or credential response cache is kept here.
   */
  async inspect<T>(secret: string, input: unknown,
    read: (target: AgentInspectionTarget) => Promise<T>, release: (value: T) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    checkSignal(options.signal);
    const admitted = await waitFor(() => this.authenticate(secret), options.signal);
    checkSignal(options.signal);
    const id = requestTarget(input);
    const target = await waitFor(() => this.target(admitted, id, options.signal), options.signal);
    checkSignal(options.signal);
    const parentId = target.conversation.thread?.parentConversationId;
    const rosterRevision = target.conversation.rosterRevision;
    let value: T;
    try { value = await waitFor(() => read(target), options.signal); }
    catch { throw new AgentCredentialError(503, "inspection_unavailable"); }
    checkSignal(options.signal);
    const freshTarget = await waitFor(() => this.target(admitted, id, options.signal), options.signal);
    // Do not release a snapshot whose resource relation or authorized roster changed during the read.
    if (freshTarget.conversation.thread?.parentConversationId !== parentId
      || freshTarget.conversation.rosterRevision !== rosterRevision) unavailable();
    // Last awaited authority operation: rotation/revocation/grant edits during policy lookups must be seen.
    const current = await waitFor(() => this.authenticate(secret), options.signal);
    checkSignal(options.signal);
    if (current.id !== admitted.id || current.workspaceId !== admitted.workspaceId
      || current.principalIdentityId !== admitted.principalIdentityId
      || current.revision !== admitted.revision || current.secretGeneration !== admitted.secretGeneration) unavailable();
    const expires = Date.parse(current.expiresAt);
    if (!Number.isFinite(expires) || expires <= (this.options.now?.() ?? new Date()).getTime()) {
      throw new AgentCredentialError(401, "unauthenticated");
    }
    release(value);
  }
}
