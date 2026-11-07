import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, ConversationService, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "@minu/channels-storage-drizzle";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import type { RuntimePortTurn } from "@minu/channels-relay";
import { LocalAgentHost, type ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import { LocalControlService, LocalControlBrowserSessions, createLocalControlHttpServer } from "../src/server.ts";
import type { LocalAuthoredSkillInvocationReceipt, LocalAuthoredSkillInvocationPublicationReceipt } from "../src/contracts.ts";

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Recovery fixture condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Retained external Runtime simulation; only Core/Control/host/store instances restart. */
class RetainedRuntime {
  readonly sessions = new Map<string, { ownerId: string; config: ManagedRuntimeStartConfig }>();
  readonly turns = new Map<string, RuntimePortTurn>();
  readonly starts: Array<{ sessionId: string; turnId: string; input: string }> = [];
  readonly lookups: string[] = [];
  busy = false;
  runningNewTurns = false;
  loseNextStartAck = false;
  legacySends = 0;
  interrupts = 0;
  suspensions = 0;
  async start(): Promise<never> { throw new Error("Managed sessions required"); }
  async startManaged(config: ManagedRuntimeStartConfig, ownerId: string) {
    const id = `retained-session-${this.sessions.size + 1}`;
    this.sessions.set(id, { ownerId, config });
    return { id, ownerId };
  }
  async getManagedSession(id: string, ownerId: string) {
    return this.sessions.get(id)?.ownerId === ownerId ? { id, ownerId, state: "active" as const } : undefined;
  }
  async listManagedSessions(ownerId: string) {
    return [...this.sessions].filter(([, session]) => session.ownerId === ownerId)
      .map(([id]) => ({ id, ownerId, state: "active" as const }));
  }
  async resume(id: string, ownerId: string) { assert.equal(this.sessions.get(id)?.ownerId, ownerId); return { id, ownerId }; }
  async suspend() { this.suspensions += 1; }
  async status(id: string) {
    if (!this.sessions.has(id)) return "offline" as const;
    return this.busy || [...this.turns.values()].some(turn => turn.status === "running") ? "working" as const : "idle" as const;
  }
  async send() { this.legacySends += 1; throw new Error("No legacy send"); }
  async interrupt() { this.interrupts += 1; }
  async messages() { return [{ role: "assistant" as const, content: "PRIVATE_RUNTIME_TRANSCRIPT" }]; }
  async turn(_sessionId: string, turnId: string) {
    this.lookups.push(turnId);
    const turn = this.turns.get(turnId);
    return turn ? { ...turn } : undefined;
  }
  async startTurn(sessionId: string, turnId: string, input: string) {
    this.starts.push({ sessionId, turnId, input });
    assert.equal(this.turns.has(turnId), false, "Recovery must query an existing turn rather than issue a duplicate start");
    const now = new Date().toISOString();
    const turn: RuntimePortTurn = { id: turnId, input, status: this.runningNewTurns ? "running" : "completed",
      ...(this.runningNewTurns ? {} : { response: { role: "assistant" as const, content: "Recovered decision" } }), createdAt: now, updatedAt: now };
    this.turns.set(turnId, turn);
    if (this.loseNextStartAck) { this.loseNextStartAck = false; throw new Error("PRIVATE_RUNTIME_ACK_LOST"); }
    return { ...turn };
  }
  complete(turnId: string) {
    const turn = this.turns.get(turnId)!;
    this.turns.set(turnId, { ...turn, status: "completed", response: { role: "assistant", content: "Recovered decision" } });
  }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "channels-authored-host-restart-")));
  const coreUrl = `file:${join(directory, "core.db")}`;
  const relayUrl = localRelayLibSqlUrl(join(directory, "relay.db"));
  let coreStorage = await DrizzleLibSqlConversationStorage.open({ url: coreUrl });
  let core = await createConversationHttpServer({ service: new ConversationService(coreStorage), port: 0 });
  let client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  let store = await DrizzleLibSqlRelayStorage.open({ url: relayUrl });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const member = await client.createIdentity({ type: "human", displayName: "Invoker" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Worker" });
  const workspace = await client.createWorkspace({ slug: "recovery", name: "Recovery" });
  for (const [identity, accessRole] of [[owner, "owner"], [member, "member"], [agent, "member"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase(), accessRole });
  }
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id, agent.id] });
  const now = new Date().toISOString();
  await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: directory, createdAt: now, updatedAt: now });
  await store.putAgentConfig({ id: "recovery-config", workspaceId: workspace.id, agentIdentityId: agent.id,
    runtimeAdapter: "retained", status: "active", createdAt: now, updatedAt: now });
  let configuration = new LocalAgentHostConfiguration({ client, store });
  const skill = await configuration.createAuthoredDocument(workspace.id, owner.id,
    { kind: "skill", name: "Recovery decision", description: "Record the decision", content: "PRIVATE_PROCEDURE_V1" });
  await configuration.updateAuthoredDocument(workspace.id, skill.id, owner.id, { action: "publish", expectedVersion: 1 });
  const runtime = new RetainedRuntime();
  let epoch = 1;
  const makeHost = () => new LocalAgentHost({ client, store, runtimes: { retained: runtime }, leaseOwner: `recovery-host-${epoch}`,
    autoResumeOfflineAgents: false, stopStartedSessionsOnClose: false });
  let host = makeHost();
  await host.startConversationAgent(conversation.id, agent.id, owner.id);
  let control: Awaited<ReturnType<typeof createLocalControlHttpServer>> | undefined;
  let headers!: Record<string, string>;
  let recoveryPublicationEffects = 0;
  const launchControl = async (enabled: boolean) => {
    const service = new LocalControlService({ conversations: client, bindings: store, runtimes: { retained: runtime }, configuration,
      lifecycle: host, authoredSkillPublicationEnabled: enabled });
    const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: member.id });
    control = await createLocalControlHttpServer({ service, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], port: 0 });
    const bootstrap = await fetch(sessions.issueLaunchUrl(control.endpoint), { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!, origin: sessions.browserOrigin, "content-type": "application/json" };
  };
  await launchControl(true); // Explicit opt-in only in this disposable initial fixture.
  const key = "restart /?#+% ü";
  const request = (path: string, method = "GET", body?: unknown) => fetch(`${control!.endpoint}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const collection = `/local/conversations/${conversation.id}/skill-invocation-publications`;
  const acceptedResponse = await fetch(`${control!.endpoint}/local/conversations/${conversation.id}/skill-invocations`, {
    method: "POST", headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify({ documentId: skill.id, source: "workspace", revision: 1, arguments: "RECOVERY_ARGUMENTS @channel is task text", to: [agent.id] }),
  });
  assert.equal(acceptedResponse.status, 202);
  const receipt = await acceptedResponse.json() as LocalAuthoredSkillInvocationReceipt;
  return {
    owner, member, agent, workspace, conversation, skill, runtime, receipt,
    get client() { return client; }, get store() { return store; }, get host() { return host; }, get configuration() { return configuration; },
    get recoveryPublicationEffects() { return recoveryPublicationEffects; },
    publish: () => request(collection, "POST", { requestId: receipt.requestId, invocationId: receipt.id }),
    inspect: () => request(`${collection}?${new URLSearchParams({ requestId: receipt.requestId })}`),
    async snapshot() {
      const binding = (await store.listConversationBindings(conversation.id))[0]!;
      const { activation } = await store.getSessionInspectionRecords(workspace.id, conversation.id, agent.id);
      return { operation: await store.getAuthoredSkillInvocation(conversation.id, member.id, receipt.requestId),
        link: await store.getAuthoredInvocationMessageLink(receipt.id), binding: { id: binding.id, generation: binding.generation,
          runtimeSessionId: binding.runtimeSessionId, runtimeOwnerId: binding.runtimeOwnerId }, authoredContext: activation?.authoredContext };
    },
    async restart(beforeRestore?: () => Promise<void>) {
      await control?.close(); control = undefined;
      await host.close(); await store.close(); await core.close(); await coreStorage.close();
      epoch += 1;
      coreStorage = await DrizzleLibSqlConversationStorage.open({ url: coreUrl });
      core = await createConversationHttpServer({ service: new ConversationService(coreStorage), port: 0 });
      client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
      store = await DrizzleLibSqlRelayStorage.open({ url: relayUrl });
      configuration = new LocalAgentHostConfiguration({ client, store });
      await beforeRestore?.();
      const prohibited = async () => { recoveryPublicationEffects += 1; throw new Error("PRIVATE_BLIND_RECOVERY_PUBLICATION"); };
      client.postMessage = prohibited;
      store.reserveAuthoredSkillInvocation = prohibited;
      store.reserveAuthoredInvocationMessageLink = prohibited;
      runtime.lookups.length = 0;
      host = makeHost();
      await launchControl(false); // A restart does not enable the default-off producer.
      await host.restore();
    },
    async close() {
      await control?.close(); control = undefined;
      await host.close(); await store.close(); await core.close(); await coreStorage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function assertPreserved(f: Awaited<ReturnType<typeof fixture>>, before: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["snapshot"]>>) {
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.runtime.sessions.size, 1, "Host restart must not replace the worker");
  assert.equal(f.runtime.interrupts, 0);
  assert.equal(f.runtime.suspensions, 0);
  assert.equal(f.runtime.legacySends, 0);
  assert.equal(f.recoveryPublicationEffects, 0, "Recovery must not create/reserve another invocation or public trigger");
  assert.doesNotMatch(JSON.stringify(await f.client.listMessages(f.conversation.id)), /PRIVATE_PROCEDURE|PRIVATE_RUNTIME_TRANSCRIPT|retained-session/);
}

for (const state of ["accepted_only", "linked_unobserved"] as const) {
  test(`host restart preserves ${state} without draining intent or resending`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      if (state === "linked_unobserved") {
        const reserve = f.store.reserveAuthoredInvocationMessageLink.bind(f.store);
        f.store.reserveAuthoredInvocationMessageLink = async link => { await reserve(link); throw new Error("PRIVATE_LINK_ACK_LOST"); };
        assert.equal((await f.publish()).status, 409);
      }
      const before = await f.snapshot();
      await f.restart();
      await until(() => f.host.workSnapshot().queuedTurnsExact);
      assert.equal(f.runtime.starts.length, 0);
      assert.deepEqual(await f.client.listMessages(f.conversation.id), []);
      const response = await f.inspect();
      assert.equal(response.status, 200);
      const observation = await response.json() as LocalAuthoredSkillInvocationPublicationReceipt;
      assert.equal(observation.status, state === "accepted_only" ? "not_linked" : "not_observed");
      assert.equal((await f.publish()).status, 405, "Restart must leave the producer disabled");
      await assertPreserved(f, before);
    } finally { await f.close(); }
  });
}

for (const policy of ["active_new_revision", "archive", "actor_revoked"] as const) {
  test(`host restart handles published unstarted ${policy} using the original pinned trigger`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      f.runtime.busy = true;
      assert.equal((await f.publish()).status, 200);
      const message = (await f.client.listMessages(f.conversation.id))[0]!;
      const turnId = `conversation:${f.conversation.id}:${f.agent.id}:${message.id}`;
      await until(() => f.runtime.lookups.includes(turnId));
      assert.equal(f.runtime.starts.length, 0);
      const before = await f.snapshot();
      await f.restart(async () => {
        if (policy === "archive") await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
        else if (policy === "actor_revoked") await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
        else {
          await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "save", expectedVersion: 2, name: f.skill.name, description: f.skill.description, content: "PRIVATE_PROCEDURE_V2" });
          await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "publish", expectedVersion: 3 });
        }
        f.runtime.busy = false;
      });
      await until(async () => (await f.client.listMessages(f.conversation.id)).some(row => row.replyTo === message.id));
      const messages = await f.client.listMessages(f.conversation.id);
      assert.equal(messages.filter(row => row.authoredInvocationId === f.receipt.id).length, 1);
      assert.equal(messages.find(row => row.authoredInvocationId === f.receipt.id)?.id, message.id);
      if (policy === "active_new_revision") {
        assert.equal(f.runtime.starts.length, 1);
        assert.equal(f.runtime.starts[0]!.turnId, turnId);
        assert.match(f.runtime.starts[0]!.input, /PRIVATE_PROCEDURE_V1/);
        assert.doesNotMatch(f.runtime.starts[0]!.input, /PRIVATE_PROCEDURE_V2/);
      } else assert.equal(f.runtime.starts.length, 0);
      assert.equal((await f.inspect()).status, policy === "actor_revoked" ? 403 : 200);
      await assertPreserved(f, before);
    } finally { await f.close(); }
  });
}

for (const policy of ["archive", "actor_revoked"] as const) {
  test(`host restart reconciles an accepted uncertain Runtime turn after ${policy} without starting again`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      f.runtime.runningNewTurns = true;
      f.runtime.loseNextStartAck = true;
      assert.equal((await f.publish()).status, 200);
      await until(() => f.runtime.starts.length === 1);
      const original = f.runtime.starts[0]!;
      const before = await f.snapshot();
      await f.restart(async () => {
        if (policy === "archive") await f.configuration.updateAuthoredDocument(f.workspace.id, f.skill.id, f.owner.id, { action: "archive", expectedVersion: 2 });
        else await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
        f.store.listAuthoredDocumentRevisions = async () => { throw new Error("PRIVATE_RUNNING_TURN_MUST_NOT_RELOAD_PROCEDURE"); };
      });
      await until(() => f.runtime.lookups.includes(original.turnId));
      assert.equal(f.runtime.starts.length, 1);
      f.runtime.complete(original.turnId);
      await until(async () => (await f.client.listMessages(f.conversation.id)).some(row => row.body === "Recovered decision"));
      assert.equal(f.runtime.starts.length, 1);
      const messages = await f.client.listMessages(f.conversation.id);
      assert.equal(messages.filter(row => row.authoredInvocationId === f.receipt.id).length, 1);
      assert.equal(messages.filter(row => row.body === "Recovered decision").length, 1);
      await assertPreserved(f, before);
    } finally { await f.close(); }
  });
}

for (const acknowledgmentLost of [false, true]) {
  test(`host restart reconciles a completed Runtime turn with ${acknowledgmentLost ? "committed response acknowledgment loss" : "uncommitted response"}`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      const post = f.client.postResponse.bind(f.client);
      let responseAttempted = false;
      let originalResponseId: string | undefined;
      f.client.postResponse = async (...args) => {
        if (acknowledgmentLost) originalResponseId = (await post(...args)).message.id;
        responseAttempted = true;
        throw new Error("PRIVATE_RESPONSE_TRANSPORT_FAILURE");
      };
      assert.equal((await f.publish()).status, 200);
      await until(() => responseAttempted);
      assert.equal(f.runtime.starts.length, 1);
      const original = f.runtime.starts[0]!;
      const before = await f.snapshot();
      await f.restart();
      await until(async () => (await f.client.listMessages(f.conversation.id)).some(row => row.body === "Recovered decision"));
      await until(async () => (await f.store.getCursor(f.conversation.id, f.agent.id)) > 0);
      const responses = (await f.client.listMessages(f.conversation.id)).filter(row => row.body === "Recovered decision");
      assert.equal(responses.length, 1);
      if (acknowledgmentLost) assert.equal(responses[0]!.id, originalResponseId);
      assert.equal(f.runtime.starts.length, 1);
      assert.equal(f.runtime.starts[0]!.turnId, original.turnId);
      await assertPreserved(f, before);
    } finally { await f.close(); }
  });
}
