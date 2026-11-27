import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHttpServer } from "@minu/channels-core";
import { ConversationClient } from "@minu/channels-core/client";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { AgentCredentialError, AgentCredentialService, type AgentCredentialIssue } from "../src/agent-credentials.ts";
import { createLocalControlHttpServer, LocalControlService } from "../src/server.ts";
import { LocalControlBrowserSessions } from "../src/session.ts";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "channels-agent-keys-"));
  const path = join(directory, "relay.db");
  const core = await createConversationHttpServer();
  let store: DrizzleLibSqlRelayStorage | undefined;
  t.after(async () => { await store?.close(); await core.close(); await rm(directory, { recursive: true, force: true }); });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human" });
  const admin = await client.createIdentity({ type: "human" });
  const member = await client.createIdentity({ type: "human" });
  const agent = await client.createIdentity({ type: "agent" });
  const workspace = await client.createWorkspace({ slug: "agent-keys", name: "Keys" });
  for (const [identityId, mentionHandle, accessRole] of [
    [owner.id, "owner", "owner"], [admin.id, "admin", "admin"], [member.id, "member", "member"], [agent.id, "agent", "member"],
  ] as const) await client.addWorkspaceMember(workspace.id, { identityId, mentionHandle, accessRole });
  const conversation = await client.createConversation({ workspaceId: workspace.id, name: "Scoped", actorIdentityId: owner.id,
    participantIds: [owner.id, member.id, agent.id] });
  let now = new Date("2026-11-26T00:00:00.000Z");
  store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(path) });
  const service = () => new AgentCredentialService({ client, store: store!.agentCredentials, now: () => now });
  return { client, owner, admin, member, agent, workspace, conversation, path, service,
    get store() { return store!; },
    setTime(value: string) { now = new Date(value); },
    async reopen() { await store!.close(); store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(path) }); },
    input: { requestId: "creation_request_0001", name: "PM", capabilities: ["conversation.inspect"],
      scope: { mode: "locked", conversationId: conversation.id, includeThreads: true } },
  };
}

function error(status: number, code?: string) {
  return (value: unknown) => value instanceof AgentCredentialError && value.status === status && (!code || value.code === code);
}

test("credentials: real persistence, one-time secrets, duplicate requests, expiry and reopen", async t => {
  const f = await fixture(t);
  const issued = await f.service().create(f.workspace.id, f.owner.id, f.input);
  assert.match(issued.secret, /^chak_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.credential.expiresAt, "2026-12-26T00:00:00.000Z");
  assert.equal(issued.credential.principalIdentityId, f.owner.id);
  const record = await f.store.agentCredentials.get(issued.credential.id);
  assert.match(record!.secretHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(record).includes(issued.secret));
  assert.equal((await f.service().authenticate(issued.secret)).id, issued.credential.id);
  await assert.rejects(f.service().authenticate(issued.secret.slice(0, -1) + "!"), error(401));
  await assert.rejects(f.service().authenticate(issued.secret.replace(/.$/, issued.secret.endsWith("a") ? "b" : "a")), error(401));
  await assert.rejects(f.service().create(f.workspace.id, f.owner.id, f.input), error(409, "request_already_recorded"));
  const listed = await f.service().list(f.workspace.id, f.owner.id);
  assert.deepEqual(listed, [issued.credential]);
  assert.ok(!JSON.stringify(listed).includes("secretHash"));
  await f.reopen();
  assert.equal((await f.service().authenticate(issued.secret)).revision, 1);
  assert.deepEqual(await f.service().get(f.workspace.id, f.owner.id, issued.credential.id), issued.credential);
  assert.ok(!(await readFile(f.path)).includes(Buffer.from(issued.secret)));
  f.setTime(issued.credential.expiresAt);
  await assert.rejects(f.service().authenticate(issued.secret), error(401));
  await assert.rejects(f.service().mutate(f.workspace.id, f.owner.id, issued.credential.id, "rotate", { expectedRevision: 1 }), error(409));
});

