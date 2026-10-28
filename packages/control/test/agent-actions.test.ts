import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { InMemoryRelayBindingStore } from "@minu/channels-relay";
import { agentActionInput, LocalAgentActions } from "../src/agent-actions.ts";
import { LocalAgentHostConfiguration, LocalConfigurationRequestError } from "../src/configuration.ts";
import { createLocalControlHttpServer, LocalControlBrowserSessions, LocalControlService, type LocalControlAgentLifecyclePort } from "../src/server.ts";
import type { LocalAgentActionReceipt } from "../src/contracts.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const input = { requestId: "request-1", action: "replace-fresh" as const, identityId: "agent" };

test("participant action input requires an exact action, ID and individual or bulk scope", () => {
  assert.deepEqual(agentActionInput(input), input);
  for (const action of ["stop-runtime", "restart-runtime"] as const) assert.deepEqual(agentActionInput({ ...input, action }), { ...input, action });
  assert.deepEqual(agentActionInput({ requestId: "bulk", action: "stop-all" }), { requestId: "bulk", action: "stop-all" });
  for (const value of [null, [], {}, { ...input, requestId: "../secret" }, { ...input, action: "destroy" }, { ...input, identityId: undefined }, { ...input, action: "stop-all" }, { ...input, contextMode: "fresh" }]) {
    assert.throws(() => agentActionInput(value), LocalConfigurationRequestError);
  }
});

test("receipts deduplicate exact requests and reject queued retries without blocking another participant", async () => {
  const actions = new LocalAgentActions(), held = gate();
  let executions = 0;
  const execute = async () => { executions++; await held.promise; return undefined; };
  const first = actions.start("conversation", "owner", input, execute);
  try {
    assert.equal(actions.start("conversation", "owner", input, execute), first);
    for (const [actor, value] of [
      ["owner", { ...input, requestId: "different" }],
      ["owner", { ...input, action: "stop" }],
      ["other-owner", input],
      ["owner", { requestId: "bulk", action: "stop-all" }],
    ] as const) assert.throws(() => actions.start("conversation", actor, value, execute), LocalConfigurationRequestError);
    const second = actions.start("conversation", "owner", { ...input, requestId: "second", identityId: "other-agent" }, async () => undefined);
    await second.completion;
    assert.equal(actions.pending("conversation").length, 1);
    const snapshot = actions.read("conversation", input.requestId)!;
    snapshot.state = "failed";
    assert.equal(actions.read("conversation", input.requestId)!.state, "pending");
    held.release();
    await first.completion;
    assert.equal(actions.start("conversation", "owner", input, execute), first);
    assert.equal(executions, 1);
    assert.equal(actions.read("conversation", input.requestId)!.state, "succeeded");
    assert.equal(actions.read("other-conversation", input.requestId), undefined);
  } finally { held.release(); }
});

test("bounded receipt retention never evicts running actions or equates missing evidence with failure", async () => {
  let now = 100;
  const actions = new LocalAgentActions({ capacity: 1, retentionMs: 10, now: () => now }), held = gate();
  const first = actions.start("conversation", "owner", input, async () => { await held.promise; return undefined; });
  try {
    now = 1_000;
    assert.equal(actions.read("conversation", input.requestId)!.state, "pending");
    assert.throws(() => actions.start("other-conversation", "owner", { ...input, requestId: "second" }, async () => undefined), /busy/);
    held.release(); await first.completion;
    now += 10;
    assert.equal(actions.read("conversation", input.requestId), undefined);
  } finally { held.release(); }
});

