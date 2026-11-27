import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import type { ConversationMetadata, Participant } from "@minu/channels-core/types";
import type { AgentCredentialRecord } from "@minu/channels-relay-storage-drizzle";
import { AgentCredentialError } from "../src/agent-credentials.ts";
import { AgentInspectionAuthorization } from "../src/agent-inspection-authorization.ts";
import { AGENT_INSPECTION_BOUNDS, AgentStatusInspection, type AgentConversationInspection } from "../src/agent-inspection-status.ts";
import { LocalControlService, type LocalControlBindingRecord, type LocalControlAgentLifecyclePort,
  type LocalControlRuntimePort } from "../src/server.ts";

const sampledAt = "2026-11-27T12:00:00.000Z";
const verifiedAt = "2026-11-26T00:00:00.000Z";
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function agent(id: string, type: "agent" | "service" = "agent"): Participant {
  return { id, handle: id, type, status: "active" };
}
function binding(id: string, state: LocalControlBindingRecord["state"] = "connected"): LocalControlBindingRecord {
  return { agentIdentityId: id, runtimeAdapter: "runtime-private-adapter", runtimeSessionId: `private-session-${id}`,
    runtimeOwnerId: "private-owner", state, wakePolicy: "mentions", lastVerifiedAt: verifiedAt };
}
function fixture(participants: Participant[], records: LocalControlBindingRecord[] = [], runtimes: Record<string, LocalControlRuntimePort> = {},
  lifecycle?: LocalControlAgentLifecyclePort) {
  const conversation: ConversationMetadata = { id: "conversation-public", workspaceId: "workspace-public", name: "Status",
    rosterRevision: 1, participants, createdAt: verifiedAt };
  const credential: AgentCredentialRecord = { id: "credential-public", workspaceId: conversation.workspaceId, principalIdentityId: "human-owner",
    requestId: "request_0000000001", name: "Inspector", capabilities: ["conversation.inspect"],
    scope: { mode: "locked", conversationId: conversation.id, includeThreads: true }, revision: 1, secretGeneration: 1,
    secretHash: "private-verifier", createdAt: verifiedAt, updatedAt: verifiedAt, expiresAt: "2099-01-01T00:00:00.000Z" };
  const directory = { async getConversation() { return structuredClone(conversation); } };
  const bindings = { async listConversationBindings() { return structuredClone(records); } };
  const credentials = {
    async authenticate(secret: string) { if (secret !== "transport-secret") throw new AgentCredentialError(401, "unauthenticated"); return structuredClone(credential); },
    async authorizeAdministrator() {},
  };
  const authorization = new AgentInspectionAuthorization({ credentials, conversations: directory, async canInspectTarget() { return true; } });
  const status = new LocalControlService({ conversations: directory, bindings, runtimes, lifecycle });
  const make = () => new AgentStatusInspection({ authorization, bindings, status, now: () => new Date(sampledAt) });
  return { conversation, bindings, authorization, status, make, credentials };
}
async function inspect(service: AgentStatusInspection, signal?: AbortSignal): Promise<AgentConversationInspection> {
  let snapshot: AgentConversationInspection | undefined;
  await service.inspect("transport-secret", { conversationId: "conversation-public" }, value => { snapshot = value; }, { signal });
  assert.ok(snapshot);
  return snapshot;
}
function unavailable(error: unknown) {
  return error instanceof AgentCredentialError && error.status === 503 && error.code === "inspection_unavailable";
}

