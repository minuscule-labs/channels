import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { InMemoryRelayBindingStore, type ManagedRuntimeSessionSummary } from "@minu/channels-relay";
import { DiagnosticJournal, DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHost, type ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { LocalAgentHostConfiguration, LocalConfigurationRequestError } from "../src/configuration.ts";
import { LocalControlService } from "../src/server.ts";
import { DiagnosticRecorder } from "../src/diagnostics-recorder.ts";
import { createLocalControlDaemon } from "../src/daemon.ts";
import type { LifecycleDiagnostics } from "../src/lifecycle-diagnostics.ts";
import { LifecycleCollector } from "./lifecycle-observer.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const end = performance.now() + timeout;
  while (!await check()) {
    if (performance.now() >= end) throw new Error("Lifecycle fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
class ObservedFakeRuntime {
  starts = 0;
  interrupts = 0;
  forceStops: string[] = [];
  forceStopFailure = false;
  forceStopGate?: ReturnType<typeof gate>;
  resumeFailure = false;
  resumes = 0;
  destructions: string[] = [];
  interruptFailure = false;
  interruptGate?: ReturnType<typeof gate>;
  sendGate?: ReturnType<typeof gate>;
  private sessions = new Map<string, { ownerId?: string; status: "idle" | "working" | "offline"; messages: Array<{ role: "assistant"; content: string }> }>();
  async start(_config: ManagedRuntimeStartConfig) {
    const id = `fake-session-${++this.starts}`;
    this.sessions.set(id, { status: "idle", messages: [] });
    return { id };
  }
  async startManaged(config: ManagedRuntimeStartConfig, ownerId: string) {
    const { id } = await this.start(config);
    this.sessions.get(id)!.ownerId = ownerId;
    return { id, ownerId };
  }
  unreachable = new Set<string>();
  async status(id: string) { return this.unreachable.has(id) ? "offline" as const : this.sessions.get(id)?.status ?? "offline" as const; }
  setWorking(id: string) { this.sessions.get(id)!.status = "working"; }
  async messages(id: string) { return this.sessions.get(id)?.messages ?? []; }
  async send(id: string, _input: string) {
    const session = this.sessions.get(id)!;
    session.status = "working";
    await this.sendGate?.promise;
    session.status = "idle";
    session.messages.push({ role: "assistant", content: "fixture response" });
  }
  async interrupt(id: string) {
    this.interrupts++;
    if (this.interruptFailure) throw new Error("SECRET_RAW_RUNTIME_ERROR");
    this.sessions.get(id)!.status = "idle";
    this.sendGate?.release();
    await this.interruptGate?.promise;
  }
  async listManagedSessions(ownerId: string): Promise<ManagedRuntimeSessionSummary[]> {
    return [...this.sessions].filter(([, session]) => session.ownerId === ownerId)
      .map(([id, session]) => ({ id, ownerId, state: session.status === "offline" ? "suspended" as const : "active" as const }));
  }
  async forceStopManaged(id: string, ownerId: string) {
    assert.equal(this.sessions.get(id)?.ownerId, ownerId);
    this.forceStops.push(id);
    await this.forceStopGate?.promise;
    if (this.forceStopFailure) throw new Error("SECRET_RUNTIME_SHUTDOWN_ERROR");
    this.sendGate?.release();
    await Promise.resolve();
    this.sessions.get(id)!.status = "offline";
    this.unreachable.delete(id);
  }
  async resume(id: string, ownerId: string) {
    this.resumes++;
    if (this.resumeFailure) throw new Error("SECRET_RESUME_ERROR");
    assert.equal(this.sessions.get(id)?.ownerId, ownerId);
    this.sessions.get(id)!.status = "idle";
    return { id, ownerId };
  }
  async suspend(id: string, ownerId: string) { assert.equal(this.sessions.get(id)?.ownerId, ownerId); this.sessions.get(id)!.status = "offline"; }
  async destroy(id: string, ownerId: string) {
    assert.equal(this.sessions.get(id)?.ownerId, ownerId);
    this.destructions.push(id); this.sessions.delete(id);
  }
}
async function fixture(diagnostics?: LifecycleDiagnostics, store: InMemoryRelayBindingStore | DrizzleLibSqlRelayStorage = new InMemoryRelayBindingStore()) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "channels-lifecycle-observation-")));
  const server = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
  const workspace = await client.createWorkspace({ slug: "diagnostics", name: "Diagnostics" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "builder" });
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
  const now = new Date().toISOString();
  await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: directory, createdAt: now, updatedAt: now });
  await store.putAgentConfig({ id: "fixture-config", workspaceId: workspace.id, agentIdentityId: agent.id, runtimeAdapter: "fake",
    status: "active", createdAt: now, updatedAt: now });
  const runtime = new ObservedFakeRuntime();
  let host = new LocalAgentHost({ client, store, runtimes: { fake: runtime }, diagnostics });
  return { directory, server, client, owner, agent, workspace, conversation, store, runtime,
    get host() { return host; },
    async useDiagnostics(value?: LifecycleDiagnostics) { await host.close(); host = new LocalAgentHost({ client, store, runtimes: { fake: runtime }, diagnostics: value }); },
    scope: { workspaceId: workspace.id, conversationId: conversation.id, participantIdentityId: agent.id },
    async close() { runtime.sendGate?.release(); runtime.interruptGate?.release(); await host.close(); await store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const reason of ["session_metadata_unavailable", "session_transcript_invalid", "session_resume_failed"] as const) {
  test(`explicit resume records safe ${reason} evidence without replacing or losing the saved session`, async () => {
    const collector = new LifecycleCollector();
    const f = await fixture(collector);
    try {
      await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh");
      const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
      await f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
      const list = f.runtime.listManagedSessions.bind(f.runtime);
      if (reason === "session_resume_failed") {
        await f.runtime.suspend(original.runtimeSessionId, original.runtimeOwnerId!);
        f.runtime.resumeFailure = true;
      } else if (reason === "session_metadata_unavailable") {
        f.runtime.listManagedSessions = async () => [];
      } else {
        f.runtime.listManagedSessions = async ownerId => (await list(ownerId)).map(session => ({ ...session, state: "unavailable", unavailableReason: reason }));
      }
      await assert.rejects(f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id), error =>
        error instanceof LocalConfigurationRequestError && /session.*not.*replaced/.test(error.message) && !error.message.includes("SECRET"));
      const current = (await f.store.listConversationBindings(f.conversation.id))[0]!;
      assert.equal(current.state, "paused"); assert.equal(current.runtimeSessionId, original.runtimeSessionId); assert.equal(current.generation, original.generation);
      assert.equal(f.runtime.starts, 1); assert.deepEqual(f.runtime.destructions, []);
      assert.equal((await f.store.listSessionHistory(f.conversation.id, f.agent.id)).length, 1);
      const operation = collector.operations.filter(item => item.action === "resume").at(-1)!;
      assert.ok(operation.events.some(([stage, result, options]) => stage === "resume_requested" && result === "failed" && options?.reasonCode === reason));
      assert.doesNotMatch(JSON.stringify(operation.events), /SECRET|PRIVATE|sessionFile|ownerId/);
    } finally { await f.close(); }
  });
}

