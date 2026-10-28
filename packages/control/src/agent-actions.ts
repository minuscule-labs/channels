import { LocalConfigurationRequestError } from "./configuration.ts";
import { LOCAL_CONTROL_PROTOCOL_VERSION, type LocalAgentActionInput, type LocalAgentActionReceipt, type LocalBulkAgentLifecycleResult } from "./contracts.ts";

interface ActionEntry {
  actorIdentityId: string;
  receipt: LocalAgentActionReceipt;
  completion: Promise<LocalBulkAgentLifecycleResult[] | undefined>;
}

const actions = new Set(["start", "start-fresh", "reconnect", "replace", "replace-fresh", "stop", "stop-runtime", "restart-runtime", "cancel", "start-all", "stop-all"]);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function agentActionInput(input: unknown): LocalAgentActionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalConfigurationRequestError("Invalid participant action", 400, "invalid");
  const value = input as Record<string, unknown>;
  const bulk = value.action === "start-all" || value.action === "stop-all";
  if (Object.keys(value).some(key => !["requestId", "action", "identityId"].includes(key))
    || !validId(value.requestId) || typeof value.action !== "string" || !actions.has(value.action)
    || (bulk ? value.identityId !== undefined : !validId(value.identityId))) {
    throw new LocalConfigurationRequestError("Invalid participant action", 400, "invalid");
  }
  return { requestId: value.requestId, action: value.action as LocalAgentActionInput["action"], ...(bulk ? {} : { identityId: value.identityId as string }) };
}

/** Short-lived receipts, not a persistent job queue. Never evict an executing action.
 * All lifecycle entry points share admission, so retries cannot silently queue another
 * replacement behind a request whose browser has already stopped waiting. */
export class LocalAgentActions {
  private readonly entries = new Map<string, ActionEntry>();
  constructor(private readonly options: { now?: () => number; capacity?: number; retentionMs?: number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private key(conversationId: string, requestId: string) { return JSON.stringify([conversationId, requestId]); }
  private prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.receipt.completedAt !== undefined && now - entry.receipt.completedAt >= (this.options.retentionMs ?? 3_600_000)) this.entries.delete(key);
    }
  }
  start(conversationId: string, actorIdentityId: string, input: LocalAgentActionInput, execute: () => Promise<LocalBulkAgentLifecycleResult[] | undefined>): ActionEntry {
    this.prune();
    const key = this.key(conversationId, input.requestId);
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.actorIdentityId !== actorIdentityId || previous.receipt.action !== input.action || previous.receipt.identityId !== input.identityId) {
        throw new LocalConfigurationRequestError("Participant action ID already used", 409, "unavailable");
      }
      return previous;
    }
    const pending = [...this.entries.values()].some(({ receipt }) => receipt.conversationId === conversationId && receipt.state === "pending"
      && (!receipt.identityId || !input.identityId || receipt.identityId === input.identityId));
    if (pending) throw new LocalConfigurationRequestError("A participant action is already pending; refresh its status", 409, "unavailable");
    const capacity = this.options.capacity ?? 512;
    if (this.entries.size >= capacity) {
      const terminal = [...this.entries].find(([, entry]) => entry.receipt.state !== "pending");
      if (terminal) this.entries.delete(terminal[0]);
      else throw new LocalConfigurationRequestError("Participant actions are busy", 409, "unavailable");
    }
    const receipt: LocalAgentActionReceipt = { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId, ...input, state: "pending", requestedAt: this.now() };
    const entry: ActionEntry = { actorIdentityId, receipt, completion: undefined! };
    this.entries.set(key, entry);
    entry.completion = Promise.resolve().then(execute).then(results => {
      receipt.state = "succeeded";
      receipt.completedAt = this.now();
      if (results) receipt.results = results;
      return results;
    }, error => {
      receipt.state = error instanceof LocalConfigurationRequestError ? error.actionOutcome : "unconfirmed";
      receipt.error = error instanceof LocalConfigurationRequestError ? error.message : "Participant action outcome could not be confirmed";
      receipt.completedAt = this.now();
      throw error;
    });
    // The HTTP acceptance response does not await completion. Still observe rejection.
    void entry.completion.catch(() => undefined);
    return entry;
  }
  read(conversationId: string, requestId: string): LocalAgentActionReceipt | undefined {
    this.prune();
    const receipt = this.entries.get(this.key(conversationId, requestId))?.receipt;
    return receipt ? structuredClone(receipt) : undefined;
  }
  pending(conversationId: string): LocalAgentActionReceipt[] {
    return [...this.entries.values()].filter(({ receipt }) => receipt.conversationId === conversationId && receipt.state === "pending").map(({ receipt }) => structuredClone(receipt));
  }
}
