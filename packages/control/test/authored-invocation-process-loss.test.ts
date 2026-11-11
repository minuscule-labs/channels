import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationClient, ConversationService, createConversationHttpServer, createResourceId } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import type { RuntimePortTurn } from "@minu/channels-relay";
import { LocalAgentHost, type ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import { LocalControlService } from "../src/server.ts";
import type { LocalAuthoredSkillInvocationReceipt } from "../src/contracts.ts";
import type { HostWorkerInit, HostWorkerMessage } from "./fixtures/authored-invocation-host-worker.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Process-loss recovery condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Survives outside the killed host process; this is not a genuine provider or provider restart. */
class ExternalRuntime {
  session?: { id: string; ownerId: string };
  accepted?: RuntimePortTurn;
  managedStarts = 0;
  readonly starts: Array<{ sessionId: string; turnId: string; input: string }> = [];
  readonly lookups: string[] = [];
  readonly forbidden: string[] = [];
  async start(): Promise<never> { throw new Error("Managed sessions required"); }
  async startManaged(_config: ManagedRuntimeStartConfig, ownerId: string) {
    this.managedStarts += 1;
    assert.equal(this.session, undefined, "Recovery cannot replace the original Runtime session");
    this.session = { id: "process-loss-session", ownerId };
    return { ...this.session };
  }
  async getManagedSession(id: string, ownerId: string) {
    return this.session?.id === id && this.session.ownerId === ownerId ? { ...this.session, state: "active" as const } : undefined;
  }
  async listManagedSessions(ownerId: string) { return this.session?.ownerId === ownerId ? [{ ...this.session, state: "active" as const }] : []; }
  async resume(id: string, ownerId: string) { assert.deepEqual({ id, ownerId }, this.session); return { ...this.session! }; }
  async status(id: string) { assert.equal(id, this.session?.id); return this.accepted?.status === "running" ? "working" as const : "idle" as const; }
  async messages() { return [{ role: "assistant" as const, content: "PRIVATE_EXTERNAL_TRANSCRIPT" }]; }
  async send() { this.forbidden.push("legacy_send"); throw new Error("No legacy fallback"); }
  async suspend() { this.forbidden.push("suspend"); }
  async interrupt() { this.forbidden.push("interrupt"); }
  async turn(sessionId: string, turnId: string) {
    assert.equal(sessionId, this.session?.id);
    this.lookups.push(turnId);
    return this.accepted?.id === turnId ? { ...this.accepted } : undefined;
  }
  async startTurn(sessionId: string, turnId: string, input: string) {
    this.starts.push({ sessionId, turnId, input });
    assert.equal(this.accepted, undefined, "A retained accepted turn must never receive another start");
    assert.equal(sessionId, this.session?.id);
    const now = new Date().toISOString();
    this.accepted = { id: turnId, input, status: "running", createdAt: now, updatedAt: now };
    return { ...this.accepted };
  }
  complete() {
    this.accepted = { ...this.accepted!, status: "completed", response: { role: "assistant", content: "Recovered after process loss" } };
  }
}

function startWorker(input: HostWorkerInit, runtime: ExternalRuntime) {
  const child = fork(new URL("./fixtures/authored-invocation-host-worker.js", import.meta.url), [], {
    silent: true, execArgv: process.execArgv.filter(argument => argument === "--experimental-sqlite"),
  });
  let stderr = "";
  child.stderr!.on("data", data => { stderr += data; });
  let resolveStarted!: (value: Extract<HostWorkerMessage, { type: "started" }>) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<Extract<HostWorkerMessage, { type: "started" }>>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => {
    rejectStarted(new Error(`Host worker exited (${code ?? signal}): ${stderr}`));
    resolve({ code, signal });
  }));
  child.on("error", rejectStarted);
  let withheldStartAcknowledgments = 0;
  const allowedMethods = new Set(["start", "startManaged", "getManagedSession", "listManagedSessions", "resume", "status", "messages", "send", "suspend", "interrupt", "turn", "startTurn"]);
  child.on("message", (message: HostWorkerMessage) => {
    if (message.type === "ready") child.send(input);
    else if (message.type === "started") resolveStarted(message);
    else if (message.type === "failed") rejectStarted(new Error(message.message));
    else if (message.type === "runtime") {
      void (async () => {
        assert.ok(allowedMethods.has(message.method));
        const method = runtime[message.method as keyof ExternalRuntime] as (...args: unknown[]) => Promise<unknown>;
        const value = await method.apply(runtime, message.args);
        // The Runtime accepts work, but the old host never gets this RPC acknowledgment before SIGKILL.
        if (message.method === "startTurn") { withheldStartAcknowledgments += 1; return; }
        if (child.connected) child.send({ type: "runtime_result", id: message.id, value });
      })().catch(error => {
        if (child.connected) child.send({ type: "runtime_result", id: message.id, error: String(error) });
      });
    }
  });
  return { child, started, exit, get withheldStartAcknowledgments() { return withheldStartAcknowledgments; },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) assert.equal(child.kill("SIGKILL"), true);
      return exit;
    } };
}