test("startup retains an unavailable owned session instead of silently creating a replacement", async () => {
  const f = await fixture();
  let restored: LocalAgentHost | undefined;
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh");
    const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    await f.host.close();
    const now = new Date().toISOString();
    assert.ok(await f.store.acquireBindingLease(original.id, "fixture-offline", now, new Date(Date.now() + 30_000).toISOString()));
    assert.ok(await f.store.updateBindingState(original.id, original.generation, "fixture-offline", "offline", original.lastVerifiedAt, now));
    await f.store.releaseBindingLease(original.id, original.generation, "fixture-offline");
    f.runtime.listManagedSessions = async ownerId => [{ id: original.runtimeSessionId, ownerId, state: "unavailable", unavailableReason: "session_transcript_invalid" }];
    restored = new LocalAgentHost({ client: f.client, store: f.store, runtimes: { fake: f.runtime }, autoResumeOfflineAgents: true });
    await restored.restore();
    const current = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    assert.equal(current.runtimeSessionId, original.runtimeSessionId); assert.equal(current.generation, original.generation); assert.equal(current.state, "offline");
    assert.equal(restored.isAttached(f.conversation.id, f.agent.id), false);
    assert.equal(f.runtime.starts, 1); assert.deepEqual(f.runtime.destructions, []);
    assert.equal((await f.store.listSessionHistory(f.conversation.id, f.agent.id)).length, 1);
  } finally { await restored?.close(); await f.close(); }
});

for (const persistent of [false, true]) {
  test(`explicit Runtime recovery handles uncertain sleeping bindings without status, preserving binding and activation (persistent=${persistent})`, async () => {
    const collector = new LifecycleCollector();
    const databaseDirectory = await mkdtemp(join(tmpdir(), "channels-recovery-db-"));
    const store = persistent ? await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(databaseDirectory, "relay.db")) }) : new InMemoryRelayBindingStore();
    const f = await fixture(collector, store);
    try {
      await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh");
      const original = (await store.listConversationBindings(f.conversation.id))[0]!;
      await f.useDiagnostics(collector);
      const now = new Date().toISOString();
      assert.ok(await store.acquireBindingLease(original.id, "fixture-recovery", now, new Date(Date.now() + 30_000).toISOString()));
      assert.ok(await store.updateBindingState(original.id, original.generation, "fixture-recovery", "sleeping", original.lastVerifiedAt, now));
      await store.releaseBindingLease(original.id, original.generation, "fixture-recovery");
      f.runtime.status = async () => { throw new Error("PRIVATE_STATUS_TIMEOUT"); };
      const service = new LocalControlService({ conversations: f.client, bindings: store, runtimes: { fake: f.runtime }, lifecycle: f.host });
      const status = await service.conversationAgent(f.conversation.id, f.agent.id);
      assert.equal(status.state, "uncertain"); assert.equal(status.capabilities.recover, true);
      assert.equal(status.capabilities.stop, false); assert.equal(status.capabilities.replace, false);
      await f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, false);
      assert.equal((await store.getBinding(original.id))?.state, "paused");
      assert.equal(f.runtime.resumes, 0);
      f.runtime.status = async () => "idle";
      await f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, true);
      const recovered = (await store.getBinding(original.id))!;
      assert.equal(recovered.state, "connected"); assert.equal(recovered.id, original.id);
      assert.equal(recovered.generation, original.generation);
      assert.equal(recovered.runtimeSessionId, original.runtimeSessionId);
      assert.equal(f.runtime.starts, 1); assert.equal(f.runtime.resumes, 1);
      assert.deepEqual(f.runtime.forceStops, [original.runtimeSessionId, original.runtimeSessionId]);
      const history = await store.listSessionHistory(f.conversation.id, f.agent.id);
      assert.equal(history.length, 1); assert.equal(history[0]?.contextMode, "fresh");
      assert.ok(collector.operations.some(operation => operation.action === "runtime_stop" && operation.outcome === "succeeded"));
      assert.ok(collector.operations.some(operation => operation.action === "runtime_restart" && operation.outcome === "succeeded"));
    } finally { await f.close(); await rm(databaseDirectory, { recursive: true, force: true }); }
  });
}

