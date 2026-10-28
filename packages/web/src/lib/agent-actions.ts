import { LocalControlClientError, type LocalControlClient } from "@minu/channels-control/client";
import { LOCAL_CONTROL_PROTOCOL_VERSION, type LocalAgentActionInput, type LocalAgentActionReceipt } from "@minu/channels-control/contracts";

export type BrowserAgentAction = LocalAgentActionReceipt & { dismissed?: boolean };
type ActionApi = Pick<LocalControlClient, "submitAgentAction" | "agentAction" | "pendingAgentActions">;
export const actionIsPending = (action: LocalAgentActionReceipt) => action.state === "pending" || (action.state === "unconfirmed" && action.completedAt === undefined);
const accessLost = (error: unknown) => error instanceof LocalControlClientError && (error.status === 401 || error.status === 403);

/** Owns only browser request receipts. Never replays a mutation, infers completion
 * from a green Runtime dot, or uses the optional diagnostic journal as authority. */
export class ParticipantActionRequests {
  private readonly actions = new Map<string, BrowserAgentAction>();
  private readonly reads = new Set<AbortController>();
  private disposed = false;
  private refreshInFlight?: Promise<void>;
  constructor(
    private readonly conversationId: string,
    private readonly api: ActionApi,
    private readonly changed: (actions: readonly BrowserAgentAction[]) => void,
    private readonly completed: () => void,
    private readonly revoked: () => void = () => undefined,
  ) {}
  private emit() { if (!this.disposed) this.changed([...this.actions.values()]); }
  private accept(receipt: LocalAgentActionReceipt) {
    if (this.disposed) return;
    const previous = this.actions.get(receipt.requestId);
    if (previous?.state === "succeeded" || previous?.state === "failed") return;
    this.actions.set(receipt.requestId, { ...receipt, dismissed: previous?.dismissed });
    this.emit();
    if (receipt.completedAt !== undefined && receipt.state !== "pending" && (previous?.state !== receipt.state || previous?.completedAt !== receipt.completedAt)) this.completed();
  }
  private revoke() {
    this.actions.clear();
    this.emit();
    this.dispose();
    this.revoked();
  }
  async submit(action: LocalAgentActionInput["action"], identityId?: string): Promise<void> {
    if (this.disposed) throw new Error("Participant controls unavailable");
    if ([...this.actions.values()].some(receipt => actionIsPending(receipt) && (!identityId || !receipt.identityId || receipt.identityId === identityId))) {
      throw new Error("Participant action already pending");
    }
    // A deliberate new intent clears old local feedback for that target only.
    for (const [id, receipt] of this.actions) if (receipt.identityId === identityId && !actionIsPending(receipt)) this.actions.delete(id);
    const input: LocalAgentActionInput = { requestId: crypto.randomUUID(), action, ...(identityId ? { identityId } : {}) };
    const pending: BrowserAgentAction = { ...input, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId: this.conversationId, state: "pending", requestedAt: Date.now() };
    this.actions.set(input.requestId, pending);
    this.emit();
    try {
      const receipt = await this.api.submitAgentAction(this.conversationId, input);
      // A newer deliberate intent may already have cleared this completed request.
      if (this.actions.has(input.requestId)) this.accept(receipt);
    } catch (error) {
      if (this.disposed) return;
      if (accessLost(error)) { this.revoke(); return; }
      const current = this.actions.get(input.requestId);
      // GET may have confirmed completion while POST was still in flight. Its
      // late failure must not replace that receipt or trigger mutation rollback.
      if (!current || current.state === "succeeded" || current.state === "failed") return;
      // Only a definitive admission rejection means the action failed. Transport
      // loss leaves the exact request ID in memory for GET-only reconciliation.
      const rejected = error instanceof LocalControlClientError && [400, 404, 409, 413].includes(error.status);
      const receipt: BrowserAgentAction = { ...pending, state: rejected ? "failed" : "unconfirmed",
        error: rejected ? error.message : "Participant action outcome unconfirmed",
        ...(rejected ? { completedAt: Date.now() } : {}) };
      this.accept(receipt);
      void this.refresh();
      throw new Error(receipt.error);
    }
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.readReceipts().finally(() => { this.refreshInFlight = undefined; });
    }
    return this.refreshInFlight;
  }
  private async readReceipts(): Promise<void> {
    const controller = new AbortController();
    this.reads.add(controller);
    try {
      try {
        const { actions } = await this.api.pendingAgentActions(this.conversationId, controller.signal);
        for (const action of actions) this.accept(action);
      } catch (error) {
        if (accessLost(error)) { this.revoke(); return; }
      }
      if (this.disposed) return;
      const pending = [...this.actions.values()].filter(actionIsPending);
      await Promise.allSettled(pending.map(async action => {
        try {
          this.accept(await this.api.agentAction(this.conversationId, action.requestId, controller.signal));
        } catch (error) {
          if (this.disposed) return;
          if (accessLost(error)) { this.revoke(); return; }
          const missing = error instanceof LocalControlClientError && error.status === 404;
          this.accept({ ...action, state: "unconfirmed", error: "Participant action outcome unconfirmed",
            ...(missing ? { completedAt: Date.now() } : {}) });
        }
      }));
    } finally {
      this.reads.delete(controller);
    }
  }
  dismiss(requestId: string) {
    const action = this.actions.get(requestId);
    if (!action) return;
    // Hiding a notice must not unlock an operation that may still be executing.
    this.actions.set(requestId, { ...action, dismissed: true });
    this.emit();
  }
  dispose() {
    this.disposed = true;
    for (const controller of this.reads) controller.abort();
    this.reads.clear();
    this.actions.clear();
  }
}