test("unclean host process loss retains the lease until expiry and reconciles original work without blind sends or duplicates", { timeout: 25_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "channels-authored-process-loss-")));
  const relayUrl = localRelayLibSqlUrl(join(directory, "relay.db"));
  let coreStorage!: DrizzleLibSqlConversationStorage;
  let core!: Awaited<ReturnType<typeof createConversationHttpServer>>;
  let store!: DrizzleLibSqlRelayStorage;
  let host: LocalAgentHost | undefined;
  let worker: ReturnType<typeof startWorker> | undefined;
  try {
    coreStorage = await DrizzleLibSqlConversationStorage.open({ url: `file:${join(directory, "core.db")}` });
    core = await createConversationHttpServer({ service: new ConversationService(coreStorage), port: 0 });
    let client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
    store = await DrizzleLibSqlRelayStorage.open({ url: relayUrl });
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const member = await client.createIdentity({ type: "human", displayName: "Invoker" });
    const agent = await client.createIdentity({ type: "agent", displayName: "Worker" });
    const workspace = await client.createWorkspace({ slug: "process-loss", name: "Process loss" });
    for (const [identity, accessRole] of [[owner, "owner"], [member, "member"], [agent, "member"]] as const) {
      await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase(), accessRole });
    }
    const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id, agent.id] });
    let now = Date.now();
    const timestamp = new Date(now).toISOString();
    await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: directory, createdAt: timestamp, updatedAt: timestamp });
    await store.putAgentConfig({ id: "process-loss-config", workspaceId: workspace.id, agentIdentityId: agent.id,
      runtimeAdapter: "retained", status: "active", createdAt: timestamp, updatedAt: timestamp });
    let configuration = new LocalAgentHostConfiguration({ client, store });
    const skill = await configuration.createAuthoredDocument(workspace.id, owner.id,
      { kind: "skill", name: "Recovery decision", description: "Process loss case", content: "PRIVATE_PROCESS_PROCEDURE_V1" });
    await configuration.updateAuthoredDocument(workspace.id, skill.id, owner.id, { action: "publish", expectedVersion: 1 });
    const runtime = new ExternalRuntime();
    worker = startWorker({ type: "initialize", endpoint: core.endpoint, serviceToken: core.serviceToken, relayUrl,
      conversationId: conversation.id, agentId: agent.id, ownerId: owner.id, memberId: member.id, now: timestamp }, runtime);
    const ready = await worker.started;
    assert.equal(ready.pid, worker.child.pid);
    assert.notEqual(ready.pid, process.pid);
    const bootstrap = await fetch(ready.launchUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174", "content-type": "application/json" };
    const acceptance = `/local/conversations/${conversation.id}/skill-invocations`;
    const publications = `/local/conversations/${conversation.id}/skill-invocation-publications`;
    const receipts: LocalAuthoredSkillInvocationReceipt[] = [];
    for (const key of ["process-original", "process-unpublished", "process-unobserved"]) {
      const response = await fetch(`${ready.endpoint}${acceptance}`, { method: "POST", headers: { ...headers, "idempotency-key": key },
        body: JSON.stringify({ documentId: skill.id, source: "workspace", revision: 1, arguments: key, to: [agent.id] }) });
      assert.equal(response.status, 202);
      receipts.push(await response.json() as LocalAuthoredSkillInvocationReceipt);
    }
    const [original, unpublished, unobserved] = receipts as [LocalAuthoredSkillInvocationReceipt, LocalAuthoredSkillInvocationReceipt, LocalAuthoredSkillInvocationReceipt];
    assert.equal((await fetch(`${ready.endpoint}${publications}`, { method: "POST", headers,
      body: JSON.stringify({ requestId: original.requestId, invocationId: original.id }) })).status, 405, "Child producer is default-off");
    const unresolvedLink = { invocationId: unobserved.id, messageId: createResourceId("message") };
    assert.deepEqual(await store.reserveAuthoredInvocationMessageLink(unresolvedLink), unresolvedLink);
    // Explicit trusted test setup only; the child's HTTP producer remains disabled.
    const published = await configuration.publishAuthoredSkillInvocation(conversation.id, member.id, { requestId: original.requestId, invocationId: original.id });
    assert.equal(published.status, "observed");
    await until(() => runtime.starts.length === 1 && worker!.withheldStartAcknowledgments === 1);
    const first = runtime.starts[0]!;
    assert.equal(first.turnId, `conversation:${conversation.id}:${agent.id}:${published.messageId}`);
    assert.match(first.input, /PRIVATE_PROCESS_PROCEDURE_V1/);
    const snapshot = async () => {
      const binding = (await store.listConversationBindings(conversation.id))[0]!;
      const { activation } = await store.getSessionInspectionRecords(workspace.id, conversation.id, agent.id);
      return { operations: await Promise.all(receipts.map(receipt => store.getAuthoredSkillInvocation(conversation.id, member.id, receipt.requestId))),
        links: await Promise.all(receipts.map(receipt => store.getAuthoredInvocationMessageLink(receipt.id))),
        binding: { id: binding.id, generation: binding.generation, runtimeSessionId: binding.runtimeSessionId, runtimeOwnerId: binding.runtimeOwnerId },
        authoredContext: activation?.authoredContext };
    };
    const before = await snapshot();
    const held = (await store.listConversationBindings(conversation.id))[0]!;
    assert.equal(held.leaseOwner, `crash-child:${ready.pid}`);
    assert.ok(held.leaseExpiresAt && held.leaseExpiresAt > timestamp);
    assert.equal(await store.getCursor(conversation.id, agent.id), 0);
    const originalMessages = await client.listMessages(conversation.id);
    assert.equal(originalMessages.length, 1);
    assert.equal(originalMessages[0]!.id, published.messageId);
    assert.deepEqual(await worker.kill(), { code: null, signal: "SIGKILL" });

    // No old-host close/release/repair runs. Reopen the observer store after the actual OS-process death.
    await store.close();
    store = await DrizzleLibSqlRelayStorage.open({ url: relayUrl });
    assert.deepEqual(await store.getBinding(held.id), held, "SIGKILL must leave the original live lease persisted");
    client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
    configuration = new LocalAgentHostConfiguration({ client, store });
    let forbiddenPublications = 0;
    const prohibited = async () => { forbiddenPublications += 1; throw new Error("PRIVATE_BLIND_PROCESS_RECOVERY_PUBLICATION"); };
    client.postMessage = prohibited;
    store.reserveAuthoredSkillInvocation = prohibited;
    store.reserveAuthoredInvocationMessageLink = prohibited;
    const postResponse = client.postResponse.bind(client);
    let responseAttempts = 0;
    client.postResponse = async (...args) => { responseAttempts += 1; return postResponse(...args); };
    runtime.lookups.length = 0;
    const recoveryOwner = `crash-recovery:${process.pid}`;
    now = Date.parse(held.leaseExpiresAt!) - 1;
    host = new LocalAgentHost({ client, store, runtimes: { retained: runtime }, leaseOwner: recoveryOwner, now: () => new Date(now),
      bindingLeaseDurationMs: 30_000, recoveryBackoffMs: [60_000], autoResumeOfflineAgents: false, stopStartedSessionsOnClose: false });
    const service = new LocalControlService({ conversations: client, bindings: store, runtimes: { retained: runtime }, configuration, lifecycle: host });
    assert.equal(service.authoredSkillPublicationEnabled, false, "Replacement producer defaults off without an option");
    await host.restore();
    assert.deepEqual(await store.getBinding(held.id), held, "A new host cannot steal the still-live dead host's lease");
    assert.deepEqual(runtime.lookups, []);
    assert.equal(runtime.starts.length, 1);
    assert.equal(responseAttempts, 0);
    assert.deepEqual(await client.listMessages(conversation.id), originalMessages);

    // Select expiry through the host clock, not by editing/releasing the durable lease or waiting 30 seconds.
    now = Date.parse(held.leaseExpiresAt!) + 1;
    await host.restore();
    await until(() => runtime.lookups.includes(first.turnId));
    const taken = (await store.getBinding(held.id))!;
    assert.equal(taken.leaseOwner, recoveryOwner);
    assert.ok(taken.leaseExpiresAt! > new Date(now).toISOString());
    assert.equal(runtime.starts.length, 1);
    assert.equal(runtime.accepted?.status, "running");
    runtime.complete();
    await until(async () => (await client.listMessages(conversation.id)).some(row => row.body === "Recovered after process loss"));
    await until(async () => (await store.getCursor(conversation.id, agent.id)) >= originalMessages[0]!.sequence
      && host!.workSnapshot().activeTurns === 0 && host!.workSnapshot().queuedTurnsExact && host!.workSnapshot().queuedTurns === 0);
    const messages = await client.listMessages(conversation.id);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.find(row => row.id === published.messageId), originalMessages[0]);
    const response = messages.find(row => row.body === "Recovered after process loss")!;
    assert.equal(response.replyTo, published.messageId);
    assert.equal(response.participantId, agent.id);
    assert.equal(responseAttempts, 1);
    assert.equal(runtime.starts.length, 1);
    assert.equal(runtime.managedStarts, 1);
    assert.deepEqual(runtime.forbidden, []);
    assert.equal(forbiddenPublications, 0);
    assert.deepEqual(await snapshot(), before);
    const observed = await configuration.getAuthoredSkillInvocationPublication(conversation.id, member.id, original.requestId);
    assert.equal(observed.status, "observed");
    assert.equal(observed.messageId, published.messageId);
    assert.equal((await configuration.getAuthoredSkillInvocationPublication(conversation.id, member.id, unpublished.requestId)).status, "not_linked");
    const unresolved = await configuration.getAuthoredSkillInvocationPublication(conversation.id, member.id, unobserved.requestId);
    assert.equal(unresolved.status, "not_observed");
    assert.equal(unresolved.messageId, unresolvedLink.messageId);
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_PROCESS_PROCEDURE|PRIVATE_EXTERNAL_TRANSCRIPT|process-loss-session/);
    console.log("Confirmed child SIGKILL; original lease retained and denied before expiry; new owner acquired after clock-selected expiry; starts=1, replies=1, blind publication/reservations=0");
  } finally {
    await worker?.kill();
    await host?.close();
    await store?.close();
    await core?.close();
    await coreStorage?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