test("status inspection reuses all nine UI states, services and membership semantics without capability/lifecycle I/O", async () => {
  let capabilityCalls = 0;
  let sideEffects = 0;
  const forbidden = async () => { sideEffects++; throw new Error("must not mutate"); };
  const lifecycle: LocalControlAgentLifecyclePort = { available: true, startConversationAgent: forbidden,
    replaceConversationAgent: forbidden, stopConversationAgent: forbidden, cancelCurrentConversationAgent: forbidden,
    recoverConversationAgent: forbidden, reconnectConversationAgent: forbidden,
    isStarting: (_conversation, id) => id === "starting", isAttached: (_conversation, id) => id !== "disconnected",
    agentWorkSnapshot: () => ({ activeTurns: 0, queuedTurns: 0, queuedTurnsExact: true }),
    activity: (_conversation, id) => id === "activity" ? { phase: "responding", triggerMessageId: "private-trigger",
      triggerSequence: 9, startedAt: verifiedAt, queuedTurns: 0, queuedTurnsExact: true } : undefined };
  const ids = ["running", "idle", "unbound", "starting", "stopped", "disabled", "disconnected", "offline", "uncertain", "activity"];
  const participants: Participant[] = [{ id: "human", handle: "human", type: "human" }, ...ids.map(id => agent(id)),
    { ...agent("membership-disabled"), status: "disabled" }, agent("service", "service")];
  const records = ids.filter(id => id !== "unbound").map(id => binding(id, id === "stopped" ? "paused" : id === "disabled" ? "disabled" : "connected"));
  records.push(binding("membership-disabled"), binding("service"), binding("removed-agent"));
  const runtime: LocalControlRuntimePort = {
    async status(sessionId) {
      const id = sessionId.replace("private-session-", "");
      if (id === "uncertain") throw new Error("private filesystem /secret/provider-token");
      return id === "offline" ? "offline" : id === "running" || id === "service" ? "working" : "idle";
    },
    async sessionCapabilities() { capabilityCalls++; throw new Error("private capability data"); },
    forceStopManaged: forbidden, interrupt: forbidden, openDiagnostic: forbidden,
  };
  const f = fixture(participants, records, { "runtime-private-adapter": runtime }, lifecycle);
  Object.assign(f.conversation, { messages: ["private transcript"], configuration: { root: "/private/source" } });
  Object.assign(f.conversation.participants[0]!, { credential: "private credential", runtime: { sessionId: "private-session-human" } });
  const snapshot = await inspect(f.make());
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.conversationId, f.conversation.id);
  assert.equal(snapshot.sampledAt, sampledAt);
  assert.equal(snapshot.participants.length, participants.length);
  assert.equal(snapshot.participants[0]!.runtime, undefined);
  assert.equal(snapshot.participants[0]!.membershipStatus, "active");
  const byId = new Map(snapshot.participants.map(item => [item.identityId, item]));
  for (const id of ids.filter(id => id !== "activity")) assert.equal(byId.get(id)!.runtime!.state, id);
  assert.equal(byId.get("activity")!.runtime!.state, "running");
  assert.equal(byId.get("service")!.runtime!.state, "running");
  assert.equal(byId.get("membership-disabled")!.membershipStatus, "disabled");
  assert.equal(byId.get("membership-disabled")!.runtime!.state, "disabled");
  assert.equal(byId.get("disabled")!.membershipStatus, "active");
  assert.equal(byId.get("running")!.runtime!.lastVerifiedAt, verifiedAt);
  assert.equal(byId.has("removed-agent"), false);
  assert.equal(capabilityCalls, 0, "inspection omits unnecessary capability probes");
  assert.equal(sideEffects, 0);
  const encoded = JSON.stringify(snapshot);
  for (const forbiddenText of ["runtime-private", "private-session", "private-owner", "private-trigger", "secret", "capabilities", "diagnostics", "wakePolicy", "private transcript", "configuration", "credential"])
    assert.ok(!encoded.includes(forbiddenText));
  const uiStatus = await f.status.listConversationAgents(f.conversation.id);
  for (const item of uiStatus.agents) assert.equal(byId.get(item.identityId)!.runtime!.state, item.state, "same interpreter as UI");
});