test("receipts distinguish definitive rejection, partial changes and unknown transport errors without raw errors", async () => {
  const actions = new LocalAgentActions();
  for (const [id, error, state, message] of [
    ["rejected", new LocalConfigurationRequestError("Agent is busy", 409, "unavailable"), "failed", "Agent is busy"],
    ["partial", new LocalConfigurationRequestError("Replacement committed; reconciliation incomplete", 409, "unavailable", "unconfirmed"), "unconfirmed", "Replacement committed; reconciliation incomplete"],
    ["unknown", new Error("PRIVATE_RUNTIME_SECRET"), "unconfirmed", "Participant action outcome could not be confirmed"],
  ] as const) {
    const entry = actions.start("conversation", "owner", { ...input, requestId: id }, async () => { throw error; });
    await assert.rejects(entry.completion);
    const receipt = actions.read("conversation", id)!;
    assert.equal(receipt.state, state); assert.equal(receipt.error, message);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE/);
  }
});

async function fixture() {
  const publicServer = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(publicServer.endpoint, { serviceToken: publicServer.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const member = await client.createIdentity({ type: "human", displayName: "Member" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
  const otherAgent = await client.createIdentity({ type: "agent", displayName: "Reviewer" });
  const workspace = await client.createWorkspace({ slug: "action-receipts", name: "Action Receipts" });
  for (const [identity, handle, accessRole] of [[owner, "owner", "owner"], [member, "member", "member"], [agent, "builder", "member"], [otherAgent, "reviewer", "member"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: handle, accessRole });
  }
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id, agent.id, otherAgent.id] });
  const store = new InMemoryRelayBindingStore();
  const held = gate(), entered = gate();
  const calls: Array<{ identityId: string; contextMode?: string }> = [];
  let rejectFresh = false, unreadableStatus = false;
  const lifecycle: LocalControlAgentLifecyclePort = {
    available: true,
    async startConversationAgent() {},
    async replaceConversationAgent(_conversationId, identityId, _actor, contextMode) {
      calls.push({ identityId, contextMode });
      if (rejectFresh) throw new LocalConfigurationRequestError("Runtime is busy; stop the agent first", 409, "unavailable");
      entered.release(); await held.promise;
    },
    async stopConversationAgent() {},
    async recoverConversationAgent(_conversationId, identityId, _actor, restart) {
      calls.push({ identityId, contextMode: restart ? "restart-runtime" : "stop-runtime" });
      entered.release(); await held.promise;
    },
    async cancelCurrentConversationAgent() {},
  };
  const control = new LocalControlService({ conversations: client, bindings: { async listConversationBindings() { if (unreadableStatus) throw new Error("PRIVATE_STATUS_ERROR"); return []; } }, runtimes: {}, lifecycle,
    configuration: new LocalAgentHostConfiguration({ client, store }) });
  const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: owner.id });
  const server = await createLocalControlHttpServer({ service: control, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], port: 0 });
  const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const path = `${server.endpoint}/local/conversations/${conversation.id}/agent-actions`;
  const headers = { cookie, origin: sessions.browserOrigin, "content-type": "application/json" };
  const submit = (body = { ...input, identityId: agent.id }) => fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const read = async (requestId = input.requestId) => (await fetch(`${path}/${requestId}`, { headers })).json() as Promise<LocalAgentActionReceipt>;
  return { client, owner, member, agent, otherAgent, workspace, conversation, store, sessions, server, path, headers, held, entered, calls, submit, read,
    rejectFresh() { rejectFresh = true; }, unreadableStatus() { unreadableStatus = true; },
    async close() { held.release(); await server.close(); await publicServer.close(); await store.close(); } };
}

