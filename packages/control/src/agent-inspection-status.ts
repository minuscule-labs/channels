import type { Participant } from "@minu/channels-core/types";
import { performance } from "node:perf_hooks";
import { AgentCredentialError } from "./agent-credentials.ts";
import type { AgentInspectionAuthorization, AgentInspectionTarget } from "./agent-inspection-authorization.ts";
import type { LocalConversationAgentState } from "./contracts.ts";
import type { LocalControlBindingDirectory, LocalControlRuntimePort, LocalControlService } from "./server.ts";

export const AGENT_INSPECTION_BOUNDS = Object.freeze({
  deadlineMs: 5_000, probeWaitMs: 2_000, finalAuthorizationReserveMs: 1_000,
  outstandingRuntimeCalls: 4, activeInspections: 8, participants: 128, responseBytes: 128 * 1024,
});

export interface AgentInspectionParticipant {
  identityId: string;
  handle: string;
  displayName?: string;
  type: "human" | "agent" | "service";
  membershipStatus: "active" | "disabled";
  runtime?: { state: LocalConversationAgentState; lastVerifiedAt?: string };
}
export interface AgentConversationInspection {
  version: 1;
  conversationId: string;
  sampledAt: string;
  participants: AgentInspectionParticipant[];
}

// Shared across inspector instances in this process. A timeout never frees an unsettled Runtime call.
let outstandingRuntimeCalls = 0;
let activeInspections = 0;
function unavailable(): never { throw new AgentCredentialError(503, "inspection_unavailable"); }

function waitFor<T>(pending: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(new AgentCredentialError(503, "inspection_unavailable"));
  }
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new AgentCredentialError(503, "inspection_unavailable")); };
    signal.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(abort, timeoutMs);
    void pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function publicParticipant(participant: Participant): AgentInspectionParticipant {
  if (!participant || typeof participant.id !== "string" || !participant.id || participant.id.length > 200
    || typeof participant.handle !== "string" || !participant.handle || participant.handle.length > 200
    || !["human", "agent", "service"].includes(participant.type)
    || (participant.status !== undefined && participant.status !== "active" && participant.status !== "disabled")
    || (participant.displayName !== undefined && (typeof participant.displayName !== "string" || participant.displayName.length > 200))) unavailable();
  return { identityId: participant.id, handle: participant.handle,
    ...(participant.displayName !== undefined ? { displayName: participant.displayName } : {}),
    type: participant.type, membershipStatus: participant.status ?? "active",
    ...(participant.type === "human" ? {} : { runtime: { state: "uncertain" as const } }) };
}
const states: readonly LocalConversationAgentState[] = [
  "unbound", "starting", "idle", "running", "disconnected", "offline", "stopped", "disabled", "uncertain",
];

export interface AgentStatusInspectionOptions {
  authorization: Pick<AgentInspectionAuthorization, "inspect">;
  bindings: LocalControlBindingDirectory;
  status: Pick<LocalControlService, "inspectionAgentStatus">;
  now?: () => Date;
}

/** Bounded status-only orchestration; B5 supplies the HTTP transport, not a second status interpreter. */
export class AgentStatusInspection {
  constructor(private readonly options: AgentStatusInspectionOptions) {}

  private async probe(runtime: LocalControlRuntimePort, sessionId: string, signal: AbortSignal, cutoff: number): Promise<"idle" | "working" | "offline"> {
    // Timer delivery may lag behind elapsed time; guard both admission and result acceptance.
    const started = performance.now();
    if (signal.aborted || started >= cutoff
      || outstandingRuntimeCalls >= AGENT_INSPECTION_BOUNDS.outstandingRuntimeCalls) unavailable();
    const resultDeadline = Math.min(cutoff, started + AGENT_INSPECTION_BOUNDS.probeWaitMs);
    outstandingRuntimeCalls++;
    let actual: Promise<"idle" | "working" | "offline">;
    try { actual = Promise.resolve(runtime.status(sessionId)); }
    catch (error) { outstandingRuntimeCalls--; throw error; }
    // Both branches release only on actual settlement; no unhandled finally/rejection chain.
    void actual.then(() => { outstandingRuntimeCalls--; }, () => { outstandingRuntimeCalls--; });
    // The Runtime call itself may consume synchronous time before returning its promise.
    if (performance.now() >= resultDeadline) unavailable();
    const status = await waitFor(actual, signal, resultDeadline - performance.now());
    if (signal.aborted || performance.now() >= resultDeadline
      || (status !== "idle" && status !== "working" && status !== "offline")) unavailable();
    return status;
  }

