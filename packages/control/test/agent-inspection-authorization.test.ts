import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHttpServer } from "@minu/channels-core";
import { ConversationClient } from "@minu/channels-core/client";
import type { ConversationMetadata } from "@minu/channels-core/types";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl, type AgentCredentialScope } from "@minu/channels-relay-storage-drizzle";
import { AgentCredentialError, AgentCredentialService } from "../src/agent-credentials.ts";
import { AgentInspectionAuthorization, type AgentInspectionAuthorizationOptions } from "../src/agent-inspection-authorization.ts";

function denied(status: number, code: string) {
  return (error: unknown) => error instanceof AgentCredentialError && error.status === status && error.code === code;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "channels-inspection-auth-"));
  const core = await createConversationHttpServer();
  let store: DrizzleLibSqlRelayStorage | undefined;
  t.after(async () => { await store?.close(); await core.close(); await rm(directory, { recursive: true, force: true }); });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human" });
  const principal = await client.createIdentity({ type: "human" });
  const member = await client.createIdentity({ type: "human" });
  const workspace = await client.createWorkspace({ slug: "inspection-auth", name: "Inspection" });
  for (const [identityId, mentionHandle, accessRole] of [
    [owner.id, "owner", "owner"], [principal.id, "pm", "admin"], [member.id, "member", "member"],
  ] as const) await client.addWorkspaceMember(workspace.id, { identityId, mentionHandle, accessRole });
  const parent = await client.createConversation({ workspaceId: workspace.id, actorIdentityId: owner.id, participantIds: [owner.id, member.id] });
  const sibling = await client.createConversation({ workspaceId: workspace.id, actorIdentityId: owner.id, participantIds: [owner.id] });
  async function thread() {
    const root = await client.postMessage(parent.id, { participantId: owner.id, body: "public root" });
    return client.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: root.id });
  }
  const firstThread = await thread();
  const workspaceB = await client.createWorkspace({ slug: "inspection-other", name: "Other" });
  await client.addWorkspaceMember(workspaceB.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  const foreign = await client.createConversation({ workspaceId: workspaceB.id, participantIds: [owner.id] });
  store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
  let now = new Date("2026-11-27T00:00:00.000Z");
  const credentials = new AgentCredentialService({ client, store: store.agentCredentials, now: () => now });
  const restricted = new Set<string>();
  const checked: string[] = [];
  const policy = async (id: string, target: ConversationMetadata) => {
    assert.equal(id, principal.id);
    checked.push(target.id);
    return !restricted.has(target.id);
  };
  const make = (overrides: Partial<AgentInspectionAuthorizationOptions> = {}) => new AgentInspectionAuthorization({
    credentials, conversations: client, canInspectTarget: policy, now: () => now, ...overrides,
  });
  let requestNumber = 0;
  const create = (scope: AgentCredentialScope = { mode: "locked", conversationId: parent.id, includeThreads: true }) =>
    credentials.create(workspace.id, principal.id, { requestId: `inspection_request_${++requestNumber}`, name: "PM",
      capabilities: ["conversation.inspect"], scope });
  return { core, client, owner, principal, member, workspace, parent, sibling, foreign, firstThread, thread,
    credentials, make, create, restricted, checked, store, setTime(value: string) { now = new Date(value); } };
}

async function result(auth: AgentInspectionAuthorization, secret: string, conversationId: string): Promise<string> {
  let output: string | undefined;
  await auth.inspect(secret, { conversationId }, async target => target.conversationId, value => { output = value; });
  assert.ok(output);
  return output;
}

