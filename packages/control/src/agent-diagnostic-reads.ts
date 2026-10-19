import type { ConversationClient } from "@minu/channels-core/client";
import { DIAGNOSTIC_LIMITS, type DiagnosticScope, type RelayBindingStore } from "@minu/channels-relay";
import type { DiagnosticRecorder } from "./diagnostics-recorder.ts";
import { LocalConfigurationRequestError } from "./configuration.ts";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION, type LocalAgentDiagnosticReport, type LocalAgentOperationDetail,
  type LocalAgentOperationHistory, type LocalConversationAgent, type LocalOperationTurnFailure,
} from "./contracts.ts";

type Directory = Pick<ConversationClient, "getConversation" | "getWorkspace" | "listWorkspaceMembers" | "getIdentity">;
export type DiagnosticReader = Pick<DiagnosticRecorder, "history" | "detail" | "correlated">;
const notFound = () => new LocalConfigurationRequestError("Not found", 404, "unavailable");
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,256}$/.test(id);
const label = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);

/** Shared with failure notices; archived/read-only Conversations remain inspectable. */
export async function authorizeDiagnosticAccess(client: Directory, conversationId: string, actorIdentityId: string) {
  try {
    const conversation = await client.getConversation(conversationId);
    const [workspace, members, actor] = await Promise.all([
      client.getWorkspace(conversation.workspaceId), client.listWorkspaceMembers(conversation.workspaceId), client.getIdentity(actorIdentityId),
    ]);
    const membership = members.find(({ identityId }) => identityId === actorIdentityId);
    const participant = conversation.participants.find(({ id }) => id === actorIdentityId);
    if (workspace.status !== "active" || actor.type !== "human" || actor.status !== "active"
      || membership?.status !== "active" || !participant || participant.status === "disabled") throw notFound();
    return { conversation, canViewDiagnostics: membership.accessRole === "owner" || membership.accessRole === "admin" };
  } catch { throw notFound(); }
}

/** Read-only service. It has no Runtime, mutation, transcript, or raw-log capability. */
export class LocalAgentDiagnosticReads {
  constructor(private options: {
    client: Directory;
    store: Pick<RelayBindingStore, "listTurnFailures">;
    reader?: DiagnosticReader;
    now?: () => Date;
  }) {}

  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private async authorize(conversationId: string, identityId: string, actorIdentityId: string) {
    if (![conversationId, identityId, actorIdentityId].every(validId)) throw notFound();
    const access = await authorizeDiagnosticAccess(this.options.client, conversationId, actorIdentityId);
    if (!access.canViewDiagnostics) throw notFound();
    return access.conversation;
  }
  private scope(workspaceId: string, conversationId: string, participantIdentityId: string): DiagnosticScope {
    return { workspaceId, conversationId, participantIdentityId };
  }
  private async bounded<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => read(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Diagnostic read unavailable")); }, 2_000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async history(conversationId: string, identityId: string, actorIdentityId: string, cursor?: string): Promise<LocalAgentOperationHistory> {
    const conversation = await this.authorize(conversationId, identityId, actorIdentityId);
    if (cursor !== undefined) {
      const parts = /^\d{1,16}:\d{1,16}$/.test(cursor) ? cursor.split(":").map(Number) : [];
      const [upper, before] = parts;
      if (!Number.isSafeInteger(upper) || !Number.isSafeInteger(before) || upper! < 1 || before! < 1 || before! > upper! + 1) {
        throw new LocalConfigurationRequestError("Invalid diagnostic cursor", 400, "invalid");
      }
    }
    const history = await this.bounded(async () => {
      if (!this.options.reader) throw new Error("unavailable");
      return this.options.reader.history(this.scope(conversation.workspaceId, conversationId, identityId), cursor);
    }).catch(() => ({ operations: [], coverage: "unavailable" as const, recordingGap: true,
      retention: { days: DIAGNOSTIC_LIMITS.days, terminalLimit: DIAGNOSTIC_LIMITS.terminal, eventLimit: DIAGNOSTIC_LIMITS.events } }));
    await this.authorize(conversationId, identityId, actorIdentityId);
    return { ...history, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId, participantIdentityId: identityId, capturedAt: this.now() };
  }