  private async snapshot(target: AgentInspectionTarget, probeSignal: AbortSignal, cutoff: number): Promise<AgentConversationInspection> {
    const roster = target.conversation.participants;
    if (!Array.isArray(roster) || roster.length > AGENT_INSPECTION_BOUNDS.participants) unavailable();
    const participants = roster.map(publicParticipant);
    if (new Set(participants.map(item => item.identityId)).size !== participants.length) unavailable();
    // Binding failure is status uncertainty, not an empty binding list interpreted as unbound.
    let records: Awaited<ReturnType<LocalControlBindingDirectory["listConversationBindings"]>> | undefined;
    if (!probeSignal.aborted && performance.now() < cutoff) {
      try { records = await waitFor(this.options.bindings.listConversationBindings(target.conversationId), probeSignal); }
      catch { /* Retain complete roster with explicit uncertain agent/service states. */ }
    }
    if (records) {
      let next = 0;
      const worker = async () => {
        while (next < participants.length) {
          const index = next++;
          const participant = participants[index]!;
          if (participant.type === "human") continue;
          try {
            const status = await this.options.status.inspectionAgentStatus(target.conversation, participant.identityId,
              participant.membershipStatus, records!, (runtime, sessionId) => this.probe(runtime, sessionId, probeSignal, cutoff));
            if (!states.includes(status.state)) continue;
            participant.runtime = { state: status.state,
              ...(typeof status.lastVerifiedAt === "string" && Number.isFinite(Date.parse(status.lastVerifiedAt))
                ? { lastVerifiedAt: status.lastVerifiedAt } : {}) };
          } catch { /* A failed participant remains present and uncertain. */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, participants.length) }, worker));
    }
    const snapshot: AgentConversationInspection = { version: 1, conversationId: target.conversationId,
      sampledAt: (this.options.now?.() ?? new Date()).toISOString(), participants };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > AGENT_INSPECTION_BOUNDS.responseBytes) unavailable();
    return snapshot;
  }

  async inspect(secret: string, input: unknown, release: (value: AgentConversationInspection) => void,
    options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.inspectRequest(secret, async () => input, release, options);
  }

  /** Transport parsing shares the same admission slot/deadline as authorization and status I/O. */
  async inspectRequest(secret: string, readInput: (signal: AbortSignal) => Promise<unknown>,
    release: (value: AgentConversationInspection) => void, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (options.signal?.aborted || activeInspections >= AGENT_INSPECTION_BOUNDS.activeInspections) unavailable();
    activeInspections++;
    const started = performance.now();
    const probeCutoff = started + AGENT_INSPECTION_BOUNDS.deadlineMs - AGENT_INSPECTION_BOUNDS.finalAuthorizationReserveMs;
    const whole = new AbortController();
    const probes = new AbortController();
    const signal = options.signal ? AbortSignal.any([whole.signal, options.signal]) : whole.signal;
    const probeSignal = AbortSignal.any([signal, probes.signal]);
    const deadline = setTimeout(() => whole.abort(), AGENT_INSPECTION_BOUNDS.deadlineMs);
    const probeDeadline = setTimeout(() => probes.abort(),
      AGENT_INSPECTION_BOUNDS.deadlineMs - AGENT_INSPECTION_BOUNDS.finalAuthorizationReserveMs);
    try {
      const input = await waitFor(readInput(signal), signal);
      if (signal.aborted || performance.now() - started >= AGENT_INSPECTION_BOUNDS.deadlineMs) unavailable();
      await this.options.authorization.inspect(secret, input, target => this.snapshot(target, probeSignal, probeCutoff), value => {
        if (signal.aborted || performance.now() - started >= AGENT_INSPECTION_BOUNDS.deadlineMs) unavailable();
        release(value);
      }, { signal });
    } catch (error) {
      if (error instanceof AgentCredentialError) throw error;
      unavailable();
    } finally {
      clearTimeout(deadline);
      clearTimeout(probeDeadline);
      probes.abort();
      activeInspections--;
    }
  }
}