test("unconfirmed Runtime shutdown remains durably fenced across host restart; an explicit retry can recover", async () => {
  const f = await fixture();
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const target = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    f.runtime.forceStopFailure = true;
    await assert.rejects(f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, true), error =>
      error instanceof LocalConfigurationRequestError && error.actionOutcome === "unconfirmed" && !error.message.includes("SECRET"));
    assert.equal((await f.store.getBinding(target.id))?.state, "stopping");
    assert.equal(f.runtime.resumes, 0); assert.equal(f.host.isAttached(f.conversation.id, f.agent.id), false);
    await f.useDiagnostics(); await f.host.restore();
    assert.equal(f.runtime.resumes, 0); assert.equal(f.host.isAttached(f.conversation.id, f.agent.id), false);
    f.runtime.forceStopFailure = false;
    await f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, true);
    assert.equal((await f.store.getBinding(target.id))?.state, "connected");
    assert.equal(f.runtime.resumes, 1);
    f.runtime.resumeFailure = true;
    await assert.rejects(f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, true));
    assert.equal((await f.store.getBinding(target.id))?.state, "paused");
    assert.equal(f.runtime.starts, 1);
  } finally { await f.close(); }
});

test("Runtime recovery stops an active turn before resuming and rejects unauthorized or archived requests", async () => {
  const f = await fixture();
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    f.runtime.sendGate = gate();
    await f.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "@builder work" });
    await until(() => (f.host.agentWorkSnapshot(f.conversation.id, f.agent.id)?.activeTurns ?? 0) > 0);
    f.runtime.forceStopGate = gate();
    const recovering = f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, true);
    await until(() => f.runtime.forceStops.length === 1);
    assert.equal(f.runtime.resumes, 0);
    const target = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    assert.equal(target.state, "stopping");
    f.runtime.forceStopGate.release(); await recovering;
    assert.equal(f.runtime.resumes, 1); assert.equal(f.runtime.interrupts, 0);
    await assert.rejects(f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.agent.id, true), /owner or admin/);
    assert.equal(f.runtime.forceStops.length, 1);
    await f.client.updateConversationLifecycle(f.conversation.id, { actorIdentityId: f.owner.id, state: "settled" });
    await assert.rejects(f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, true), /not active/);
    assert.equal(f.runtime.forceStops.length, 1);
  } finally { f.runtime.forceStopGate?.release(); await f.close(); }
});

test("recovery rechecks authority after shutdown and never attaches a changed generation", async () => {
  for (const revoke of [false, true]) {
    const f = await fixture();
    try {
      await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
      const target = (await f.store.listConversationBindings(f.conversation.id))[0]!;
      if (revoke) {
        const successor = await f.client.createIdentity({ type: "human", displayName: "Successor" });
        await f.client.addWorkspaceMember(f.workspace.id, { identityId: successor.id, mentionHandle: "successor", accessRole: "owner" });
        const stop = f.runtime.forceStopManaged.bind(f.runtime);
        f.runtime.forceStopManaged = async (...args) => {
          await stop(...args);
          await f.client.updateWorkspaceMember(f.workspace.id, f.owner.id, { actorIdentityId: successor.id, accessRole: "member" });
        };
      } else {
        const pause = f.store.pauseBinding.bind(f.store);
        f.store.pauseBinding = async (...args) => {
          const paused = await pause(...args);
          if (paused) await f.store.disableBinding(target.id, target.generation, new Date().toISOString());
          return paused;
        };
      }
      await assert.rejects(f.host.recoverConversationAgent(f.conversation.id, f.agent.id, f.owner.id, true));
      assert.equal(f.runtime.resumes, 0); assert.equal(f.runtime.starts, 1);
      assert.equal(f.host.isAttached(f.conversation.id, f.agent.id), false);
    } finally { await f.close(); }
  }
});

async function bulkFixture(diagnostics: LifecycleDiagnostics | undefined, count = 5) {
  const f = await fixture(diagnostics);
  const agents = [f.agent];
  const config = (await f.store.getAgentConfig("fixture-config"))!;
  for (let index = 1; index < count; index++) {
    const agent = await f.client.createIdentity({ type: "agent", displayName: `Worker ${index}` });
    await f.client.addWorkspaceMember(f.workspace.id, { identityId: agent.id, mentionHandle: `worker${index}` });
    await f.store.putAgentConfig({ ...config, id: `config-${index}`, agentIdentityId: agent.id });
    agents.push(agent);
  }
  const conversation = await f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id, ...agents.map(({ id }) => id)] });
  return { f, agents, conversation };
}

test("actual host restoration wires managed message trails through the existing journal worker without changing public chat", async () => {
  const f = await fixture();
  const recorder = new DiagnosticRecorder({ path: join(f.directory, "diagnostics.db") });
  try {
    const messages = f.runtime.messages.bind(f.runtime); f.runtime.messages = async id => [...await messages(id)];
    await until(() => recorder.available); await f.useDiagnostics(recorder);
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const trigger = await f.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "@builder SECRET_MESSAGE" });
    const binding = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    const scope = { ...f.scope, bindingId: binding.id, generation: binding.generation, adapter: binding.runtimeAdapter, sessionId: binding.runtimeSessionId, ownerId: binding.runtimeOwnerId! };
    await until(async () => (await recorder.deliveryHistory(scope)).trails[0]?.outcome === "delivered");
    const history = await recorder.deliveryHistory(scope), detail = await recorder.deliveryDetail(scope, history.trails[0]!.trailId);
    assert.equal(detail?.triggerSequence, trigger.sequence); assert.ok(detail?.events.some(event => event.stage === "response_committed"));
    assert.ok(detail?.events.some(event => event.stage === "cursor_committed")); assert.ok(!detail?.events.some(event => event.stage === "runtime_accepted"), "legacy callback is not recoverable acceptance evidence");
    assert.doesNotMatch(JSON.stringify(detail), /SECRET_MESSAGE|fixture response|sessionId|bindingId|ownerId/);
    const chat = await f.client.listMessages(f.conversation.id); assert.equal(chat.length, 2); assert.equal(chat[1]?.body, "fixture response");
    assert.ok((await recorder.history(f.scope)).operations.length > 0, "lifecycle history remains separate and available");
  } finally { await f.host.close(); await recorder.close(); await f.close(); }
});