  private async selected(scope: DiagnosticScope, operationId: string): Promise<LocalAgentOperationDetail> {
    const base = { protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, conversationId: scope.conversationId,
      participantIdentityId: scope.participantIdentityId, capturedAt: this.now() };
    return this.bounded(async (signal): Promise<LocalAgentOperationDetail> => {
      if (!this.options.reader) throw new Error("unavailable");
      const detail = await this.options.reader.detail(scope, operationId);
      signal.throwIfAborted();
      const failures: LocalOperationTurnFailure[] = [];
      let failuresUnavailable = false;
      if (detail?.operation.triggerSequence !== undefined && detail.operation.participantIdentityId === scope.participantIdentityId) {
        try {
          const retained = await this.options.store.listTurnFailures(scope.conversationId, 100);
          signal.throwIfAborted();
          const matching = retained.filter((record) => record.conversationId === scope.conversationId && record.participantId === scope.participantIdentityId
            && record.triggerSequence === detail.operation.triggerSequence);
          failuresUnavailable = retained.length >= 100 || matching.length > 16;
          await Promise.all(matching.slice(0, 16).map(async (record) => {
            let operationRelation: LocalOperationTurnFailure["operationRelation"] = "uncorrelated";
            if (record.bindingId && record.bindingGeneration) {
              try {
                const ids = await this.options.reader!.correlated(scope, { operationId, bindingId: record.bindingId, generation: record.bindingGeneration,
                  triggerMessageId: record.triggerMessageId, triggerSequence: record.triggerSequence });
                if (ids.includes(operationId)) operationRelation = "targeted_trigger";
              } catch { operationRelation = "unavailable"; failuresUnavailable = true; }
            }
            // Explicit projection. Never include private binding/trigger references or raw errors.
            const causes = ["turn_timeout", "runtime_request_timeout", "runtime_offline", "runtime_rejected", "response_delivery_failed", "unknown"] as const;
            const deliveries = ["pending", "delivered", "delivery_rejected", "delivery_timed_out", "cursor_commit_failed"] as const;
            const remediations = { retry_or_start_new_session: "Retry or start a new session", retry_request: "Retry request",
              reconnect_agent: "Reconnect agent", open_runtime_diagnostic: "Open Runtime diagnostic", check_connection_and_retry: "Check connection and retry" };
            if (!causes.includes(record.causeCategory) || !deliveries.includes(record.deliveryOutcome)
              || !Object.hasOwn(remediations, record.remediationCode) || !Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0
              || !Number.isSafeInteger(record.attemptCount) || record.attemptCount < 0
              || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.failedAt) || !Number.isFinite(Date.parse(record.failedAt))) {
              failuresUnavailable = true; return;
            }
            failures.push({ participant: { identityId: scope.participantIdentityId, displayLabel: "Selected participant" },
              triggerSequence: record.triggerSequence, causeCategory: record.causeCategory, failedAt: record.failedAt,
              elapsedMs: record.elapsedMs, attemptCount: record.attemptCount, deliveryOutcome: record.deliveryOutcome,
              remediation: { code: record.remediationCode, label: remediations[record.remediationCode] }, operationRelation });
          }));
          failures.sort((a, b) => b.failedAt.localeCompare(a.failedAt));
        } catch { failuresUnavailable = true; }
      }
      const relations: LocalAgentOperationDetail["relations"] = [];
      if (detail?.operation.parentOperationId) relations.push({ kind: "bulk_parent", operationId: detail.operation.parentOperationId });
      if (detail?.operation.action === "cleanup" && detail.operation.relatedOperationId) {
        relations.push({ kind: "retired_session_cleanup", operationId: detail.operation.relatedOperationId });
      }
      return { ...base, capturedAt: this.now(), coverage: "available", ...(detail ? { detail } : {}), relations, failures, failuresUnavailable };
    }).catch(() => ({ ...base, capturedAt: this.now(), coverage: "unavailable", relations: [], failures: [], failuresUnavailable: true }));
  }

  async detail(conversationId: string, identityId: string, actorIdentityId: string, operationId: string): Promise<LocalAgentOperationDetail> {
    const conversation = await this.authorize(conversationId, identityId, actorIdentityId);
    if (!validId(operationId)) throw notFound();
    const result = await this.selected(this.scope(conversation.workspaceId, conversationId, identityId), operationId);
    await this.authorize(conversationId, identityId, actorIdentityId);
    return result;
  }

  async report(conversationId: string, identityId: string, actorIdentityId: string, operationId: string,
    snapshot?: () => Promise<LocalConversationAgent | undefined>): Promise<LocalAgentDiagnosticReport> {
    const conversation = await this.authorize(conversationId, identityId, actorIdentityId);
    if (!validId(operationId)) throw notFound();
    const [selected, current] = await Promise.all([
      this.selected(this.scope(conversation.workspaceId, conversationId, identityId), operationId),
      Promise.resolve().then(() => snapshot?.()).catch(() => undefined),
    ]);
    const participant = conversation.participants.find(({ id }) => id === identityId);
    const report: LocalAgentDiagnosticReport = {
      formatVersion: 1, protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION, capturedAt: this.now(), conversationId,
      participant: { identityId, displayLabel: label(participant?.displayName ?? (participant?.handle ? `@${participant.handle}` : "Historical or unavailable participant")),
        availability: participant && participant.status !== "disabled" ? "current" : "historical_or_unavailable" },
      // Reconstruct nested fields too; never copy extensions, activity message IDs, or other agents.
      ...(current && current.workspaceId === conversation.workspaceId && current.conversationId === conversationId && current.identityId === identityId
        ? { snapshot: { state: current.state, lastVerifiedAt: current.lastVerifiedAt,
          ...(current.diagnostics ? { diagnostics: {
            connection: current.diagnostics.connection, phase: current.diagnostics.phase, startedAt: current.diagnostics.startedAt,
            queuedTurns: current.diagnostics.queuedTurns, queuedTurnsExact: current.diagnostics.queuedTurnsExact,
            lastVerifiedAt: current.diagnostics.lastVerifiedAt, capabilities: {
              safeActivityEvents: current.diagnostics.capabilities.safeActivityEvents, interrupt: current.diagnostics.capabilities.interrupt,
              reconnectExisting: current.diagnostics.capabilities.reconnectExisting, interactiveAttach: current.diagnostics.capabilities.interactiveAttach,
              openDiagnostic: current.diagnostics.capabilities.openDiagnostic, liveSkillVerification: current.diagnostics.capabilities.liveSkillVerification,
            },
          } } : {}),
        } } : {}),
      selected, coverage: { snapshotUnavailable: !current, truncated: false, notes: [
        "Observations are not lifecycle authority. Handler return is not acknowledgment or settlement.",
        "Missing history may be unrecorded, pruned, expired, or not yet persisted; no exact expiry is asserted.",
        "Failure relations identify targeted triggers, not causation. Uncorrelated failures have no exact operation evidence.",
        "No raw logs, prompts, transcripts, or native session identifiers are included. App version is unavailable.",
        "Copied data cannot be retrospectively revoked. This read does not publish or retry any action.",
      ] },
    };
    report.coverage.snapshotUnavailable = !report.snapshot;
    report.coverage.notes.push("Failure summaries use bounded retained evidence; absence is not proof that no failure occurred.");
    if (!selected.detail) report.coverage.notes.push("Selected operation is unavailable.");
    if (selected.coverage === "unavailable") report.coverage.notes.push("Diagnostic journal is unavailable.");
    if (selected.failuresUnavailable) report.coverage.notes.push("Failure evidence is incomplete or unavailable.");
    if (selected.detail?.recordingGap || selected.detail?.operation.recordingGap || selected.detail?.operation.eventsDropped) report.coverage.notes.push("Recording has gaps or omitted events.");
    // Bound UTF-8 JSON bytes, retaining the first and final timeline observations where possible.
    while (Buffer.byteLength(JSON.stringify(report)) > DIAGNOSTIC_LIMITS.reportBytes) {
      report.coverage.truncated = true;
      if ((selected.detail?.events.length ?? 0) > 2) selected.detail!.events.splice(1, 1);
      else if (selected.failures.length) selected.failures.pop();
      else if (report.snapshot) { delete report.snapshot; report.coverage.snapshotUnavailable = true; }
      else throw new LocalConfigurationRequestError("Diagnostic report unavailable", 413, "unavailable");
    }
    await this.authorize(conversationId, identityId, actorIdentityId);
    return report;
  }
}