test("credentials: current human/admin authority, ownership and malformed grants fail closed", async t => {
  const f = await fixture(t);
  for (const actor of [f.member.id, f.agent.id, "missing"]) {
    await assert.rejects(f.service().create(f.workspace.id, actor, f.input), error(403));
    await assert.rejects(f.service().list(f.workspace.id, actor), error(403));
  }
  const malformed: unknown[] = [
    { ...f.input, principalIdentityId: f.member.id }, { ...f.input, requestId: "short" },
    { ...f.input, capabilities: ["agent.start"] }, { ...f.input, capabilities: ["conversation.inspect", "conversation.inspect"] },
    { ...f.input, scope: { mode: "generic", grants: [] } },
    { ...f.input, scope: { mode: "locked", conversationId: f.conversation.id } },
    { ...f.input, scope: { mode: "generic", grants: Array(129).fill({ conversationId: f.conversation.id, includeThreads: false }) } },
    { ...f.input, scope: { mode: "generic", grants: Array(2).fill({ conversationId: f.conversation.id, includeThreads: false }) } },
    { ...f.input, scope: { mode: "locked", conversationId: f.conversation.id, includeThreads: true, grants: [] } },
    { ...f.input, expiresAt: "2026-11-26T00:00:00.000Z" }, { ...f.input, expiresAt: "2027-11-26T00:00:00.000Z" },
  ];
  for (const input of malformed) await assert.rejects(f.service().create(f.workspace.id, f.owner.id, input), error(400));
  const other = await f.client.createWorkspace({ slug: "other-keys", name: "Other" });
  await f.client.addWorkspaceMember(other.id, { identityId: f.owner.id, mentionHandle: "owner", accessRole: "owner" });
  for (const conversationId of [f.conversation.id, "missing"]) {
    await assert.rejects(f.service().create(other.id, f.owner.id, {
      ...f.input, scope: { mode: "locked", conversationId, includeThreads: false },
    }), error(404, "target_unavailable"));
  }
  const issued = await f.service().create(f.workspace.id, f.admin.id, f.input);
  await assert.rejects(f.service().get(f.workspace.id, f.owner.id, issued.credential.id), error(404));
  assert.deepEqual(await f.service().list(f.workspace.id, f.owner.id), []);
  await f.client.updateWorkspaceMember(f.workspace.id, f.admin.id, { actorIdentityId: f.owner.id, accessRole: "member" });
  await assert.rejects(f.service().mutate(f.workspace.id, f.admin.id, issued.credential.id, "rotate", { expectedRevision: 1 }), error(403));
  await assert.rejects(f.service().get(f.workspace.id, f.admin.id, issued.credential.id), error(403));
});

test("credentials: atomic rotation, concurrent CAS, grant revision, revocation survive reopen", async t => {
  const f = await fixture(t);
  const issued = await f.service().create(f.workspace.id, f.owner.id, f.input);
  const pending = await f.service().authenticate(issued.secret);
  const rotations = await Promise.allSettled([0, 1].map(() => f.service().mutate(f.workspace.id, f.owner.id,
    issued.credential.id, "rotate", { expectedRevision: 1 })));
  assert.equal(rotations.filter(result => result.status === "fulfilled").length, 1);
  const rotated = rotations.find(result => result.status === "fulfilled")!;
  assert.equal(rotated.status, "fulfilled");
  if (rotated.status !== "fulfilled") throw new Error("Rotation failed");
  assert.notEqual(rotated.value.secret, issued.secret);
  await assert.rejects(f.service().authenticate(issued.secret), error(401));
  assert.equal(rotated.value.credential.expiresAt, issued.credential.expiresAt);
  assert.equal(rotated.value.credential.secretGeneration, pending.secretGeneration + 1);
  await f.reopen();
  const current = await f.service().authenticate(rotated.value.secret!);
  assert.notEqual(current.secretGeneration, pending.secretGeneration, "B3 can reject a captured old generation");
  await assert.rejects(f.service().mutate(f.workspace.id, f.owner.id, current.id, "update", { expectedRevision: 1, name: "stale" }), error(409));
  const updated = await f.service().mutate(f.workspace.id, f.owner.id, current.id, "update", { expectedRevision: 2,
    name: "Paused", capabilities: [], scope: { mode: "generic", grants: [{ conversationId: f.conversation.id, includeThreads: false }] } });
  assert.equal(updated.credential.revision, 3);
  assert.equal(updated.credential.secretGeneration, 2);
  assert.deepEqual(updated.credential.capabilities, []);
  assert.ok(!("secret" in updated));
  const revoked = await f.service().mutate(f.workspace.id, f.owner.id, current.id, "revoke", { expectedRevision: 3 });
  assert.equal(revoked.credential.revision, 4);
  await assert.rejects(f.service().authenticate(rotated.value.secret!), error(401));
  await f.reopen();
  await assert.rejects(f.service().authenticate(rotated.value.secret!), error(401));
  await assert.rejects(f.service().mutate(f.workspace.id, f.owner.id, current.id, "rotate", { expectedRevision: 4 }), error(409));
});