test("bulk diagnostics preserve three workers, ordered results, exact resume children and explicit idle skips", async () => {
  const collector = new LifecycleCollector();
  const { f, agents, conversation } = await bulkFixture(collector, 6);
  const launch = gate();
  let active = 0, maximum = 0;
  const start = f.runtime.startManaged.bind(f.runtime);
  f.runtime.startManaged = async (...args) => {
    active++; maximum = Math.max(maximum, active);
    try { await launch.promise; return await start(...args); } finally { active--; }
  };
  let starting: ReturnType<typeof f.host.startAllConversationAgents> | undefined;
  try {
    starting = f.host.startAllConversationAgents(conversation.id, f.owner.id);
    await until(() => active === 3);
    const parent = collector.operations.find(({ action }) => action === "bulk_start")!;
    assert.equal(parent.outcome, "pending"); assert.equal(parent.bulk?.completed, 0);
    assert.equal(parent.scope.participantIdentityId, f.owner.id);
    launch.release();
    const results = await starting;
    assert.equal(maximum, 3);
    assert.deepEqual(results.map(({ identityId }) => identityId), conversation.participants.filter(({ type }) => type === "agent").map(({ id }) => id));
    assert.ok(results.every(({ outcome }) => outcome === "started"));
    assert.deepEqual(parent.bulk, { targets: 6, completed: 6, started: 6, stopped: 0, skipped: 0, failed: 0, unknown: 0, childrenUnrecorded: 0 });
    assert.equal(parent.outcome, "succeeded");
    const children = collector.operations.filter(({ parentOperationId }) => parentOperationId === parent.operationId);
    assert.equal(children.length, 6);
    assert.ok(children.every(({ bulkTarget, requestDisposition }) => bulkTarget?.outcome === "started" && requestDisposition === "not_applicable"));
    await f.host.stopAllConversationAgents(conversation.id, f.owner.id);
    assert.equal(collector.operations.find(({ action }) => action === "bulk_stop")?.bulk?.stopped, 6);
    const before = await f.store.listConversationBindings(conversation.id);
    await f.host.startAllConversationAgents(conversation.id, f.owner.id);
    const resumeParent = collector.operations.filter(({ action }) => action === "bulk_start")[1]!;
    const resumes = collector.operations.filter(({ parentOperationId }) => parentOperationId === resumeParent.operationId);
    assert.equal(resumes.length, 6);
    assert.ok(resumes.every(({ action, correlations }) => action === "resume" && before.some(({ id, generation }) => id === correlations.sourceBinding?.id && generation === correlations.sourceBinding.generation)));
    await f.host.startAllConversationAgents(conversation.id, f.owner.id);
    const skipParent = collector.operations.filter(({ action }) => action === "bulk_start")[2]!;
    assert.equal(skipParent.bulk?.skipped, 6);
    assert.ok(collector.operations.filter(({ parentOperationId }) => parentOperationId === skipParent.operationId)
      .every(({ bulkTarget }) => bulkTarget?.outcome === "skipped" && bulkTarget.reason === "already_idle"));
    assert.equal(f.runtime.starts, agents.length); assert.equal(f.runtime.interrupts, 0);
  } finally { launch.release(); await starting?.catch(() => undefined); await f.close(); }
});

test("bulk acceptance retains failed, skipped and unknown child results without exposing raw errors", async () => {
  const collector = new LifecycleCollector();
  const { f, agents, conversation } = await bulkFixture(collector);
  try {
    await f.host.startConversationAgent(conversation.id, agents[0]!.id, f.owner.id);
    await f.store.putAgentConfig({ ...(await f.store.getAgentConfig("config-1"))!, status: "disabled" });
    await f.store.putAgentConfig({ ...(await f.store.getAgentConfig("config-2"))!, personaPrompt: "fixture-failure" });
    await f.host.startConversationAgent(conversation.id, agents[4]!.id, f.owner.id);
    const stopping = (await f.store.listConversationBindings(conversation.id)).find(({ agentIdentityId }) => agentIdentityId === agents[4]!.id)!;
    assert.ok(stopping.state === "connected");
    await f.store.beginStopBinding(stopping.id, stopping.generation, stopping.state, new Date().toISOString());
    const start = f.runtime.startManaged.bind(f.runtime);
    f.runtime.startManaged = async (config, ownerId) => {
      if (config.appendSystemPrompt?.includes("fixture-failure")) throw new Error("SECRET_BULK_RUNTIME_ERROR");
      return start(config, ownerId);
    };
    const results = await f.host.startAllConversationAgents(conversation.id, f.owner.id);
    assert.equal(results.filter(({ outcome }) => outcome === "started").length, 1);
    assert.equal(results.filter(({ outcome }) => outcome === "failed").length, 1);
    const parent = collector.operations.find(({ action }) => action === "bulk_start")!;
    assert.equal(parent.requestDisposition, "handler_returned"); assert.equal(parent.outcome, "unknown");
    assert.deepEqual(parent.bulk, { targets: 5, completed: 5, started: 1, stopped: 0, skipped: 3, failed: 1, unknown: 2, childrenUnrecorded: 0 });
    const children = collector.operations.filter(({ parentOperationId }) => parentOperationId === parent.operationId);
    assert.equal(children.length, 5);
    assert.ok(children.some(({ outcome, bulkTarget }) => outcome === "failed" && bulkTarget?.outcome === "skipped" && bulkTarget.reason === "unconfigured"));
    assert.ok(children.some(({ outcome, bulkTarget }) => outcome === "unknown" && bulkTarget?.outcome === "failed"));
    assert.ok(!JSON.stringify(collector.operations).includes("SECRET_BULK_RUNTIME_ERROR"));
    const length = collector.operations.length;
    await assert.rejects(f.host.startAllConversationAgents(conversation.id, agents[0]!.id), /owner or admin/);
    assert.equal(collector.operations.length, length, "unauthorized requests never create parents or children");
  } finally { await f.close(); }
});