test("status inspection retains complete uncertain roster on binding failure; malformed/oversized roster fails", async () => {
  const f = fixture([agent("one"), agent("service", "service"), { id: "human", handle: "human", type: "human" }]);
  f.bindings.listConversationBindings = async () => { throw new Error("private binding database path"); };
  const snapshot = await inspect(f.make());
  assert.deepEqual(snapshot.participants.map(item => item.runtime?.state), ["uncertain", "uncertain", undefined]);
  assert.ok(snapshot.participants.every(item => !item.runtime?.lastVerifiedAt));
  f.conversation.participants = Array.from({ length: 129 }, (_, index) => agent(`agent-${index}`));
  await assert.rejects(inspect(f.make()), unavailable);
  f.conversation.participants = [agent("duplicate"), agent("duplicate")];
  await assert.rejects(inspect(f.make()), unavailable);
  f.conversation.participants = [{ ...agent("invalid"), handle: "" }];
  await assert.rejects(inspect(f.make()), unavailable);
  f.conversation.participants = Array.from({ length: 128 }, (_, index) => ({ id: `human-${index}`, handle: `human-${index}`, type: "human" as const }));
  assert.equal((await inspect(f.make())).participants.length, 128);
  f.conversation.participants = Array.from({ length: 128 }, (_, index) => ({ id: `${index}`.padEnd(200, "x"),
    handle: "人".repeat(200), displayName: "界".repeat(200), type: "human" as const }));
  await assert.rejects(inspect(f.make()), unavailable, "UTF-8 byte limit rejects complete oversized result instead of truncating");
});

test("status inspection does not fabricate freshness or cache results and rejects malformed Runtime status", async () => {
  let state: "idle" | "working" | "offline" = "idle";
  const record = binding("one");
  record.lastVerifiedAt = "not-a-timestamp-private-value";
  const f = fixture([agent("one")], [record], { "runtime-private-adapter": { async status() { return state; } } });
  const first = await inspect(f.make());
  assert.equal(first.participants[0]!.runtime!.state, "idle");
  assert.equal(first.participants[0]!.runtime!.lastVerifiedAt, undefined);
  state = "working";
  assert.equal((await inspect(f.make())).participants[0]!.runtime!.state, "running");
  state = "malformed-private-data" as never;
  assert.equal((await inspect(f.make())).participants[0]!.runtime!.state, "uncertain");
});

test("status inspection holds the four process-wide Runtime slots after timeout across inspector instances", { timeout: 8_000 }, async t => {
  const allEntered = latch();
  const held = latch();
  t.after(() => held.resolve());
  let calls = 0;
  let outstanding = 0;
  let peak = 0;
  const runtime: LocalControlRuntimePort = { async status() {
    calls++; outstanding++; peak = Math.max(peak, outstanding);
    if (calls === 4) allEntered.resolve();
    await held.promise;
    outstanding--;
    return "working";
  } };
  const f = fixture(Array.from({ length: 12 }, (_, index) => agent(`agent-${index}`)),
    Array.from({ length: 12 }, (_, index) => binding(`agent-${index}`)), { "runtime-private-adapter": runtime });
  const first = inspect(f.make());
  await allEntered.promise;
  assert.ok((await inspect(f.make())).participants.every(item => item.runtime!.state === "uncertain"));
  const timedOut = await first;
  assert.equal(timedOut.participants.length, 12);
  assert.ok(timedOut.participants.every(item => item.runtime!.state === "uncertain"));
  assert.equal(calls, 4);
  assert.equal(outstanding, 4, "wait timeout did not free real I/O slots");
  await inspect(f.make());
  assert.equal(calls, 4);
  held.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  const recovered = await inspect(f.make());
  assert.ok(recovered.participants.every(item => item.runtime!.state === "running"));
  assert.equal(peak, 4);
});

test("status inspection reserves final authorization time when binding lookup stalls", { timeout: 7_000 }, async t => {
  const held = latch();
  t.after(() => held.resolve());
  const f = fixture([agent("one"), { id: "human", handle: "human", type: "human" }]);
  f.bindings.listConversationBindings = async () => { await held.promise; return []; };
  const snapshot = await inspect(f.make());
  assert.equal(snapshot.participants.length, 2);
  assert.equal(snapshot.participants[0]!.runtime!.state, "uncertain", "failed binding lookup never becomes unbound");
  assert.equal(snapshot.participants[1]!.runtime, undefined);
  held.resolve();
});

