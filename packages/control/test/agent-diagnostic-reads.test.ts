import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { InMemoryRelayBindingStore, type DiagnosticRecord } from "@minu/channels-relay";
import { DiagnosticJournal } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentDiagnosticReads, type DiagnosticReader } from "../src/agent-diagnostic-reads.ts";
import { LocalControlService, createLocalControlHttpServer } from "../src/server.ts";
import { LocalControlBrowserSessions } from "../src/session.ts";
import { LocalControlClient } from "../src/client.ts";
import type { LocalAgentOperationDetail, LocalAgentOperationHistory, LocalAgentDiagnosticReport, LocalConversationAgent } from "../src/contracts.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "channels-diagnostic-api-"));
  const core = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const manager = await client.createIdentity({ type: "human", displayName: "Manager" });
  const agent = await client.createIdentity({ type: "agent", displayName: "<script>hostile label</script>" });
  const otherAgent = await client.createIdentity({ type: "agent", displayName: "Other" });
  const workspace = await client.createWorkspace({ slug: "diagnostic-reads", name: "Diagnostic reads" });
  for (const identity of [owner, agent, otherAgent]) await client.addWorkspaceMember(workspace.id, {
    identityId: identity.id, mentionHandle: identity.id === owner.id ? "owner" : identity.id === agent.id ? "agent" : "other",
    accessRole: identity.id === owner.id ? "owner" : "member",
  });
  await client.addWorkspaceMember(workspace.id, { identityId: manager.id, mentionHandle: "manager", accessRole: "owner" });
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id, otherAgent.id, manager.id] });
  const store = new InMemoryRelayBindingStore();
  const now = new Date().toISOString();
  const journal = await DiagnosticJournal.open(join(directory, "journal.db"), "epoch-test", now);
  const scope = { workspaceId: workspace.id, conversationId: conversation.id, participantIdentityId: agent.id };
  const record = (id: string, patch: Partial<DiagnosticRecord> = {}): DiagnosticRecord => ({
    ...scope, operationId: id, recorderEpoch: "epoch-test", action: "cancel_current", requestedAt: now, acceptedAt: now,
    observedAt: now, outcome: "pending", requestDisposition: "handler_returned", elapsedMs: 10, revision: 1,
    lastSequence: 1, eventsDropped: 0, recordingGap: false,
    correlations: { sourceBinding: { id: "SECRET_BINDING", generation: 3 }, trigger: { messageId: "SECRET_TRIGGER", sequence: 9 } },
    events: [{ sequence: 1, stage: "interrupt_requested", result: "confirmed", source: "relay", elapsedMs: 10, observedAt: now }], ...patch,
  });
  await journal.put(record("operation-selected"));
  await store.recordTurnFailure({ conversationId: conversation.id, participantId: agent.id, triggerSequence: 9,
    triggerMessageId: "SECRET_TRIGGER", bindingId: "SECRET_BINDING", bindingGeneration: 3,
    startedAt: now, failedAt: now, elapsedMs: 10, attemptCount: 1, causeCategory: "runtime_offline", remediationCode: "reconnect_agent" });
  let clock = Date.now();
  const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: owner.id,
    sessionTtlMs: 60_000, now: () => new Date(clock) });
  let reader: DiagnosticReader | undefined = journal;
  let actorState: { status?: "active" | "disabled"; type?: "human" | "agent" } = {};
  const directoryClient = { getConversation: client.getConversation.bind(client), getWorkspace: client.getWorkspace.bind(client),
    listWorkspaceMembers: client.listWorkspaceMembers.bind(client),
    getIdentity: async (id: string) => ({ ...await client.getIdentity(id), ...(id === owner.id ? actorState : {}) }),
  };
  const reads = () => new LocalAgentDiagnosticReads({ client: directoryClient, store, reader });
  // Delegation permits changing a read source while retaining the same authenticated HTTP fixture.
  const diagnosticReads = {
    history: (...args: Parameters<LocalAgentDiagnosticReads["history"]>) => reads().history(...args),
    detail: (...args: Parameters<LocalAgentDiagnosticReads["detail"]>) => reads().detail(...args),
    report: (...args: Parameters<LocalAgentDiagnosticReads["report"]>) => reads().report(...args),
  };
  const control = new LocalControlService({ conversations: client, bindings: store, runtimes: {}, diagnosticReads });
  const server = await createLocalControlHttpServer({ service: control, port: 0, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin] });
  const exchange = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
  const headers = { cookie, origin: sessions.browserOrigin };
  const base = `/local/conversations/${conversation.id}/agents/${agent.id}`;
  const get = (path = "/operations", init?: RequestInit) => fetch(`${server.endpoint}${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  return { client, owner, agent, otherAgent, workspace, conversation, journal, store, scope, record, reads, server, get, base, headers,
    source(value: DiagnosticReader | undefined) { reader = value; }, expire() { clock += 120_000; },
    actorState(value: typeof actorState) { actorState = value; },
    member(input: { accessRole?: "owner" | "admin" | "member"; status?: "active" | "disabled" }) {
      return client.updateWorkspaceMember(workspace.id, owner.id, { ...input, actorIdentityId: manager.id });
    },
    async roster(ids: string[]) { return client.updateConversationParticipants(conversation.id, {
      actorIdentityId: manager.id, participantIds: [...ids, manager.id], expectedRosterRevision: (await client.getConversation(conversation.id)).rosterRevision,
    }); },
    async close() { await server.close(); await journal.close(); await core.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("diagnostic GETs require a live browser, active human, owner/admin and Conversation participation on every read", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  assert.equal((await fetch(`${f.server.endpoint}${f.base}/operations`)).status, 401);
  for (const path of ["/operations", "/operations/operation-selected", "/diagnostic-report?operationId=operation-selected"]) {
    const response = await f.get(path);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as { protocolVersion: number }).protocolVersion, 19);
    assert.equal((await f.get(path, { method: "POST" })).status, 405);
  }
  await f.member({ accessRole: "member" });
  for (const path of ["/operations", "/operations/operation-selected", "/operations/missing", "/diagnostic-report?operationId=operation-selected"]) {
    const response = await f.get(path); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: "Not found" });
  }
  await f.member({ accessRole: "admin" });
  assert.equal((await f.get()).status, 200);
  await f.client.updateConversationLifecycle(f.conversation.id, { actorIdentityId: f.owner.id, state: "settled" });
  assert.equal((await f.get()).status, 200, "read-only/archived does not prohibit inspection");
  f.actorState({ status: "disabled" });
  assert.equal((await f.get()).status, 404);
  f.actorState({ type: "agent" });
  assert.equal((await f.get()).status, 404);
  f.actorState({});
  await f.member({ status: "disabled" });
  assert.equal((await f.get()).status, 404);
  await f.member({ status: "active" });
  await f.client.updateConversationLifecycle(f.conversation.id, { actorIdentityId: f.owner.id, state: "active" });
  await f.roster([f.agent.id, f.otherAgent.id]);
  assert.equal((await f.get()).status, 404);
});

test("exact failure links and reports omit private evidence, preserve uncertainty, and support historic targets", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  const selected = await (await f.get("/operations/operation-selected")).json() as LocalAgentOperationDetail;
  assert.equal(selected.detail?.operation.triggerSequence, 9);
  assert.equal(selected.detail?.operation.outcome, "pending", "HTTP handler return is not settlement");
  assert.equal(selected.failures[0]?.triggerSequence, 9);
  assert.equal(selected.failures[0]?.operationRelation, "targeted_trigger");
  await f.journal.put(f.record("operation-other-generation", { correlations: { sourceBinding: { id: "SECRET_BINDING", generation: 4 }, trigger: { messageId: "SECRET_TRIGGER", sequence: 9 } } }));
  // A selected older operation must not disappear behind the 50-link lookup bound.
  for (let i = 0; i < 52; i++) await f.journal.put(f.record(`operation-same-trigger-${i}`));
  const older = await (await f.get("/operations/operation-selected")).json() as LocalAgentOperationDetail;
  assert.equal(older.failures[0]?.operationRelation, "targeted_trigger");
  const unrelated = await (await f.get("/operations/operation-other-generation")).json() as LocalAgentOperationDetail;
  assert.equal(unrelated.failures[0]?.operationRelation, "uncorrelated", "same public trigger is not exact generation evidence");
  const report = await (await f.get("/diagnostic-report?operationId=operation-selected")).json() as LocalAgentDiagnosticReport;
  assert.equal(report.formatVersion, 1);
  assert.equal(report.participant.displayLabel, "<script>hostile label</script>", "authorized labels are data, never HTML");
  assert.equal(report.participant.availability, "current");
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 64 * 1024);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|bindingId|generation|triggerMessageId|recorderEpoch|runtimeOwner|sessionId|rawError|personaPrompt/);
  await f.roster([f.owner.id, f.otherAgent.id]);
  const historical = await (await f.get("/diagnostic-report?operationId=operation-selected")).json() as LocalAgentDiagnosticReport;
  assert.equal(historical.participant.availability, "historical_or_unavailable");
  assert.ok(historical.selected.detail);
  assert.equal(historical.coverage.snapshotUnavailable, true);
  assert.doesNotMatch(JSON.stringify(historical), /SECRET/);
});

test("wrong scope, forged relations, missing records and journal loss never grant global ID access", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  await f.journal.put(f.record("operation-other-workspace", { workspaceId: "workspace-foreign" }));
  await f.journal.put(f.record("operation-other-conversation", { conversationId: "conversation-foreign" }));
  await f.journal.put(f.record("operation-other-agent", { participantIdentityId: f.otherAgent.id }));
  await f.journal.put(f.record("operation-forged-child", { parentOperationId: "operation-other-workspace", relatedOperationId: "operation-other-agent" }));
  const forged = await (await f.get("/operations/operation-forged-child")).json() as LocalAgentOperationDetail;
  assert.equal(forged.detail?.operation.parentOperationId, undefined);
  assert.equal(forged.detail?.operation.relatedOperationId, undefined);
  for (const id of ["operation-other-workspace", "operation-other-conversation", "operation-other-agent", "missing"]) {
    const body = await (await f.get(`/operations/${id}`)).json() as LocalAgentOperationDetail;
    assert.equal(body.detail, undefined); assert.equal(body.coverage, "available"); assert.deepEqual(body.failures, []);
  }
  for (const source of [undefined, { history: async () => { throw new Error("SECRET_PATH /private/db"); }, detail: async () => { throw new Error("SECRET_PATH"); }, correlated: async () => [] }]) {
    f.source(source);
    const history = await (await f.get()).json() as LocalAgentOperationHistory;
    assert.equal(history.coverage, "unavailable"); assert.equal(history.recordingGap, true);
    const report = await (await f.get("/diagnostic-report?operationId=operation-selected")).json() as LocalAgentDiagnosticReport;
    assert.equal(report.selected.coverage, "unavailable"); assert.doesNotMatch(JSON.stringify(report), /SECRET|private\/db/);
  }
});

test("history keysets bound pages and exclude later inserts; cursors never bypass scope authorization", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  for (let i = 0; i < 54; i++) await f.journal.put(f.record(`operation-page-${i}`));
  const page1 = await (await f.get()).json() as LocalAgentOperationHistory;
  assert.equal(page1.operations.length, 50); assert.ok(page1.nextCursor);
  await f.journal.put(f.record("operation-inserted-later"));
  const page2 = await (await f.get(`/operations?cursor=${encodeURIComponent(page1.nextCursor!)}`)).json() as LocalAgentOperationHistory;
  assert.equal(page2.operations.length, 5); assert.equal(page2.nextCursor, undefined);
  assert.equal(new Set([...page1.operations, ...page2.operations].map((operation) => operation.operationId)).size, 55);
  assert.ok(!page2.operations.some((operation) => operation.operationId === "operation-inserted-later"));
  for (const cursor of ["x", "0:1", "2:4", "9999999999999999:1", "1:0", "1:1:1", "1%3ASECRET"]) assert.equal((await f.get(`/operations?cursor=${encodeURIComponent(cursor)}`)).status, 400);
  await f.member({ accessRole: "member" });
  assert.equal((await f.get(`/operations?cursor=${encodeURIComponent(page1.nextCursor!)}`)).status, 404);
});

test("bulk parent detail is accessible only through a retained exact-scope child", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  const parent = f.record("operation-parent", { action: "bulk_start", participantIdentityId: f.owner.id, correlations: undefined,
    bulk: { targets: 1, completed: 0, started: 0, stopped: 0, skipped: 0, failed: 0, unknown: 0, childrenUnrecorded: 0 } });
  await f.journal.put(parent);
  assert.equal((await (await f.get("/operations/operation-parent")).json() as LocalAgentOperationDetail).detail, undefined);
  await f.journal.put(f.record("operation-child", { action: "start", parentOperationId: parent.operationId }));
  const child = await (await f.get("/operations/operation-child")).json() as LocalAgentOperationDetail;
  assert.deepEqual(child.relations, [{ kind: "bulk_parent", operationId: parent.operationId }]);
  const linked = await (await f.get("/operations/operation-parent")).json() as LocalAgentOperationDetail;
  assert.equal(linked.detail?.operation.participantIdentityId, f.owner.id);
  assert.equal(linked.detail?.operation.action, "bulk_start");
  const other = await fetch(`${f.server.endpoint}/local/conversations/${f.conversation.id}/agents/${f.otherAgent.id}/operations/operation-parent`, { headers: f.headers });
  assert.equal((await other.json() as LocalAgentOperationDetail).detail, undefined);
  await f.journal.put(f.record("operation-cleanup", { action: "cleanup", relatedOperationId: "operation-selected" }));
  const cleanup = await (await f.get("/operations/operation-cleanup")).json() as LocalAgentOperationDetail;
  assert.deepEqual(cleanup.relations, [{ kind: "retired_session_cleanup", operationId: "operation-selected" }]);
});

test("role and browser expiry during reads/copy suppress late privileged responses", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  for (const mode of ["role", "session"] as const) {
    const entered = gate(), pending = gate();
    f.source({ ...f.journal, history: f.journal.history.bind(f.journal), correlated: f.journal.correlated.bind(f.journal),
      detail: async (...args) => { entered.release(); await pending.promise; return f.journal.detail(...args); } });
    const response = f.get("/diagnostic-report?operationId=operation-selected");
    await entered.promise;
    if (mode === "role") await f.member({ accessRole: "member" });
    else f.expire();
    pending.release();
    const denied = await response;
    assert.equal(denied.status, mode === "role" ? 404 : 401);
    assert.doesNotMatch(await denied.text(), /operation-selected|SECRET|targeted_trigger/);
    if (mode === "role") await f.member({ accessRole: "owner" });
  }
});

test("report clips UTF-8 bytes and allowlists nested status extensions without mutating stored evidence", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  const detail = (await f.journal.detail(f.scope, "operation-selected"))!;
  const events = Array.from({ length: 128 }, (_, i) => ({ ...detail.events[0]!, sequence: i + 1,
    // Legal fixed-field observation shape; byte clipping is independent of source event count.
    observedAt: `${detail.events[0]!.observedAt}${"界".repeat(160)}` }));
  f.source({ history: f.journal.history.bind(f.journal), correlated: f.journal.correlated.bind(f.journal), detail: async () => ({ ...detail, events: structuredClone(events) }) });
  const current = { workspaceId: f.workspace.id, conversationId: f.conversation.id, identityId: f.agent.id, state: "running",
    activity: { triggerMessageId: "SECRET_MESSAGE" }, diagnostics: { connection: "connected", queuedTurns: 0, queuedTurnsExact: true,
      rawError: "SECRET_ERROR", capabilities: { safeActivityEvents: "available", interrupt: "available", reconnectExisting: "available",
        interactiveAttach: "unavailable", openDiagnostic: "not_verified", liveSkillVerification: "unavailable", token: "SECRET_TOKEN" } } } as unknown as LocalConversationAgent;
  const report = await f.reads().report(f.conversation.id, f.agent.id, f.owner.id, "operation-selected", async () => current);
  assert.equal(report.coverage.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 64 * 1024);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|triggerMessageId|rawError|token/);
  assert.equal(events.length, 128);
  assert.equal((await f.journal.detail(f.scope, "operation-selected"))!.events.length, 1);
});

test("a stalled report read is bounded and a late result cannot start follow-up correlation reads", { timeout: 6_000 }, async (context) => {
  const f = await fixture(); context.after(() => f.close());
  const pending = gate();
  let correlations = 0;
  f.source({ history: f.journal.history.bind(f.journal),
    detail: async (...args) => { await pending.promise; return f.journal.detail(...args); },
    correlated: async () => { correlations++; return ["operation-selected"]; },
  });
  const started = performance.now();
  const response = await f.get("/diagnostic-report?operationId=operation-selected");
  const body = await response.json() as LocalAgentDiagnosticReport;
  assert.equal(body.selected.coverage, "unavailable");
  assert.ok(performance.now() - started < 4_000);
  pending.release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(correlations, 0);
  assert.equal(body.selected.detail, undefined);
  f.source(f.journal);
  assert.equal((await f.get()).status, 200);
});

test("client cancellation remains active through response-body decoding", async () => {
  const original = globalThis.fetch;
  const entered = gate();
  const abort = new AbortController();
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => ({ ok: true, status: 200,
    json: () => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      entered.release();
    }),
  })) as typeof fetch;
  try {
    const request = new LocalControlClient("http://127.0.0.1:1234", { timeoutMs: 200 }).agentOperationDetail("conv", "agent", "op", abort.signal);
    await entered.promise;
    abort.abort();
    await assert.rejects(request, { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("client encodes diagnostic scopes and passes caller read cancellation without any lifecycle mutation", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method });
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const client = new LocalControlClient("http://127.0.0.1:1234");
    await client.agentOperationHistory("conv/one", "agent/one", { cursor: "50:1" });
    await client.agentOperationDetail("conv/one", "agent/one", "op/one");
    await client.agentDiagnosticReport("conv/one", "agent/one", "op/one");
    const abort = new AbortController(); abort.abort();
    await assert.rejects(client.agentDiagnosticReport("conv", "agent", "op", abort.signal), { name: "AbortError" });
    assert.ok(requests[0]!.url.endsWith("conv%2Fone/agents/agent%2Fone/operations?cursor=50%3A1"));
    assert.ok(requests[2]!.url.endsWith("diagnostic-report?operationId=op%2Fone"));
    assert.ok(requests.every(({ method }) => method === undefined));
  } finally { globalThis.fetch = original; }
});