test("inspection authorization: explicit generic/locked targets, future threads, no caller participation", async t => {
  const f = await fixture(t);
  assert.ok(!f.parent.participants.some(item => item.id === f.principal.id));
  const locked = await f.create();
  assert.equal(await result(f.make(), locked.secret, f.parent.id), f.parent.id);
  assert.equal(await result(f.make(), locked.secret, f.firstThread.id), f.firstThread.id);
  const future = await f.thread();
  assert.equal(await result(f.make(), locked.secret, future.id), future.id);
  const parentOnly = await f.create({ mode: "locked", conversationId: f.parent.id, includeThreads: false });
  await assert.rejects(result(f.make(), parentOnly.secret, future.id), denied(404, "target_unavailable"));
  const exactThread = await f.create({ mode: "locked", conversationId: f.firstThread.id, includeThreads: false });
  assert.equal(await result(f.make(), exactThread.secret, f.firstThread.id), f.firstThread.id);
  for (const id of [f.parent.id, future.id, f.sibling.id, f.foreign.id, "missing-target"]) {
    await assert.rejects(result(f.make(), exactThread.secret, id), denied(404, "target_unavailable"));
  }
  const generic = await f.create({ mode: "generic", grants: [
    { conversationId: f.parent.id, includeThreads: false }, { conversationId: f.sibling.id, includeThreads: false },
  ] });
  assert.equal(await result(f.make(), generic.secret, f.sibling.id), f.sibling.id);
  assert.equal(await result(f.make(), generic.secret, f.parent.id), f.parent.id);
  for (const id of [f.firstThread.id, f.foreign.id, "missing-target"]) {
    await assert.rejects(result(f.make(), generic.secret, id), denied(404, "target_unavailable"));
  }
  f.restricted.add(f.firstThread.id);
  await assert.rejects(result(f.make(), locked.secret, f.firstThread.id), denied(404, "target_unavailable"));
  f.restricted.clear();
  f.restricted.add(f.parent.id);
  await assert.rejects(result(f.make(), exactThread.secret, f.firstThread.id), denied(404, "target_unavailable"));
});

test("inspection authorization: missing/expired/revoked keys, lost capability and forged arguments deny before the read", async t => {
  const f = await fixture(t);
  const issued = await f.create();
  let reads = 0;
  const read = async () => { reads++; return "protected data"; };
  const release = () => assert.fail("must not release");
  for (const secret of ["", "Bearer forged", issued.secret.replace(/.$/, "!")]) {
    await assert.rejects(f.make().inspect(secret, { conversationId: f.parent.id }, read, release), denied(401, "unauthenticated"));
  }
  for (const input of [null, {}, [], { conversationId: f.parent.id, identityId: f.principal.id },
    { conversationId: f.parent.id, token: issued.secret }, { conversationId: f.parent.id, role: "owner" },
    { conversationId: "../workspaces" }, { conversationId: `${f.parent.id}?extra=1` }]) {
    await assert.rejects(f.make().inspect(issued.secret, input, read, release), denied(400, "invalid_request"));
  }
  await f.credentials.mutate(f.workspace.id, f.principal.id, issued.credential.id, "update", { expectedRevision: 1, capabilities: [] });
  await assert.rejects(f.make().inspect(issued.secret, { conversationId: f.parent.id }, read, release), denied(404, "target_unavailable"));
  const expiring = await f.create();
  f.setTime(expiring.credential.expiresAt);
  await assert.rejects(f.make().inspect(expiring.secret, { conversationId: f.parent.id }, read, release), denied(401, "unauthenticated"));
  f.setTime("2026-11-27T00:00:00.000Z");
  const revoked = await f.create();
  await f.credentials.mutate(f.workspace.id, f.principal.id, revoked.credential.id, "revoke", { expectedRevision: 1 });
  await assert.rejects(f.make().inspect(revoked.secret, { conversationId: f.parent.id }, read, release), denied(401, "unauthenticated"));
  assert.equal(reads, 0);
});