test("empty bulk target snapshots close truthfully without launching a runtime", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  try {
    const empty = await f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id] });
    assert.deepEqual(await f.host.startAllConversationAgents(empty.id, f.owner.id), []);
    const parent = collector.operations[0]!;
    assert.equal(collector.operations.length, 1); assert.equal(parent.outcome, "succeeded");
    assert.equal(parent.bulk?.targets, 0); assert.equal(parent.bulk?.completed, 0);
    assert.equal(f.runtime.starts, 0);
  } finally { await f.close(); }
});

test("bulk child observations preserve the original no-binding snapshot guard", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  try {
    type Target = { identityId: string; binding?: Awaited<ReturnType<typeof f.store.getBinding>>; duplicate: boolean };
    const internals = f.host as unknown as { bulkTargets(conversationId: string, actorId: string): Promise<{ workspaceId: string; targets: Target[] }> };
    const discover = internals.bulkTargets.bind(f.host);
    internals.bulkTargets = async (...args) => {
      const snapshot = await discover(...args);
      await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
      return snapshot;
    };
    assert.deepEqual(await f.host.startAllConversationAgents(f.conversation.id, f.owner.id), [{ identityId: f.agent.id, outcome: "skipped", reason: "uncertain" }]);
    const parent = collector.operations.find(({ action }) => action === "bulk_start")!;
    const child = collector.operations.find(({ parentOperationId }) => parentOperationId === parent.operationId)!;
    assert.equal(child.outcome, "unknown"); assert.equal(child.correlations.sourceBinding, undefined);
    assert.deepEqual(child.bulkTarget, { outcome: "skipped", reason: "uncertain" });
    assert.equal(f.runtime.starts, 1);
  } finally { await f.close(); }
});

test("bulk parent counts disclose diagnostic saturation without slowing or rejecting target starts", async () => {
  const { f, conversation } = await bulkFixture(undefined, 3);
  class QueueWorker extends EventEmitter {
    packets: Array<{ type: string; epoch: string; record?: import("@minu/channels-relay").DiagnosticRecord }> = [];
    postMessage(packet: QueueWorker["packets"][number]) { this.packets.push(structuredClone(packet)); if (packet.type === "close") this.emit("message", { type: "closed", epoch: packet.epoch }); }
    unref() {}
    async terminate() { return 0; }
  }
  const worker = new QueueWorker();
  const recorder = new DiagnosticRecorder({ path: join(f.directory, "unused.db"), workerFactory: () => worker as unknown as Worker });
  try {
    for (let index = 0; index < 126; index++) recorder.begin(f.scope, "cleanup");
    await f.useDiagnostics(recorder);
    assert.ok((await f.host.startAllConversationAgents(conversation.id, f.owner.id)).every(({ outcome }) => outcome === "started"));
    worker.emit("message", { type: "ready", epoch: recorder.epoch });
    for (let index = 0; index < worker.packets.length; index++) {
      const packet = worker.packets[index]!;
      if (packet.record) worker.emit("message", { type: "written", epoch: recorder.epoch, id: packet.record.operationId, revision: packet.record.revision });
    }
    const parent = worker.packets.find(({ record }) => record?.action === "bulk_start")!.record!;
    assert.equal(parent.bulk?.completed, 3); assert.equal(parent.bulk?.started, 3);
    assert.equal(parent.bulk?.childrenUnrecorded, 2); assert.equal(parent.recordingGap, true);
    assert.equal(parent.outcome, "succeeded"); assert.equal(f.runtime.starts, 3);
  } finally { await f.close(); await recorder.close(); }
});

test("lifecycle observations preserve exact start/resume/replacement generations and skip idle interrupts", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    const start = collector.operations.find(({ action }) => action === "start")!;
    assert.equal(start.outcome, "succeeded");
    assert.deepEqual(start.correlations.targetBinding, { id: original.id, generation: original.generation });
    assert.ok(start.events.some(([stage, result]) => stage === "binding_committed" && result === "confirmed"));
    await f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const stop = collector.operations.find(({ action }) => action === "stop")!;
    assert.equal(stop.outcome, "succeeded");
    assert.equal(stop.requestDisposition, "handler_returned");
    assert.ok(stop.events.some(([stage, result, extra]) => stage === "interrupt_requested" && result === "skipped" && extra?.reasonCode === "not_required"));
    assert.ok(!stop.events.some(([stage, result]) => stage === "interrupt_acknowledged" && result === "confirmed"));
    assert.equal(f.runtime.interrupts, 0);
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    assert.equal(f.runtime.starts, 1);
    assert.equal(collector.operations.find(({ action }) => action === "resume")?.outcome, "succeeded");
    await f.host.replaceConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh");
    const replacement = collector.operations.find(({ action }) => action === "replace_fresh")!;
    assert.equal(replacement.outcome, "succeeded");
    assert.deepEqual(replacement.correlations.sourceBinding, { id: original.id, generation: original.generation });
    assert.deepEqual(replacement.correlations.targetBinding, { id: original.id, generation: original.generation + 1 });
    assert.ok(replacement.events.some(([stage, result, extra]) => stage === "handoff_prepared" && result === "skipped" && extra?.reasonCode === "fresh_context"));
    assert.equal(f.runtime.starts, 2);
    const cleanup = collector.operations.find(({ action }) => action === "cleanup")!;
    assert.equal(cleanup.outcome, "succeeded");
    assert.equal(cleanup.relatedOperationId, replacement.operationId);
    assert.deepEqual(cleanup.correlations.sourceBinding, replacement.correlations.sourceBinding);
    await f.useDiagnostics(collector);
    await f.host.reconnectConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const reconnect = collector.operations.find(({ action }) => action === "reconnect")!;
    assert.equal(reconnect.outcome, "succeeded");
    assert.deepEqual(reconnect.correlations.sourceBinding, replacement.correlations.targetBinding);
    assert.equal(f.runtime.starts, 2, "reconnect must not launch another session");
  } finally { await f.close(); }
});

