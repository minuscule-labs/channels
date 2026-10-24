import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { InMemoryRelayBindingStore, type DiagnosticRecord } from "@minu/channels-relay";
import { DiagnosticJournal } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentSessionInspections } from "../src/agent-session-inspection.ts";
import { LocalAgentDiagnosticReads, type DiagnosticReader } from "../src/agent-diagnostic-reads.ts";
import { LocalControlService, createLocalControlHttpServer } from "../src/server.ts";
import { LocalControlBrowserSessions } from "../src/session.ts";
import { LocalControlClient } from "../src/client.ts";
import type { LocalAgentOperationDetail, LocalAgentOperationHistory, LocalAgentDiagnosticReport, LocalConversationAgent, LocalAgentSessionInspection, LocalAgentSessionEvents } from "../src/contracts.ts";

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
  const binding = await store.putBinding({ id: "SECRET_BINDING", workspaceId: workspace.id, conversationId: conversation.id, agentIdentityId: agent.id,
    workspaceAgentConfigId: "SECRET_CONFIG", runtimeAdapter: "pi", runtimeSessionId: "SECRET_MANAGED", runtimeOwnerId: "SECRET_OWNER",
    generation: 3, state: "paused", wakePolicy: "muted", createdAt: now, updatedAt: now }, { origin: "started", contextMode: "fresh", conversationSequence: 9 });
  await store.putAgentConfig({ id: "SECRET_CONFIG", workspaceId: workspace.id, agentIdentityId: agent.id, personaPrompt: "SECRET_INSTRUCTIONS",
    runtimeAdapter: "pi", modelProvider: "provider", modelId: "future-model", reasoningLevel: "high", skillIds: ["future-skill"], status: "active", createdAt: now, updatedAt: now });
  const profile = () => ({ version: 1, capturedAt: now, model: { status: "verified", provider: "provider", id: "running-model", token: "SECRET_TOKEN" },
    reasoning: { status: "verified", level: "low" }, skills: { status: "verified", commandIds: ["skill:live"], complete: true }, prompt: "SECRET_PROMPT", nativeSessionId: "SECRET_NATIVE" });
  let profileReads = 0;
  let profileReader: (id: string, owner: string, options?: { signal?: AbortSignal }) => Promise<unknown> = async () => profile();
  const events = () => ({ version: 1, source: "runtime_bridge", capturedAt: now, recordingSince: now, eventsDropped: 0,
    events: [{ sequence: 1, observedAt: now, code: "turn_accepted", prompt: "SECRET_PROMPT", nativeId: "SECRET_NATIVE" }], token: "SECRET_TOKEN" });
  let eventReads = 0;
  let eventReader: typeof profileReader = async () => events();
  const runtime = { status: async () => "idle" as const,
    inspectSessionProfile: async (id: string, owner: string, options?: { signal?: AbortSignal }) => { profileReads++; return profileReader(id, owner, options); },
    inspectSessionEvents: async (id: string, owner: string, options?: { signal?: AbortSignal }) => { eventReads++; return eventReader(id, owner, options); },
  };
  const sessionInspections = new LocalAgentSessionInspections({ client: directoryClient, store, runtimes: { pi: runtime } });
  const reads = () => new LocalAgentDiagnosticReads({ client: directoryClient, store, reader, sessionInspections });
  // Delegation permits changing a read source while retaining the same authenticated HTTP fixture.
  const diagnosticReads = {
    history: (...args: Parameters<LocalAgentDiagnosticReads["history"]>) => reads().history(...args),
    detail: (...args: Parameters<LocalAgentDiagnosticReads["detail"]>) => reads().detail(...args),
    report: (...args: Parameters<LocalAgentDiagnosticReads["report"]>) => reads().report(...args),
  };
  const control = new LocalControlService({ conversations: client, bindings: store, runtimes: {}, diagnosticReads, sessionInspections });
  const server = await createLocalControlHttpServer({ service: control, port: 0, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin] });
  const exchange = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
  const headers = { cookie, origin: sessions.browserOrigin };
  const base = `/local/conversations/${conversation.id}/agents/${agent.id}`;
  const get = (path = "/operations", init?: RequestInit) => fetch(`${server.endpoint}${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  return { client, directoryClient, owner, agent, otherAgent, workspace, conversation, journal, store, scope, record, reads, server, get, base, headers, binding, profile, sessionInspections,
    profileReads: () => profileReads, profileReader(value: typeof profileReader) { profileReader = value; },
    events, eventReads: () => eventReads, eventReader(value: typeof eventReader) { eventReader = value; },
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

test("recent Runtime events are scoped, independently projected, bounded, read-only and excluded from reports", async context => {
  const f = await fixture(); context.after(() => f.close());
  const before = JSON.stringify(await f.store.getSessionInspectionRecords(f.workspace.id, f.conversation.id, f.agent.id));
  f.eventReader(async (id, owner, options) => { assert.equal(id, "SECRET_MANAGED"); assert.equal(owner, "SECRET_OWNER"); assert.ok(options?.signal); return f.events(); });
  const response = await f.get("/session-events");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const value = await response.json() as LocalAgentSessionEvents;
  assert.equal(value.availability, "available");
  assert.deepEqual(value.snapshot?.events.map(event => event.code), ["turn_accepted"]);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|token|nativeId|prompt|runtimeOwner|bindingId|generation/);
  assert.equal(f.profileReads(), 0);
  assert.equal(JSON.stringify(await f.store.getSessionInspectionRecords(f.workspace.id, f.conversation.id, f.agent.id)), before);
  assert.equal((await f.get("/session-events?path=/SECRET")).status, 400);
  const count = f.eventReads();
  const report = await (await f.get("/diagnostic-report?operationId=operation-selected")).json();
  assert.equal(f.eventReads(), count); assert.doesNotMatch(JSON.stringify(report), /runtime_bridge|turn_accepted|recordingSince/);
  await f.member({ accessRole: "member" });
  assert.equal((await f.get("/session-events")).status, 404); assert.equal(f.eventReads(), count);
});

test("recent-event projection rejects unsupported/malformed/oversized evidence without fallbacks", async context => {
  const f = await fixture(); context.after(() => f.close());
  for (const result of [undefined, { ...f.events(), version: 2 }, { ...f.events(), source: "pi_stderr" }, { ...f.events(), capturedAt: "SECRET" },
    { ...f.events(), eventsDropped: 1 }, { ...f.events(), events: Array(201).fill(f.events().events[0]) },
    { ...f.events(), events: [{ ...f.events().events[0], sequence: 0 }] },
    { ...f.events(), events: [{ ...f.events().events[0], code: "SECRET" }] },
    { ...f.events(), events: [{ ...f.events().events[0], observedAt: "/SECRET" }] }]) {
    f.eventReader(async () => result);
    const value = await (await f.get("/session-events")).json() as LocalAgentSessionEvents;
    assert.equal(value.availability, "unavailable"); assert.equal(value.snapshot, undefined);
    assert.doesNotMatch(JSON.stringify(value), /SECRET|running-model|future-model/);
  }
  f.eventReader(async () => { throw new Error("SECRET_PATH"); });
  assert.equal((await (await f.get("/session-events")).json() as LocalAgentSessionEvents).availability, "unavailable");
  f.eventReader(async () => ({ ...f.events(), eventsDropped: 7, events: Array.from({ length: 200 }, (_, i) => ({ sequence: i + 8, observedAt: f.events().capturedAt, code: "turn_accepted" })) }));
  const bounded = await (await f.get("/session-events")).json() as LocalAgentSessionEvents;
  assert.equal(bounded.snapshot?.events.length, 200); assert.equal(bounded.snapshot?.eventsDropped, 7);
  const unsupported = new LocalAgentSessionInspections({ client: f.directoryClient, store: f.store, runtimes: { pi: {} } });
  assert.equal((await unsupported.events(f.conversation.id, f.agent.id, f.owner.id)).availability, "unavailable");
});

test("events cannot wake transitional/offline sessions or cross ambiguous/legacy/foreign activation scopes", async context => {
  const f = await fixture(); context.after(() => f.close());
  const snapshot = await f.store.getSessionInspectionRecords(f.workspace.id, f.conversation.id, f.agent.id);
  assert.ok(snapshot.activation);
  const sources = [
    { ...snapshot, bindings: [] }, { ...snapshot, bindings: [f.binding, f.binding] }, { ...snapshot, activation: undefined },
    ...["sleeping", "waking", "offline", "replacing", "stopping", "disabled"].map(state => ({ ...snapshot, bindings: [{ ...f.binding, state }] })),
    ...[{ workspaceId: "foreign" }, { conversationId: "foreign" }, { agentIdentityId: "foreign" }, { bindingId: "foreign" }, { bindingGeneration: 4 },
      { runtimeOwnerId: "foreign" }, { managedSessionId: "foreign" }, { runtimeAdapter: "foreign" }, { state: "retired" }, { mapping: "legacy_unmapped" }]
      .map(patch => ({ ...snapshot, activation: { ...snapshot.activation, ...patch } })),
    ...[{ workspaceId: "foreign" }, { conversationId: "foreign" }, { agentIdentityId: "foreign" }, { runtimeOwnerId: undefined }]
      .map(patch => ({ ...snapshot, bindings: [{ ...f.binding, ...patch }] })),
  ];
  let calls = 0;
  for (const source of sources) {
    const inspector = new LocalAgentSessionInspections({ client: f.directoryClient, store: {
      getSessionInspectionRecords: async () => source as typeof snapshot,
      getWorkspaceAgentConfig: async () => { throw new Error("must not read settings"); },
    }, runtimes: { pi: { inspectSessionEvents: async () => { calls++; return f.events(); } } } });
    assert.equal((await inspector.events(f.conversation.id, f.agent.id, f.owner.id)).availability, "unavailable");
  }
  assert.equal(calls, 0);
});

test("replacement, binding-state and owner changes fence late recent events", async context => {
  for (const mode of ["generation", "state", "owner"] as const) {
    const f = await fixture(); context.after(() => f.close());
    const entered = gate(), pending = gate();
    f.eventReader(async () => { entered.release(); await pending.promise; return f.events(); });
    const reading = f.get("/session-events"); await entered.promise;
    try {
      if (mode === "state") {
        const now = new Date().toISOString();
        assert.ok(await f.store.acquireBindingLease(f.binding.id, "event-state", now, new Date(Date.now() + 60000).toISOString()));
        assert.ok(await f.store.updateBindingState(f.binding.id, 3, "event-state", "stopping", undefined, now));
      } else assert.ok(await f.store.replaceBindingSession(f.binding.id, 3, "pi", "SECRET_REPLACEMENT", new Date().toISOString(), mode === "owner" ? "NEW_OWNER" : "SECRET_OWNER"));
    } finally { pending.release(); }
    const value = await (await reading).json() as LocalAgentSessionEvents;
    assert.equal(value.availability, "changed"); assert.equal(value.snapshot, undefined);
    assert.doesNotMatch(JSON.stringify(value), /SECRET|NEW_OWNER|turn_accepted/);
  }
});

test("event reads reauthorize roles, actor/target participation, human identity and browser expiry before delivery", async context => {
  for (const mode of ["role", "identity", "roster", "target", "session"] as const) {
    const f = await fixture(); context.after(() => f.close());
    const entered = gate(), pending = gate();
    f.eventReader(async () => { entered.release(); await pending.promise; return f.events(); });
    const reading = f.get("/session-events"); await entered.promise;
    try {
      if (mode === "role") await f.member({ accessRole: "member" });
      else if (mode === "identity") f.actorState({ status: "disabled" });
      else if (mode === "roster") await f.roster([f.agent.id]);
      else if (mode === "target") await f.roster([f.owner.id]);
      else f.expire();
    } finally { pending.release(); }
    const response = await reading;
    assert.equal(response.status, mode === "session" ? 401 : 404);
    assert.doesNotMatch(await response.text(), /SECRET|runtime_bridge|turn_accepted/);
  }
});

test("event timeouts retain physical slots shared with profile reads and discard late evidence", { timeout: 8000 }, async context => {
  const f = await fixture(); context.after(() => f.close());
  const entered = gate(), pending = gate();
  f.eventReader(async () => { entered.release(); await pending.promise; return f.events(); });
  try {
    const reading = f.get("/session-events"); await entered.promise;
    const started = performance.now();
    assert.equal((await (await reading).json() as LocalAgentSessionEvents).availability, "unavailable");
    assert.ok(performance.now() - started < 3000);
    assert.equal((await (await f.get("/session-events")).json() as LocalAgentSessionEvents).availability, "unavailable");
    assert.equal((await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection).availability, "unavailable");
    assert.equal(f.eventReads(), 1); assert.equal(f.profileReads(), 0);
  } finally { pending.release(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await f.get("/session-events")).json() as LocalAgentSessionEvents).availability, "available");
});

test("disconnecting the event HTTP request aborts the source and suppresses late follow-up reads", async context => {
  const f = await fixture(); context.after(() => f.close());
  const entered = gate(), canceled = gate(), pending = gate();
  f.eventReader(async (_id, _owner, options) => { options!.signal!.addEventListener("abort", canceled.release, { once: true }); entered.release(); await pending.promise; return f.events(); });
  const abort = new AbortController();
  const reading = f.get("/session-events", { signal: abort.signal }); await entered.promise;
  abort.abort(); await assert.rejects(reading, { name: "AbortError" }); await canceled.promise;
  assert.equal((await (await f.get("/session-events")).json() as LocalAgentSessionEvents).availability, "unavailable");
  pending.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await f.get("/session-events")).json() as LocalAgentSessionEvents).availability, "available");
});

test("the final event identity fence follows delayed authorization reads", async context => {
  const f = await fixture(); context.after(() => f.close());
  const entered = gate(), pending = gate();
  const original = f.directoryClient.getIdentity; let calls = 0;
  f.directoryClient.getIdentity = async id => { if (++calls === 2) { entered.release(); await pending.promise; } return original(id); };
  const reading = f.get("/session-events"); await entered.promise;
  try { assert.ok(await f.store.replaceBindingSession(f.binding.id, 3, "pi", "SECRET_REPLACEMENT", new Date().toISOString(), "SECRET_OWNER")); }
  finally { pending.release(); }
  const value = await (await reading).json() as LocalAgentSessionEvents;
  assert.equal(value.availability, "changed"); assert.equal(value.snapshot, undefined);
});

test("event inspection caps total physical metadata work and retains canceled slots until settlement", async context => {
  const f = await fixture(); context.after(() => f.close());
  const pending = gate(), entered = gate(); let calls = 0;
  const targets = Array.from({ length: 17 }, (_, i) => ({ ...f.conversation.participants.find(participant => participant.id === f.agent.id)!, id: `target-${i}` }));
  const inspector = new LocalAgentSessionInspections({ client: { ...f.directoryClient, getConversation: async () => ({ ...f.conversation, participants: [...f.conversation.participants, ...targets] }) }, store: {
    getSessionInspectionRecords: async () => { if (++calls === 16) entered.release(); await pending.promise; return { bindings: [] }; },
    getWorkspaceAgentConfig: async () => { throw new Error("must not read settings"); },
  }, runtimes: {} });
  const controllers = targets.slice(0, 16).map(() => new AbortController());
  const reads = controllers.map((controller, i) => inspector.events(f.conversation.id, targets[i]!.id, f.owner.id, { signal: controller.signal }));
  await entered.promise;
  controllers.forEach(controller => controller.abort());
  assert.ok((await Promise.allSettled(reads)).every(result => result.status === "rejected" && result.reason.name === "AbortError"));
  assert.equal((await inspector.events(f.conversation.id, targets[16]!.id, f.owner.id)).availability, "unavailable");
  assert.equal(calls, 16);
  pending.release(); await new Promise(resolve => setImmediate(resolve));
  await inspector.events(f.conversation.id, targets[16]!.id, f.owner.id); assert.equal(calls, 17);
});

test("session inspection separates recorded policy, live observations and saved future settings without private extensions or writes", async context => {
  const f = await fixture(); context.after(() => f.close());
  let calls = 0;
  f.profileReader(async (id, owner, options) => { calls++; assert.equal(id, "SECRET_MANAGED"); assert.equal(owner, "SECRET_OWNER"); assert.ok(options?.signal); return f.profile(); });
  await f.store.setCursor(f.conversation.id, f.agent.id, 123);
  const before = JSON.stringify({ binding: await f.store.getBinding(f.binding.id), history: await f.store.listSessionHistory(f.conversation.id), config: await f.store.getWorkspaceAgentConfig(f.workspace.id, f.agent.id) });
  const response = await f.get("/session-inspection");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const value = await response.json() as LocalAgentSessionInspection;
  assert.equal(value.availability, "available"); assert.equal(value.recorded?.bindingState, "paused");
  assert.equal(value.recorded?.contextMode, "fresh"); assert.equal(value.recorded?.activationSequence, 9);
  assert.equal(value.latestStart, "not_verified"); assert.equal(value.lastStopBoundary, "not_recorded");
  assert.equal(value.running.status, "available");
  if (value.running.status === "available") assert.deepEqual(value.running.profile.model, { status: "verified", provider: "provider", id: "running-model" });
  assert.equal(value.saved.status, "available");
  if (value.saved.status === "available") assert.deepEqual(value.saved.profile.model, { provider: "provider", id: "future-model" });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify({ binding: await f.store.getBinding(f.binding.id), history: await f.store.listSessionHistory(f.conversation.id), config: await f.store.getWorkspaceAgentConfig(f.workspace.id, f.agent.id) }), before);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|bindingId|generation|runtimeOwner|nativeSession|personaPrompt|systemPrompt|token|sessionFile/);
  const report = await (await f.get("/diagnostic-report?operationId=operation-selected")).json() as LocalAgentDiagnosticReport;
  assert.equal(report.session?.recorded?.contextMode, "fresh"); assert.equal(calls, 2, "reports read fresh session evidence");
  assert.ok(report.coverage.notes.some(note => note.includes("not the selected operation")));
  assert.doesNotMatch(JSON.stringify(report), /SECRET|nativeSession|personaPrompt|systemPrompt|sessionFile/);
});

test("editing or clearing saved launch settings never relabels the current observed profile or resolves defaults", async context => {
  const f = await fixture(); context.after(() => f.close());
  const config = await f.store.getWorkspaceAgentConfig(f.workspace.id, f.agent.id); assert.ok(config);
  await f.store.putAgentConfig({ ...config, modelProvider: undefined, modelId: undefined, reasoningLevel: undefined, skillIds: undefined });
  const value = await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection;
  assert.equal(value.saved.status, "available");
  if (value.saved.status === "available") {
    assert.equal(value.saved.profile.model, undefined); assert.equal(value.saved.profile.reasoningLevel, undefined);
    assert.deepEqual(value.saved.profile.skills, { selection: "default", ids: [], complete: true });
  }
  assert.equal(value.running.status, "available");
  if (value.running.status === "available") assert.deepEqual(value.running.profile.model, { status: "verified", provider: "provider", id: "running-model" });
  const unsupported = new LocalAgentSessionInspections({ client: f.directoryClient, store: f.store, runtimes: {} });
  assert.equal((await unsupported.read(f.conversation.id, f.agent.id, f.owner.id)).running.status, "not_verified");
});

test("unsupported, malformed and unavailable profiles never fall back to saved configuration or wake offline sessions", async context => {
  const f = await fixture(); context.after(() => f.close());
  for (const result of [undefined, { ...f.profile(), version: 2 }, { ...f.profile(), capturedAt: "SECRET" }]) {
    f.profileReader(async () => result);
    const value = await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection;
    assert.equal(value.running.status, "not_verified"); assert.equal(value.saved.status, "available");
  }
  f.profileReader(async () => { throw new Error("SECRET_PATH"); });
  assert.equal((await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection).running.status, "not_verified");
  const calls = f.profileReads();
  const now = new Date().toISOString();
  assert.ok(await f.store.acquireBindingLease(f.binding.id, "test-state-transition", now, new Date(Date.now() + 60_000).toISOString()));
  for (const state of ["sleeping", "waking", "offline", "stopping", "replacing", "disabled"] as const) {
    assert.ok(await f.store.updateBindingState(f.binding.id, 3, "test-state-transition", state, undefined, now));
    const value = await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection;
    assert.equal(value.running.status, "not_verified"); assert.equal(f.profileReads(), calls);
  }
  await f.store.deleteBinding(f.binding.id);
  const unbound = await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection;
  assert.equal(unbound.availability, "unbound"); assert.equal(unbound.saved.status, "available"); assert.equal(f.profileReads(), calls);
});

test("binding generation changes discard late profile, recorded context and future-setting combinations", async context => {
  const f = await fixture(); context.after(() => f.close());
  const entered = gate(), pending = gate();
  f.profileReader(async () => { entered.release(); await pending.promise; return f.profile(); });
  const reading = f.get("/session-inspection"); await entered.promise;
  try { assert.ok(await f.store.replaceBindingSession(f.binding.id, 3, "pi", "SECRET_REPLACEMENT", new Date().toISOString(), "SECRET_OWNER")); }
  finally { pending.release(); }
  const value = await (await reading).json() as LocalAgentSessionInspection;
  assert.equal(value.availability, "changed"); assert.equal(value.recorded, undefined);
  assert.equal(value.running.status, "not_verified"); assert.equal(value.saved.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(value), /SECRET|running-model|future-model/);
  f.profileReader(async () => f.profile());
  const next = await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection;
  assert.equal(next.availability, "available"); assert.equal(next.recorded?.contextMode, "with_context");
});

test("session profile reads reauthorize role, human identity, participant roster and browser expiry before delivery", async context => {
  for (const mode of ["role", "identity", "roster", "target", "session"] as const) {
    const f = await fixture(); context.after(() => f.close());
    const entered = gate(), pending = gate();
    f.profileReader(async () => { entered.release(); await pending.promise; return f.profile(); });
    const reading = f.get("/session-inspection"); await entered.promise;
    try {
      if (mode === "role") await f.member({ accessRole: "member" });
      else if (mode === "identity") f.actorState({ status: "disabled" });
      else if (mode === "roster") await f.roster([f.agent.id]);
      else if (mode === "target") await f.roster([f.owner.id]);
      else f.expire();
    } finally { pending.release(); }
    const response = await reading;
    assert.equal(response.status, mode === "session" ? 401 : 404, mode);
    assert.doesNotMatch(await response.text(), /SECRET|running-model|future-model/);
  }
});

test("stalled profile reads time out but retain a physical slot; late evidence is discarded", { timeout: 8000 }, async context => {
  const f = await fixture(); context.after(() => f.close());
  const pending = gate(), entered = gate();
  f.profileReader(async () => { entered.release(); await pending.promise; return f.profile(); });
  try {
    const first = f.get("/session-inspection"); await entered.promise;
    const concurrent = await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection;
    assert.equal(concurrent.availability, "unavailable");
    assert.equal((await (await first).json() as LocalAgentSessionInspection).availability, "unavailable");
    assert.equal((await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection).availability, "unavailable");
    assert.equal(f.profileReads(), 1, "timeouts cannot create an unbounded queue");
    assert.equal((await f.client.getConversation(f.conversation.id)).id, f.conversation.id);
  } finally { pending.release(); }
  await new Promise(resolve => setImmediate(resolve));
  f.profileReader(async () => undefined);
  assert.equal((await (await f.get("/session-inspection")).json() as LocalAgentSessionInspection).availability, "available");
});

test("inspection fails closed on ambiguous, legacy, inconsistent and incorrectly scoped activation evidence", async context => {
  const f = await fixture(); context.after(() => f.close());
  const snapshot = await f.store.getSessionInspectionRecords(f.workspace.id, f.conversation.id, f.agent.id);
  assert.ok(snapshot.activation);
  const activation = snapshot.activation;
  const cases = [
    { ...snapshot, bindings: [f.binding, { ...f.binding, id: "SECRET_DUPLICATE" }] },
    { ...snapshot, activation: undefined },
    ...[{ workspaceId: "foreign" }, { conversationId: "foreign" }, { agentIdentityId: "foreign" }, { bindingId: "foreign" },
      { bindingGeneration: 99 }, { runtimeAdapter: "foreign" }, { runtimeOwnerId: "foreign" }, { managedSessionId: "foreign" },
      { state: "retired" as const }, { conversationSequenceAtActivation: undefined }].map(patch => ({ ...snapshot, activation: { ...activation, ...patch } })),
    { bindings: [{ ...f.binding, runtimeOwnerId: undefined }], activation: { ...activation, mapping: "legacy_unmapped" as const,
      managedSessionId: undefined, runtimeOwnerId: undefined, legacyRuntimeSessionRef: f.binding.runtimeSessionId, origin: "migrated" as const } },
  ];
  let calls = 0;
  for (const source of cases) {
    const inspector = new LocalAgentSessionInspections({ client: f.directoryClient, store: {
      getSessionInspectionRecords: async () => source, getWorkspaceAgentConfig: f.store.getWorkspaceAgentConfig.bind(f.store),
    }, runtimes: { pi: { inspectSessionProfile: async () => { calls++; return f.profile(); } } } });
    const value = await inspector.read(f.conversation.id, f.agent.id, f.owner.id);
    assert.equal(value.running.status, "not_verified");
    assert.equal(value.recorded?.contextMode, undefined); assert.equal(value.recorded?.activationSequence, undefined);
    assert.doesNotMatch(JSON.stringify(value), /SECRET|foreign|running-model/);
  }
  assert.equal(calls, 0);
  await f.member({ accessRole: "member" });
  const denied = new LocalAgentSessionInspections({ client: f.directoryClient, store: {
    getSessionInspectionRecords: async () => { calls++; return snapshot; },
    getWorkspaceAgentConfig: async () => { calls++; return undefined; },
  }, runtimes: {} });
  await assert.rejects(denied.read(f.conversation.id, f.agent.id, f.owner.id));
  assert.equal(calls, 0, "authorization precedes private reads");
});

test("diagnostic GETs require a live browser, active human, owner/admin and Conversation participation on every read", async (context) => {
  const f = await fixture(); context.after(() => f.close());
  assert.equal((await fetch(`${f.server.endpoint}${f.base}/operations`)).status, 401);
  for (const path of ["/operations", "/operations/operation-selected", "/diagnostic-report?operationId=operation-selected", "/session-inspection", "/session-events"]) {
    const response = await f.get(path);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as { protocolVersion: number }).protocolVersion, 21);
    assert.equal((await f.get(path, { method: "POST" })).status, 405);
  }
  await f.member({ accessRole: "member" });
  for (const path of ["/operations", "/operations/operation-selected", "/operations/missing", "/diagnostic-report?operationId=operation-selected", "/session-inspection", "/session-events"]) {
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
    await client.agentSessionInspection("conv/one", "agent/one");
    await client.agentSessionEvents("conv/one", "agent/one");
    const abort = new AbortController(); abort.abort();
    await assert.rejects(client.agentDiagnosticReport("conv", "agent", "op", abort.signal), { name: "AbortError" });
    assert.ok(requests[0]!.url.endsWith("conv%2Fone/agents/agent%2Fone/operations?cursor=50%3A1"));
    assert.ok(requests[2]!.url.endsWith("diagnostic-report?operationId=op%2Fone"));
    assert.ok(requests[3]!.url.endsWith("conv%2Fone/agents/agent%2Fone/session-inspection"));
    assert.ok(requests[4]!.url.endsWith("conv%2Fone/agents/agent%2Fone/session-events"));
    assert.ok(requests.every(({ method }) => method === undefined));
  } finally { globalThis.fetch = original; }
});