for (const change of ["revoke", "rotate", "scope", "capability", "role", "membership", "expiry", "restriction", "roster"] as const) {
  test(`inspection authorization: ${change} during held read prevents release`, async t => {
    const f = await fixture(t);
    const issued = await f.create();
    const entered = latch();
    const held = latch();
    t.after(() => held.resolve());
    let released = false;
    const pending = f.make().inspect(issued.secret, { conversationId: f.parent.id }, async () => {
      entered.resolve(); await held.promise; return "sensitive snapshot";
    }, () => { released = true; });
    await entered.promise;
    switch (change) {
      case "revoke": case "rotate":
        await f.credentials.mutate(f.workspace.id, f.principal.id, issued.credential.id, change, { expectedRevision: 1 }); break;
      case "scope":
        await f.credentials.mutate(f.workspace.id, f.principal.id, issued.credential.id, "update", { expectedRevision: 1,
          scope: { mode: "locked", conversationId: f.sibling.id, includeThreads: false } }); break;
      case "capability":
        await f.credentials.mutate(f.workspace.id, f.principal.id, issued.credential.id, "update", { expectedRevision: 1, capabilities: [] }); break;
      case "role":
        await f.client.updateWorkspaceMember(f.workspace.id, f.principal.id, { actorIdentityId: f.owner.id, accessRole: "member" }); break;
      case "membership":
        await f.client.updateWorkspaceMember(f.workspace.id, f.principal.id, { actorIdentityId: f.owner.id, status: "disabled" }); break;
      case "expiry": f.setTime(issued.credential.expiresAt); break;
      case "restriction": f.restricted.add(f.parent.id); break;
      case "roster":
        await f.client.updateConversationParticipants(f.parent.id, { actorIdentityId: f.owner.id,
          expectedRosterRevision: f.parent.rosterRevision, participantIds: [f.owner.id] }); break;
    }
    held.resolve();
    await assert.rejects(pending, change === "rotate" || change === "revoke" || change === "expiry"
      ? denied(401, "unauthenticated") : denied(404, "target_unavailable"));
    assert.equal(released, false);
  });
}

for (const change of ["rotation", "principal"] as const) {
  test(`inspection authorization: ${change} during final resource-policy await prevents release`, async t => {
    const f = await fixture(t);
    const issued = await f.create();
    let checks = 0;
    const entered = latch();
    const held = latch();
    t.after(() => held.resolve());
    let released = false;
    const auth = f.make({ async canInspectTarget() {
      if (++checks === 2) { entered.resolve(); await held.promise; }
      return true;
    } });
    const pending = auth.inspect(issued.secret, { conversationId: f.parent.id }, async () => "snapshot", () => { released = true; });
    await entered.promise;
    if (change === "rotation") {
      await f.credentials.mutate(f.workspace.id, f.principal.id, issued.credential.id, "rotate", { expectedRevision: 1 });
    } else {
      await f.client.updateWorkspaceMember(f.workspace.id, f.principal.id, { actorIdentityId: f.owner.id, accessRole: "member" });
    }
    held.resolve();
    await assert.rejects(pending, change === "rotation" ? denied(401, "unauthenticated") : denied(404, "target_unavailable"));
    assert.equal(released, false);
  });
}

test("inspection authorization: policy/lookup/read errors are sanitized and no discovery permits bypass", async t => {
  const f = await fixture(t);
  const issued = await f.create();
  const privateError = new Error("private runtime configuration and credentials");
  const lookupFailure = f.make({ conversations: { async getConversation() { throw privateError; } } });
  const policyFailure = f.make({ async canInspectTarget() { throw privateError; } });
  for (const auth of [lookupFailure, policyFailure]) {
    await assert.rejects(result(auth, issued.secret, f.parent.id), denied(404, "target_unavailable"));
  }
  await assert.rejects(f.make().inspect(issued.secret, { conversationId: f.parent.id }, async () => { throw privateError; },
    () => assert.fail("must not release")), denied(503, "inspection_unavailable"));
  // Direct invocation is authorized independently; there is no discovery prerequisite or bypass flag.
  await assert.rejects(f.make().inspect(issued.secret, { conversationId: f.sibling.id, discovered: true },
    async () => assert.fail("must not read"), () => assert.fail("must not release")), denied(400, "invalid_request"));
});

test("inspection authorization: abort while final policy is held ends waiting and never releases later", async t => {
  const f = await fixture(t);
  const issued = await f.create();
  const entered = latch();
  const held = latch();
  t.after(() => held.resolve());
  let checks = 0;
  let released = false;
  const auth = f.make({ async canInspectTarget() {
    if (++checks === 2) { entered.resolve(); await held.promise; }
    return true;
  } });
  const controller = new AbortController();
  const pending = auth.inspect(issued.secret, { conversationId: f.parent.id }, async () => "snapshot",
    () => { released = true; }, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, denied(503, "inspection_unavailable"));
  held.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(released, false);
});