test("cleanup failure is separate from replacement success, and restart retries use only the exact cleanup job", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    const suspend = f.runtime.suspend.bind(f.runtime);
    f.runtime.suspend = async () => { throw new Error("SECRET_CLEANUP_ERROR"); };
    await f.host.replaceConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh");
    const replacement = collector.operations.find(({ action }) => action === "replace_fresh")!;
    const failed = collector.operations.find(({ action }) => action === "cleanup")!;
    assert.equal(replacement.outcome, "succeeded");
    assert.equal(failed.outcome, "unknown");
    assert.equal(failed.relatedOperationId, replacement.operationId);
    assert.deepEqual(failed.correlations.sourceBinding, { id: original.id, generation: original.generation });
    assert.ok(!JSON.stringify(failed).includes("SECRET_CLEANUP_ERROR"));
    const job = (await f.store.listSessionHistory(f.conversation.id, f.agent.id)).find(({ bindingGeneration }) => bindingGeneration === original.generation)!;
    f.runtime.suspend = suspend;
    await f.useDiagnostics(collector);
    await f.host.restore();
    await until(() => collector.operations.some(({ action, outcome, correlations }) => action === "cleanup" && outcome === "succeeded" && correlations.cleanupHistoryId === job.id));
    const retry = collector.operations.find(({ correlations }) => correlations.cleanupHistoryId === job.id)!;
    assert.equal(retry.relatedOperationId, undefined, "do not reconstruct an origin by time or current binding");
    assert.deepEqual(retry.correlations.sourceBinding, { id: original.id, generation: original.generation });
    assert.equal(f.runtime.destructions.includes("fake-session-2"), false);
  } finally { await f.close(); }
});

test("an uncertain Stop retains confirmed fencing without inventing pause or interruption success", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    f.runtime.setWorking(original.runtimeSessionId); f.runtime.interruptFailure = true;
    await assert.rejects(f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id), /held stopped/);
    const stop = collector.operations.find(({ action }) => action === "stop")!;
    assert.equal(stop.outcome, "unknown"); assert.equal(stop.requestDisposition, "handler_failed");
    assert.ok(stop.events.some(([stage, result]) => stage === "delivery_fenced" && result === "confirmed"));
    assert.ok(!stop.events.some(([stage, result]) => (stage === "pause_committed" || stage === "interrupt_acknowledged") && result === "confirmed"));
    assert.equal((await f.store.getBinding(original.id))?.state, "stopping");
    assert.equal(f.host.isAttached(f.conversation.id, f.agent.id), false);
    assert.ok(!JSON.stringify(stop).includes("SECRET_RAW_RUNTIME_ERROR"));
  } finally { await f.close(); }
});

test("committed replacement with unavailable attachment is unknown, not rolled back or reported successful", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    const acquire = f.store.acquireBindingLease.bind(f.store);
    f.store.acquireBindingLease = async (...args) => args[4]?.generation === original.generation + 1 ? undefined : acquire(...args);
    await assert.rejects(f.host.replaceConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh"), /could not be attached/);
    const replacement = collector.operations.find(({ action }) => action === "replace_fresh")!;
    assert.equal(replacement.outcome, "unknown");
    assert.ok(replacement.events.some(([stage, result]) => stage === "binding_committed" && result === "confirmed"));
    assert.ok(!replacement.events.some(([stage, result]) => stage === "route_attached" && result === "confirmed"));
    assert.equal((await f.store.getBinding(original.id))?.generation, original.generation + 1);
    assert.equal(f.runtime.destructions.includes("fake-session-2"), false);
  } finally { await f.close(); }
});

test("Cancel handler return and idle status do not complete cancellation before acknowledgment; competing Stop shares one interrupt", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  let stopping: Promise<void> | undefined;
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const binding = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    f.runtime.sendGate = gate(); f.runtime.interruptGate = gate();
    const trigger = await f.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "@builder hold this turn" });
    await until(async () => await f.runtime.status(binding.runtimeSessionId) === "working");
    await f.host.cancelCurrentConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const cancel = collector.operations.find(({ action }) => action === "cancel_current")!;
    assert.equal(cancel.outcome, "pending"); assert.equal(cancel.requestDisposition, "handler_returned");
    assert.equal(await f.runtime.status(binding.runtimeSessionId), "idle");
    assert.deepEqual(cancel.correlations.sourceBinding, { id: binding.id, generation: binding.generation });
    assert.deepEqual(cancel.correlations.trigger, { messageId: trigger.id, sequence: trigger.sequence });
    await f.host.cancelCurrentConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const duplicate = collector.operations.filter(({ action }) => action === "cancel_current")[1]!;
    assert.equal(duplicate.outcome, "unknown");
    assert.ok(duplicate.events.some(([, result, extra]) => result === "skipped" && extra?.reasonCode === "already_requested"));
    stopping = f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    await until(() => collector.operations.some(({ action, events }) => action === "stop" && events.some(([stage, result]) => stage === "delivery_fenced" && result === "confirmed")));
    assert.equal(cancel.outcome, "pending"); assert.equal(f.runtime.interrupts, 1);
    f.runtime.interruptGate.release(); await stopping;
    assert.equal(cancel.outcome, "succeeded");
    assert.equal(collector.operations.find(({ action }) => action === "stop")?.outcome, "succeeded");
    assert.equal(f.runtime.interrupts, 1);
  } finally { f.runtime.sendGate?.release(); f.runtime.interruptGate?.release(); await stopping?.catch(() => undefined); await f.close(); }
});