test("credentials: unknown create/rotate outcomes resolve through metadata without secret replay", async t => {
  const f = await fixture(t);
  const store = f.store.agentCredentials;
  const lostCreate = new AgentCredentialService({ client: f.client, now: () => new Date("2026-11-26T00:00:00.000Z"),
    store: { get: store.get.bind(store), list: store.list.bind(store), replace: store.replace.bind(store),
      async create(record) { await store.create(record); throw new Error("lost private response"); } } });
  await assert.rejects(lostCreate.create(f.workspace.id, f.owner.id, f.input), /lost private response/);
  const [metadata] = await f.service().list(f.workspace.id, f.owner.id);
  assert.equal(metadata!.requestId, f.input.requestId);
  assert.ok(!JSON.stringify(metadata).includes("secret" + "Hash"));
  await assert.rejects(f.service().create(f.workspace.id, f.owner.id, f.input), error(409));
  const lostRotation = new AgentCredentialService({ client: f.client,
    now: () => new Date("2026-11-26T00:00:00.000Z"), store: { create: store.create.bind(store),
      get: store.get.bind(store), list: store.list.bind(store),
      async replace(record, expected) { await store.replace(record, expected); throw new Error("lost rotation response"); } } });
  await assert.rejects(lostRotation.mutate(f.workspace.id, f.owner.id, metadata!.id, "rotate", { expectedRevision: 1 }), /lost rotation response/);
  const fresh = await f.service().get(f.workspace.id, f.owner.id, metadata!.id);
  assert.equal(fresh.revision, 2);
  assert.equal(fresh.secretGeneration, 2);
  await assert.rejects(f.service().mutate(f.workspace.id, f.owner.id, fresh.id, "rotate", { expectedRevision: 1 }), error(409));
  const replacement = await f.service().mutate(f.workspace.id, f.owner.id, fresh.id, "rotate", { expectedRevision: 2 });
  assert.equal((await f.service().authenticate(replacement.secret!)).secretGeneration, 3);
});

test("credentials: disabled/archived principals and changes before disclosure fail closed", async t => {
  const f = await fixture(t);
  let identityReads = 0;
  const client = {
    getConversation: f.client.getConversation.bind(f.client),
    listWorkspaceMembers: f.client.listWorkspaceMembers.bind(f.client),
    getWorkspace: f.client.getWorkspace.bind(f.client),
    async getIdentity(id: string) {
      const identity = await f.client.getIdentity(id);
      identityReads++;
      return identityReads >= 3 ? { ...identity, status: "disabled" as const } : identity;
    },
  };
  const changed = new AgentCredentialService({ client, store: f.store.agentCredentials });
  await assert.rejects(changed.create(f.workspace.id, f.owner.id, f.input), error(403));
  assert.equal((await f.service().list(f.workspace.id, f.owner.id)).length, 1,
    "a lost one-time response is resolved through metadata, never replay");
  const archived = new AgentCredentialService({ client: { ...client, getIdentity: f.client.getIdentity.bind(f.client),
    async getWorkspace(id: string) { return { ...await f.client.getWorkspace(id), status: "archived" as const }; } },
    store: f.store.agentCredentials });
  await assert.rejects(archived.list(f.workspace.id, f.owner.id), error(403));
});

test("credentials: HTTP withholds one-time secret when session expires during final authority lookup", async t => {
  const f = await fixture(t);
  let now = new Date("2026-11-26T00:00:00.000Z");
  const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174", currentHumanIdentityId: f.owner.id,
    sessionTtlMs: 1_000, now: () => now });
  const credentials = f.service();
  const authorize = credentials.authorizeAdministrator.bind(credentials);
  let checks = 0;
  let entered!: () => void;
  let release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  credentials.authorizeAdministrator = async (workspaceId, identityId) => {
    await authorize(workspaceId, identityId);
    // create() checks admission, before persistence and before disclosure; fourth is the HTTP boundary.
    if (++checks === 4) { entered(); await gate; }
  };
  const server = await createLocalControlHttpServer({ port: 0, browserSessions: sessions, agentCredentials: credentials,
    service: new LocalControlService({ conversations: f.client, bindings: f.store, runtimes: {} }) });
  t.after(() => server.close());
  t.after(() => release());
  const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const pending = fetch(`${server.endpoint}/local/workspaces/${f.workspace.id}/agent-credentials`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(f.input),
  });
  await held;
  now = new Date("2026-11-26T00:00:01.000Z");
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthenticated" });
  assert.equal(response.headers.get("set-cookie"), null, "expired sessions are not renewed");
  const [recorded] = await f.service().list(f.workspace.id, f.owner.id);
  assert.equal(recorded!.requestId, f.input.requestId, "persisted issuance is recovered through metadata, not secret replay");
});