for (const elapsed of [4_000, 5_100]) {
  test(`status inspection admits no more Runtime calls at ${elapsed}ms even before timers fire`, async t => {
    let monotonic = 100;
    t.mock.method(performance, "now", () => monotonic);
    const calls: number[] = [];
    const runtime: LocalControlRuntimePort = { async status() {
      calls.push(monotonic);
      // Simulate synchronous/event-loop work consuming the budget without delivering timer callbacks.
      monotonic = 100 + elapsed;
      return "working";
    } };
    const f = fixture(Array.from({ length: 8 }, (_, index) => agent(`agent-${index}`)),
      Array.from({ length: 8 }, (_, index) => binding(`agent-${index}`)), { "runtime-private-adapter": runtime });
    if (elapsed >= AGENT_INSPECTION_BOUNDS.deadlineMs) {
      await assert.rejects(inspect(f.make()), unavailable);
    } else {
      const snapshot = await inspect(f.make());
      assert.equal(snapshot.participants.length, 8);
      assert.ok(snapshot.participants.every(item => item.runtime!.state === "uncertain"),
        "the first probe also exceeded its own two-second result budget");
    }
    assert.deepEqual(calls, [100], "only the first pre-cutoff call may start");
  });
}

for (const mode of ["synchronous", "promise"] as const) for (const elapsed of [1_999, 2_000, 2_155]) {
  test(`status inspection checks ${elapsed}ms ${mode} result time even before timeout timers fire`, async t => {
    let monotonic = 100;
    t.mock.method(performance, "now", () => monotonic);
    let calls = 0;
    const runtime: LocalControlRuntimePort = { async status() {
      calls++;
      if (mode === "promise") await Promise.resolve();
      // The returned promise wins the timer race, but elapsed time must still enforce the budget.
      monotonic += elapsed;
      return "working";
    } };
    const f = fixture([agent("one")], [binding("one")], { "runtime-private-adapter": runtime });
    const snapshot = await inspect(f.make());
    assert.equal(calls, 1);
    assert.equal(snapshot.participants.length, 1);
    assert.equal(snapshot.participants[0]!.runtime!.state, elapsed < AGENT_INSPECTION_BOUNDS.probeWaitMs ? "running" : "uncertain");
    assert.equal(snapshot.participants[0]!.runtime!.lastVerifiedAt, verifiedAt, "source freshness is not fabricated on timeout");
  });
}

test("status inspection caps admission at eight process-wide before authorization and recovers capacity", async t => {
  const held = latch();
  t.after(() => held.resolve());
  const f = fixture([{ id: "human", handle: "human", type: "human" }]);
  const authenticate = f.credentials.authenticate;
  let admissions = 0;
  f.credentials.authenticate = async secret => { admissions++; await held.promise; return authenticate(secret); };
  const active = Array.from({ length: 8 }, () => inspect(f.make()));
  await assert.rejects(inspect(f.make()), unavailable);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(admissions, 8);
  held.resolve();
  assert.equal((await Promise.all(active)).length, 8);
  assert.equal((await inspect(f.make())).participants.length, 1);
});

test("status inspection whole deadline includes final authorization and never releases late data", { timeout: 9_000 }, async t => {
  const held = latch();
  t.after(() => held.resolve());
  const entered = latch();
  const f = fixture([{ id: "human", handle: "human", type: "human" }]);
  const original = f.credentials.authenticate;
  let checks = 0;
  f.credentials.authenticate = async secret => {
    if (++checks === 2) { entered.resolve(); await held.promise; }
    return original(secret);
  };
  let released = false;
  const pending = f.make().inspect("transport-secret", { conversationId: f.conversation.id }, () => { released = true; });
  await entered.promise;
  await assert.rejects(pending, unavailable);
  assert.equal(released, false);
  held.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(released, false);
  assert.equal(AGENT_INSPECTION_BOUNDS.deadlineMs, 5_000);
});

test("status inspection disconnect stops further Runtime admission but retains real slots until settlement", async t => {
  const held = latch();
  const entered = latch();
  t.after(() => held.resolve());
  let calls = 0;
  const f = fixture([agent("one")], [binding("one")], { "runtime-private-adapter": { async status() {
    calls++; entered.resolve(); await held.promise; return "working";
  } } });
  const controller = new AbortController();
  let released = false;
  const pending = f.make().inspect("transport-secret", { conversationId: f.conversation.id }, () => { released = true; }, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, unavailable);
  held.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(released, false);
});