test("lost Cancel acknowledgment remains unknown and never records false turn settlement", async () => {
  const collector = new LifecycleCollector();
  const f = await fixture(collector);
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const binding = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    f.runtime.sendGate = gate(); f.runtime.interruptFailure = true;
    await f.client.postMessage(f.conversation.id, { participantId: f.owner.id, body: "@builder hold" });
    await until(async () => await f.runtime.status(binding.runtimeSessionId) === "working");
    await f.host.cancelCurrentConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const cancel = collector.operations.find(({ action }) => action === "cancel_current")!;
    await until(() => cancel.outcome === "unknown");
    assert.equal(cancel.requestDisposition, "handler_returned");
    assert.ok(cancel.events.some(([stage, result]) => stage === "interrupt_acknowledged" && result === "unknown"));
    assert.ok(!cancel.events.some(([stage, result]) => stage === "turn_settled" && result === "confirmed"));
    await f.host.cancelCurrentConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    assert.equal(f.runtime.interrupts, 1);
    assert.equal(f.host.activity(f.conversation.id, f.agent.id)?.phase, "canceling");
  } finally { await f.close(); }
});

test("missing, throwing, stalled and saturated diagnostics do not change lifecycle outcomes", { timeout: 15_000 }, async () => {
  for (const mode of ["missing", "factory", "callbacks", "stalled", "saturated"] as const) {
    const f = await fixture();
    let recorder: DiagnosticRecorder | undefined;
    try {
      let diagnostics: LifecycleDiagnostics | undefined;
      if (mode === "factory") diagnostics = { begin() { throw new Error("private observer error"); } };
      if (mode === "callbacks") { const collector = new LifecycleCollector(); collector.throwObservations = true; diagnostics = collector; }
      if (mode === "stalled" || mode === "saturated") {
        recorder = new DiagnosticRecorder({ path: join(f.directory, "unused.db"), workerFactory: () => ({
          on() { return this; }, unref() {}, postMessage() {}, async terminate() { return 0; },
        }) as unknown as Worker });
        diagnostics = recorder;
        if (mode === "saturated") for (let i = 0; i < 128; i++) recorder.begin(f.scope, "cleanup");
      }
      await f.useDiagnostics(diagnostics);
      await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
      await f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
      await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
      await f.host.replaceConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh");
      assert.deepEqual(await f.host.stopAllConversationAgents(f.conversation.id, f.owner.id), [{ identityId: f.agent.id, outcome: "stopped" }], mode);
      assert.deepEqual(await f.host.startAllConversationAgents(f.conversation.id, f.owner.id), [{ identityId: f.agent.id, outcome: "started" }], mode);
      assert.equal((await f.store.listConversationBindings(f.conversation.id))[0]?.generation, 2, mode);
      assert.equal(f.runtime.starts, 2, mode);
      if (mode === "saturated") assert.equal(recorder?.recordingGap, true);
    } finally { await f.close(); await recorder?.close(); }
  }
});

test("real worker records lifecycle outcomes and daemon journal failure cannot prevent authorized Start/Stop", { timeout: 15_000 }, async () => {
  for (const broken of [false, true]) {
    const f = await fixture();
    let daemon: Awaited<ReturnType<typeof createLocalControlDaemon>> | undefined;
    try {
      const path = join(f.directory, "relay.db");
      const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(path) });
      await store.putWorkspaceConfig((await f.store.getWorkspaceConfig(f.workspace.id))!);
      await store.putAgentConfig((await f.store.getAgentConfig("fixture-config"))!);
      await store.close();
      if (broken) await writeFile(join(f.directory, "agent-diagnostics.db"), "corrupt journal fixture", { mode: 0o600 });
      daemon = await createLocalControlDaemon({ currentHumanIdentityId: f.owner.id, conversationsEndpoint: f.server.endpoint,
        conversationsServiceToken: f.server.serviceToken, relayDatabasePath: path, runtimes: { fake: f.runtime }, port: 0, webUrl: "http://127.0.0.1:5174/" });
      await until(() => broken ? daemon!.diagnosticsStatus().recordingGap : daemon!.diagnosticsStatus().available);
      const bootstrap = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
      const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
      for (const action of ["start", "stop"]) {
        const response: Response = await fetch(`${daemon.endpoint}/local/conversations/${f.conversation.id}/agents/${f.agent.id}/${action}`, {
          method: "POST", headers: { cookie, origin: "http://127.0.0.1:5174" },
        });
        assert.equal(response.status, action === "start" ? 201 : 200, `${broken ? "broken" : "healthy"} journal ${action}`);
      }
      const diagnosticBase = `${daemon.endpoint}/local/conversations/${f.conversation.id}/agents/${f.agent.id}`;
      const readHeaders = { cookie, origin: "http://127.0.0.1:5174" };
      if (!broken) await until(async () => {
        const history = await (await fetch(`${diagnosticBase}/operations`, { headers: readHeaders })).json() as { operations: unknown[] };
        return history.operations.length === 2;
      });
      const publicHistory = await (await fetch(`${diagnosticBase}/operations`, { headers: readHeaders })).json() as {
        protocolVersion: number; coverage: string; operations: Array<{ operationId: string }>;
      };
      assert.equal(publicHistory.protocolVersion, 24);
      assert.equal(publicHistory.coverage, broken ? "unavailable" : "available");
      const selectedId = publicHistory.operations[0]?.operationId ?? "operation-unrecorded";
      const report = await fetch(`${diagnosticBase}/diagnostic-report?operationId=${selectedId}`, { headers: readHeaders });
      assert.equal(report.status, 200);
      assert.doesNotMatch(await report.text(), /runtimeSessionId|runtimeOwnerId|managedSessionId|recorderEpoch|SECRET/);
      await daemon.close(); daemon = undefined;
      if (broken) assert.equal(await readFile(join(f.directory, "agent-diagnostics.db"), "utf8"), "corrupt journal fixture");
      else {
        const journal = await DiagnosticJournal.open(join(f.directory, "agent-diagnostics.db"), "verification-epoch");
        try {
          const history = await journal.history(f.scope);
          assert.equal(history.operations.length, 2);
          assert.ok(history.operations.every(({ outcome, requestDisposition }) => outcome === "succeeded" && requestDisposition === "handler_returned"));
        } finally { await journal.close(); }
      }
      assert.equal(f.runtime.starts, 1);
    } finally { await daemon?.close(); await f.close(); }
  }
});