test("credentials: HTTP renews persistent browser sessions and renewed cookie survives original expiry", async t => {
  const f = await fixture(t);
  let now = new Date("2026-11-26T00:00:00.000Z");
  const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174", currentHumanIdentityId: f.owner.id,
    sessionTtlMs: 1_000, sessionKey: Buffer.alloc(32, 7), now: () => now });
  const server = await createLocalControlHttpServer({ port: 0, browserSessions: sessions, agentCredentials: f.service(),
    service: new LocalControlService({ conversations: f.client, bindings: f.store, runtimes: {} }) });
  t.after(() => server.close());
  const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const url = `${server.endpoint}/local/workspaces/${f.workspace.id}/agent-credentials`;
  now = new Date("2026-11-26T00:00:00.600Z");
  const renewed = await fetch(url, { headers: { cookie } });
  assert.equal(renewed.status, 200);
  assert.deepEqual(await renewed.json(), { credentials: [] });
  const setCookie = renewed.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\//);
  const renewedCookie = setCookie.split(";", 1)[0]!;
  assert.notEqual(renewedCookie, cookie);
  now = new Date("2026-11-26T00:00:01.000Z");
  const expired = await fetch(url, { headers: { cookie } });
  assert.equal(expired.status, 401);
  await expired.json();
  const valid = await fetch(url, { headers: { cookie: renewedCookie } });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { credentials: [] });
});

test("credentials: actual admin HTTP denies keys/CSRF/nonadmins and returns sanitized one-time results", async t => {
  const f = await fixture(t);
  const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174", currentHumanIdentityId: f.owner.id });
  const server = await createLocalControlHttpServer({ port: 0, allowedOrigins: [sessions.browserOrigin], browserSessions: sessions,
    agentCredentials: f.service(), service: new LocalControlService({ conversations: f.client, bindings: f.store, runtimes: {} }) });
  t.after(() => server.close());
  const base = `${server.endpoint}/local/workspaces/${f.workspace.id}/agent-credentials`;
  const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  async function call(path = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, { method, headers: { cookie, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() as Record<string, unknown> };
  }
  assert.equal((await call("", "POST", f.input, { cookie: "" })).response.status, 401);
  assert.equal((await call("", "POST", f.input, { origin: "https://evil.example" })).response.status, 403);
  const created = await call("", "POST", f.input);
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get("cache-control"), "no-store");
  const issued = created.body as unknown as AgentCredentialIssue;
  assert.equal((await call("", "GET", undefined, { cookie: "", authorization: `Bearer ${issued.secret}` })).response.status, 401);
  assert.equal((await call("", "GET", undefined, { authorization: `Bearer ${issued.secret}` })).response.status, 401);
  const listed = await call();
  assert.equal(listed.response.status, 200);
  assert.ok(!JSON.stringify(listed.body).includes(issued.secret));
  assert.ok(!JSON.stringify(listed.body).includes("secretHash"));
  const duplicate = await call("", "POST", f.input);
  assert.deepEqual(duplicate.body, { error: "request_already_recorded" });
  assert.equal(duplicate.response.status, 409);
  assert.equal((await call(`/${issued.credential.id}?extra=yes`)).response.status, 400);
  assert.equal((await call(`/${issued.credential.id}`, "PATCH", { expectedRevision: 1, principalIdentityId: f.member.id })).response.status, 400);
  const rotation = await call(`/${issued.credential.id}/rotate`, "POST", { expectedRevision: 1 });
  assert.equal(rotation.response.status, 200);
  await assert.rejects(f.service().authenticate(issued.secret), error(401));
  assert.equal((await call(`/${issued.credential.id}/rotate`, "POST", { expectedRevision: 1 })).response.status, 409);
  assert.equal((await call(`/${issued.credential.id}/revoke`, "POST", { expectedRevision: 2 })).response.status, 200);
  assert.equal((await call(`/${issued.credential.id}`, "DELETE")).response.status, 405);
  const oversized = await call("", "POST", { ...f.input, name: "x".repeat(70_000) });
  assert.equal(oversized.response.status, 400);
  assert.deepEqual(oversized.body, { error: "invalid_request" });
  const memberSessions = new LocalControlBrowserSessions({ browserUrl: sessions.browserOrigin, currentHumanIdentityId: f.member.id });
  const memberServer = await createLocalControlHttpServer({ port: 0, browserSessions: memberSessions,
    agentCredentials: f.service(), service: new LocalControlService({ conversations: f.client, bindings: f.store, runtimes: {} }) });
  t.after(() => memberServer.close());
  const memberBootstrap = await fetch(memberSessions.issueLaunchUrl(memberServer.endpoint), { redirect: "manual" });
  const memberResponse = await fetch(`${memberServer.endpoint}/local/workspaces/${f.workspace.id}/agent-credentials`, {
    headers: { cookie: memberBootstrap.headers.get("set-cookie")!.split(";", 1)[0]! },
  });
  assert.equal(memberResponse.status, 403);
  assert.deepEqual(await memberResponse.json(), { error: "forbidden" });
  // Existing endpoints still cannot authenticate with an agent key.
  assert.equal((await fetch(`${server.endpoint}/local/session`, { headers: { authorization: `Bearer ${issued.secret}` } })).status, 401);
});
