import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHttpServer } from "@minu/channels-core";
import { ConversationClient } from "@minu/channels-core/client";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { createLocalControlDaemon } from "../src/daemon.ts";
import type { AgentCredentialIssue } from "../src/agent-credentials.ts";
import { AGENT_INSPECTION_PATH } from "../src/agent-inspection-http.ts";
import type { AgentConversationInspection, AgentStatusInspection } from "../src/agent-inspection-status.ts";
import type { LocalManagedRuntimePort } from "../src/agent-host.ts";
import type { LocalControlCapabilities } from "../src/contracts.ts";
import { createLocalControlHttpServer, type LocalControlService } from "../src/server.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: test.TestContext, runtime: LocalManagedRuntimePort = { async status() { throw new Error("unexpected probe"); } }) {
  const directory = await mkdtemp(join(tmpdir(), "channels-inspection-http-"));
  const core = await createConversationHttpServer();
  let daemon: Awaited<ReturnType<typeof createLocalControlDaemon>> | undefined;
  let store: DrizzleLibSqlRelayStorage | undefined;
  t.after(async () => { await daemon?.close(); await store?.close(); await core.close(); await rm(directory, { recursive: true, force: true }); });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human" });
  const principal = await client.createIdentity({ type: "human" });
  const agent = await client.createIdentity({ type: "agent" });
  const workspace = await client.createWorkspace({ slug: "inspection-http", name: "Inspection" });
  for (const [identityId, mentionHandle, accessRole] of [[owner.id, "owner", "owner"], [principal.id, "pm", "admin"], [agent.id, "agent", "member"]] as const)
    await client.addWorkspaceMember(workspace.id, { identityId, mentionHandle, accessRole });
  const parent = await client.createConversation({ workspaceId: workspace.id, actorIdentityId: owner.id, participantIds: [owner.id, agent.id] });
  const other = await client.createConversation({ workspaceId: workspace.id, actorIdentityId: owner.id, participantIds: [owner.id] });
  const relayPath = join(directory, "relay.db");
  store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
  daemon = await createLocalControlDaemon({ currentHumanIdentityId: principal.id, conversationsEndpoint: core.endpoint,
    conversationsServiceToken: core.serviceToken, relayDatabasePath: relayPath, webUrl: "http://127.0.0.1:5174", port: 0,
    runtimes: { fixture: runtime }, recordAgentDiagnostics: false, autoResumeOfflineAgents: false });
  const bootstrap = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const adminPath = `${daemon.endpoint}/local/workspaces/${workspace.id}/agent-credentials`;
  const created = await fetch(adminPath, { method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "http_inspection_request_0001", name: "PM", capabilities: ["conversation.inspect"],
      scope: { mode: "locked", conversationId: parent.id, includeThreads: true } }) });
  assert.equal(created.status, 201);
  const issue = await created.json() as AgentCredentialIssue;
  const url = daemon.endpoint + AGENT_INSPECTION_PATH;
  async function call(body: unknown = { conversationId: parent.id }, headers: Record<string, string> = {}) {
    return fetch(url, { method: "POST", headers: { authorization: `Bearer ${issue.secret}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  }
  async function bind() {
    const timestamp = new Date().toISOString();
    await store!.putAgentConfig({ id: "private-config", workspaceId: workspace.id, agentIdentityId: agent.id, status: "active",
      createdAt: timestamp, updatedAt: timestamp });
    await store!.putBinding({ id: "private-binding", workspaceAgentConfigId: "private-config", workspaceId: workspace.id,
      conversationId: parent.id, agentIdentityId: agent.id, runtimeAdapter: "fixture", runtimeSessionId: "private-runtime-session",
      generation: 1, state: "connected", wakePolicy: "mentions", createdAt: timestamp, updatedAt: timestamp });
  }
  return { core, client, owner, principal, agent, workspace, parent, other, store, issue, url, cookie, daemon, adminPath, call, bind };
}

test("inspection HTTP: production daemon round trip without cookies/Runtime caller binding and no public side effects", async t => {
  const f = await fixture(t);
  const advertised = await (await fetch(`${f.daemon.endpoint}/local/capabilities`, { headers: { cookie: f.cookie } })).json() as LocalControlCapabilities;
  assert.deepEqual(advertised.agentApi, { inspectionUrl: f.url });
  assert.ok(!f.parent.participants.some(item => item.id === f.principal.id));
  const before = await f.client.getConversation(f.parent.id);
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const snapshot = await response.json() as AgentConversationInspection;
  assert.equal(snapshot.conversationId, f.parent.id);
  assert.equal(snapshot.participants.length, 2);
  assert.equal(snapshot.participants.find(item => item.type === "agent")!.runtime!.state, "unbound");
  assert.equal(snapshot.participants.find(item => item.type === "human")!.runtime, undefined);
  const root = await f.client.postMessage(f.parent.id, { participantId: f.owner.id, body: "public thread root" });
  const thread = await f.client.createThread(f.parent.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
  const selected = await f.call({ conversationId: thread.id });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json() as AgentConversationInspection).conversationId, thread.id);
  const forbidden = await f.call({ conversationId: f.other.id });
  assert.equal(forbidden.status, 404);
  assert.deepEqual(await forbidden.json(), { error: "target_unavailable" });
  const missing = await f.call({ conversationId: "missing-target" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "target_unavailable" });
  assert.deepEqual((await f.client.getConversation(f.parent.id)).participants, before.participants);
  assert.equal(await f.client.getCursor(f.parent.id, f.agent.id), 0);
  assert.equal((await f.store.listConversationBindings(f.parent.id)).length, 0);
});

test("inspection HTTP: strict transport/input boundary and no lifecycle/admin credential crossover", async t => {
  const f = await fixture(t);
  for (const authorization of ["", `Bearer ${f.core.serviceToken}`, "Bearer forged", `Bearer ${f.issue.secret} extra`]) {
    const response = await f.call(undefined, { authorization });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthenticated" });
  }
  const cookieOnly = await f.call(undefined, { authorization: "", cookie: f.cookie });
  assert.equal(cookieOnly.status, 401); await cookieOnly.json();
  for (const body of [{ conversationId: f.parent.id, identityId: f.principal.id }, { conversationId: f.parent.id, token: f.issue.secret },
    { conversationId: f.parent.id, sessionId: "private-runtime" }, { conversationId: "../identities" }, null]) {
    const response = await f.call(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  for (const body of ["{", " ".repeat(1025), JSON.stringify({ conversationId: f.parent.id }) + " ".repeat(1024)]) {
    const response = await fetch(f.url, { method: "POST", headers: { authorization: `Bearer ${f.issue.secret}`, "content-type": "application/json" }, body });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  const query = await fetch(f.url + "?conversationId=other", { method: "POST" });
  assert.equal(query.status, 400); await query.json();
  const get = await fetch(f.url, { headers: { authorization: `Bearer ${f.issue.secret}` } });
  assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST"); await get.json();
  const unknown = await fetch(f.daemon.endpoint + "/api/agent/v1/agent/start", { method: "POST" });
  assert.equal(unknown.status, 404); await unknown.json();
  const legacy = await fetch(`${f.daemon.endpoint}/local/conversations/${f.parent.id}/agents/${f.agent.id}/start`, {
    method: "POST", headers: { authorization: `Bearer ${f.issue.secret}` },
  });
  assert.equal(legacy.status, 401); await legacy.json();
  const admin = await fetch(f.adminPath, { headers: { authorization: `Bearer ${f.issue.secret}` } });
  assert.equal(admin.status, 401); await admin.json();
  const core = await fetch(`${f.core.endpoint}/conversations/${f.parent.id}`, { headers: { authorization: `Bearer ${f.issue.secret}` } });
  assert.equal(core.status, 401); await core.json();
  const origin = await f.call(undefined, { origin: "https://evil.example" });
  assert.equal(origin.status, 403); await origin.json();
  const duplicate = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(f.url, { method: "POST", headers: ["host", new URL(f.url).host, "authorization", `Bearer ${f.issue.secret}`,
      "authorization", `Bearer ${f.issue.secret}`, "content-type", "application/json"] }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
    request.once("error", reject); request.end(JSON.stringify({ conversationId: f.parent.id }));
  });
  assert.equal(duplicate, 401);
});

for (const operation of ["rotate", "revoke"] as const) test(`inspection HTTP: ${operation} during held Runtime read withholds data`, async t => {
  const held = latch(), entered = latch();
  t.after(() => held.resolve());
  let calls = 0;
  const f = await fixture(t, { async status() { calls++; entered.resolve(); await held.promise; return "working"; } });
  await f.bind();
  const before = await f.store.listConversationBindings(f.parent.id);
  const pending = f.call();
  await entered.promise;
  const mutation = await fetch(`${f.adminPath}/${f.issue.credential.id}/${operation}`, { method: "POST",
    headers: { cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(mutation.status, 200); await mutation.json();
  held.resolve();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthenticated" });
  assert.equal(calls, 1);
  assert.deepEqual(await f.store.listConversationBindings(f.parent.id), before);
});

test("inspection HTTP: client disconnect ends response work without mutating bindings", async t => {
  const held = latch(), entered = latch();
  t.after(() => held.resolve());
  let calls = 0;
  const f = await fixture(t, { async status() { calls++; entered.resolve(); await held.promise; return "working"; } });
  await f.bind();
  const before = await f.store.listConversationBindings(f.parent.id);
  const request = httpRequest(f.url, { method: "POST", headers: { authorization: `Bearer ${f.issue.secret}`, "content-type": "application/json" } });
  request.on("error", () => undefined);
  request.end(JSON.stringify({ conversationId: f.parent.id }));
  await entered.promise;
  const closed = new Promise<void>(resolve => request.once("close", resolve));
  request.destroy();
  await closed;
  held.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(await f.store.listConversationBindings(f.parent.id), before);
});

test("inspection HTTP: slow request body shares the five-second operation deadline", { timeout: 9_000 }, async t => {
  const f = await fixture(t);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(f.url, { method: "POST", headers: { authorization: `Bearer ${f.issue.secret}`,
      "content-type": "application/json", "content-length": "100" } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.once("end", () => resolve({ status: response.statusCode!, body }));
    });
    request.once("error", reject);
    t.after(() => request.destroy());
    request.write('{"conversationId":'); // Deliberately leave the bounded body incomplete.
  });
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: "inspection_unavailable" });
});

test("inspection HTTP: capabilities advertise the bound listener, never the request Host, and only when inspection is served", async t => {
  const service = { capabilities: () => ({ protocolVersion: 1, features: {} }) } as unknown as LocalControlService;
  const inspection = {} as AgentStatusInspection;
  // fetch cannot override Host, so node:http sends a spoofed but allowed loopback host and port.
  const capabilities = (endpoint: string, host?: string) => new Promise<LocalControlCapabilities>((resolve, reject) => {
    const request = httpRequest(`${endpoint}/local/capabilities`, { headers: host ? { host } : {} }, response => {
      let body = "";
      response.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => resolve(JSON.parse(body) as LocalControlCapabilities));
    });
    request.on("error", reject).end();
  });
  const served = await createLocalControlHttpServer({ service, port: 0, agentInspection: inspection });
  t.after(() => served.close());
  const port = Number(new URL(served.endpoint).port);
  assert.ok(port > 0);
  assert.deepEqual((await capabilities(served.endpoint, "localhost:47411")).agentApi, { inspectionUrl: `http://127.0.0.1:${port}${AGENT_INSPECTION_PATH}` });

  const withoutInspection = await createLocalControlHttpServer({ service, port: 0 });
  t.after(() => withoutInspection.close());
  assert.equal("agentApi" in await capabilities(withoutInspection.endpoint), false);

  let ipv6: Awaited<ReturnType<typeof createLocalControlHttpServer>>;
  try {
    ipv6 = await createLocalControlHttpServer({ service, host: "::1", port: 0, agentInspection: inspection });
  } catch (error) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.diagnostic("IPv6 loopback unavailable"); return; }
    throw error;
  }
  t.after(() => ipv6.close());
  const ipv6Port = Number(new URL(ipv6.endpoint).port);
  assert.deepEqual((await capabilities(ipv6.endpoint, "127.0.0.1:1")).agentApi, { inspectionUrl: `http://[::1]:${ipv6Port}${AGENT_INSPECTION_PATH}` });
});