test("individual Stop leaves another participant usable through real host admission without bypassing Conversation fences", async () => {
  const { f, agents, conversation } = await bulkFixture(undefined, 2);
  const other = agents[1]!;
  const control = new LocalControlService({
    conversations: f.client, bindings: f.store, runtimes: { fake: f.runtime }, lifecycle: f.host,
    configuration: new LocalAgentHostConfiguration({ client: f.client, store: f.store }),
  });
  let stopping: ReturnType<typeof control.stopConversationAgent> | undefined;
  try {
    await f.host.startConversationAgent(conversation.id, f.agent.id, f.owner.id);
    const original = (await f.store.listConversationBindings(conversation.id))[0]!;
    f.runtime.setWorking(original.runtimeSessionId);
    f.runtime.interruptGate = gate();
    // The legacy and receipt APIs must share participant-scoped admission all
    // the way through the real host, not just a fake lifecycle port.
    stopping = control.stopConversationAgent(conversation.id, f.agent.id, f.owner.id);
    await until(() => f.runtime.interrupts === 1);
    await assert.rejects(control.submitAgentAction(conversation.id, f.owner.id,
      { requestId: "overlapping-stop", action: "stop", identityId: f.agent.id }), /already pending/);
    await assert.rejects(control.submitAgentAction(conversation.id, f.owner.id,
      { requestId: "overlapping-bulk", action: "stop-all" }), /already pending/);
    for (const action of ["start", "replace-fresh"] as const) {
      const requestId = `other-${action}`;
      await control.submitAgentAction(conversation.id, f.owner.id, { requestId, action, identityId: other.id });
      await until(async () => (await control.readAgentAction(conversation.id, f.owner.id, requestId)).state !== "pending");
      const receipt = await control.readAgentAction(conversation.id, f.owner.id, requestId);
      assert.equal(receipt.state, "succeeded", receipt.error);
      assert.equal(f.host.isAttached(conversation.id, other.id), true);
      assert.equal((await f.store.getBinding(original.id))!.state, "stopping");
    }
    const release = f.host.fenceConversationAdmission(conversation.id);
    try {
      await assert.rejects(control.startConversationAgent(conversation.id, other.id, f.owner.id), /Conversation lifecycle transition/);
    } finally { release(); }
    f.runtime.interruptGate.release();
    await stopping;
    const stopped = (await f.store.getBinding(original.id))!;
    assert.equal(stopped.state, "paused");
    assert.equal(stopped.generation, original.generation);
    assert.equal(stopped.runtimeSessionId, original.runtimeSessionId);
    assert.equal(f.host.isAttached(conversation.id, f.agent.id), false);
    assert.equal(f.host.isAttached(conversation.id, other.id), true);
  } finally { f.runtime.interruptGate?.release(); await stopping?.catch(() => undefined); await f.close(); }
});

test("Fresh-session rejection and post-commit uncertainty stay distinct without a diagnostic recorder", async () => {
  const f = await fixture();
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    f.runtime.setWorking(original.runtimeSessionId);
    await assert.rejects(f.host.replaceConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh"),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.actionOutcome === "failed");
    assert.equal(f.runtime.starts, 1);
    assert.equal((await f.store.getBinding(original.id))!.generation, original.generation);
    await f.runtime.interrupt(original.runtimeSessionId);
    f.runtime.unreachable.add("fake-session-2");
    await assert.rejects(f.host.replaceConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh"),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.actionOutcome === "unconfirmed");
    assert.equal(f.runtime.starts, 2);
    assert.equal((await f.store.getBinding(original.id))!.generation, original.generation + 1);
  } finally { await f.close(); }
});

test("requesting Fresh start for a paused participant never resumes its old transcript", async () => {
  const f = await fixture();
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    await f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    await assert.rejects(f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh"), /Fresh session replacement/);
    assert.equal(f.runtime.starts, 1);
    assert.equal((await f.store.listConversationBindings(f.conversation.id))[0]!.state, "paused");
    await f.host.replaceConversationAgent(f.conversation.id, f.agent.id, f.owner.id, "fresh");
    assert.equal(f.runtime.starts, 2);
    assert.equal((await f.store.listSessionHistory(f.conversation.id, f.agent.id)).find(record => record.state === "active")!.contextMode, "fresh");
  } finally { await f.close(); }
});


for (const persistent of [false, true]) test(`an explicit Stop retry verifies the same fenced session without resuming or replacing it (${persistent ? "SQLite" : "memory"})`, async () => {
  const databaseDirectory = await mkdtemp(join(tmpdir(), "channels-stop-retry-"));
  const store = persistent ? await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(databaseDirectory, "relay.db")) }) : new InMemoryRelayBindingStore();
  const f = await fixture(undefined, store);
  try {
    await f.host.startConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const original = (await f.store.listConversationBindings(f.conversation.id))[0]!;
    f.runtime.setWorking(original.runtimeSessionId);
    f.runtime.interruptFailure = true;
    await assert.rejects(f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.actionOutcome === "unconfirmed");
    assert.equal((await f.store.getBinding(original.id))!.state, "stopping");
    assert.equal(f.host.isAttached(f.conversation.id, f.agent.id), false);
    f.runtime.interruptFailure = false;
    await f.host.stopConversationAgent(f.conversation.id, f.agent.id, f.owner.id);
    const stopped = (await f.store.getBinding(original.id))!;
    assert.equal(stopped.state, "paused");
    assert.equal(stopped.generation, original.generation);
    assert.equal(stopped.runtimeSessionId, original.runtimeSessionId);
    assert.equal(f.runtime.starts, 1);
    assert.equal(f.runtime.interrupts, 2);
    assert.equal(f.host.isAttached(f.conversation.id, f.agent.id), false);
  } finally { await f.close(); await rm(databaseDirectory, { recursive: true, force: true }); }
});