for (const action of ["stop-runtime", "restart-runtime"] as const) {
  test(`HTTP ${action} uses authenticated lifecycle receipts and the shared participant admission guard`, async () => {
    const f = await fixture();
    const body = { requestId: "recovery-1", action, identityId: f.agent.id };
    try {
      assert.equal((await fetch(f.path, { method: "POST", body: JSON.stringify(body) })).status, 401);
      assert.equal((await fetch(f.path, { method: "POST", headers: { ...f.headers, origin: "http://attacker.example" }, body: JSON.stringify(body) })).status, 403);
      const submit = () => fetch(f.path, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
      assert.equal((await submit()).status, 202); await f.entered.promise;
      assert.equal((await f.read("recovery-1")).state, "pending");
      assert.equal((await submit()).status, 202);
      assert.equal((await fetch(f.path, { method: "POST", headers: f.headers, body: JSON.stringify({ ...body, requestId: "conflict" }) })).status, 409);
      f.held.release();
      assert.equal((await f.read("recovery-1")).state, "succeeded");
      assert.deepEqual(f.calls, [{ identityId: f.agent.id, contextMode: action }]);
      await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, accessRole: "owner" });
      await f.client.updateWorkspaceMember(f.workspace.id, f.owner.id, { actorIdentityId: f.owner.id, accessRole: "member" });
      assert.equal((await submit()).status, 403);
      assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
  });
}

test("HTTP acknowledges a held replacement, reconciles its result, and rejects duplicate legacy or new intents", async () => {
  const f = await fixture();
  try {
    const accepted = await f.submit();
    assert.equal(accepted.status, 202); assert.equal((await accepted.json() as LocalAgentActionReceipt).state, "pending");
    await f.entered.promise;
    assert.equal((await f.read()).state, "pending");
    assert.equal((await f.submit()).status, 202);
    assert.equal((await f.submit({ ...input, requestId: "other-request", identityId: f.agent.id })).status, 409);
    const legacy = await fetch(`${f.server.endpoint}/local/conversations/${f.conversation.id}/agents/${f.agent.id}/replace`, { method: "POST", headers: f.headers, body: JSON.stringify({ contextMode: "fresh" }) });
    assert.equal(legacy.status, 409);
    assert.equal(f.calls.length, 1);
    const other = await fetch(f.path, { method: "POST", headers: f.headers, body: JSON.stringify({ requestId: "independent", action: "stop", identityId: f.otherAgent.id }) });
    assert.equal(other.status, 202);
    f.unreadableStatus(); f.held.release();
    assert.equal((await f.read()).state, "succeeded");
    // A successful lifecycle receipt does not depend on post-commit presentation I/O.
    assert.equal((await fetch(`${f.server.endpoint}/local/conversations/${f.conversation.id}/agents/${f.agent.id}`, { headers: f.headers })).status, 502);
    assert.equal((await f.submit()).status, 202);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.read("missing")).state, undefined);
  } finally { await f.close(); }
});

test("fresh-session admission rejection is inspectable and never mistaken for a successful replacement", async () => {
  const f = await fixture();
  try {
    f.rejectFresh();
    assert.equal((await f.submit()).status, 202);
    const receipt = await f.read();
    assert.equal(receipt.state, "failed");
    assert.match(receipt.error!, /busy/);
    assert.deepEqual(f.calls, [{ identityId: f.agent.id, contextMode: "fresh" }]);
  } finally { await f.close(); }
});

test("receipt APIs enforce browser origin, workspace role and fresh access after acceptance", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.path)).status, 401);
    assert.equal((await fetch(f.path, { method: "POST", headers: { ...f.headers, origin: "http://attacker.example" }, body: JSON.stringify({ ...input, identityId: f.agent.id }) })).status, 403);
    assert.equal((await f.submit()).status, 202);
    await f.entered.promise;
    const otherConversation = await f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id, f.agent.id] });
    assert.equal((await fetch(`${f.server.endpoint}/local/conversations/${otherConversation.id}/agent-actions/${input.requestId}`, { headers: f.headers })).status, 404);
    await f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, accessRole: "owner" });
    await f.client.updateWorkspaceMember(f.workspace.id, f.owner.id, { actorIdentityId: f.owner.id, accessRole: "member" });
    assert.equal((await fetch(`${f.path}/${input.requestId}`, { headers: f.headers })).status, 403);
    assert.equal((await fetch(f.path, { headers: f.headers })).status, 403);
    assert.equal((await f.submit()).status, 403);
    f.held.release();
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
