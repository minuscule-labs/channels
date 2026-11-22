import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationHttpServer } from "@minu/channels-core";
import { ConversationClient } from "@minu/channels-core/client";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import type { LocalAccountLibraryItem } from "../src/contracts.ts";
import { createLocalControlHttpServer, LocalControlBrowserSessions, LocalControlService } from "../src/server.ts";

const skill = { kind: "skill", name: "Review", description: "Review a change", content: "Read the diff" } as const;
const template = { kind: "agent-template", name: "Reviewer", description: "A reviewer", configuration: {
  personaPrompt: "Review carefully", runtimeAdapter: "pi", modelProvider: "provider", modelId: "model", reasoningLevel: "high",
} } as const;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "minu-account-library-"));
  const publicServer = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(publicServer.endpoint, { serviceToken: publicServer.serviceToken });
  const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const other = await client.createIdentity({ type: "human", displayName: "Other" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
  const configuration = new LocalAgentHostConfiguration({ client, store });
  const service = new LocalControlService({ conversations: client, bindings: store, runtimes: {}, configuration });
  const servers: Array<Awaited<ReturnType<typeof createLocalControlHttpServer>>> = [];
  async function login(identityId: string) {
    const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: identityId });
    const server = await createLocalControlHttpServer({ service, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], port: 0 });
    servers.push(server);
    const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const request = (path = "/local/account/library", method = "GET", body?: unknown) => fetch(`${server.endpoint}${path}`, {
      method, headers: { cookie, origin: sessions.browserOrigin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { server, request, sessions };
  }
  return { owner, other, agent, configuration, client, store, login,
    async close() { for (const server of servers) await server.close(); await publicServer.close(); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const content of [skill, template]) {
  test(`account ${content.kind} CRUD preserves identity, immutable versions and retirement CAS`, async () => {
    const f = await fixture();
    try {
      const { request } = await f.login(f.owner.id);
      assert.deepEqual(await (await request()).json(), []);
      const created = await request(undefined, "POST", content);
      assert.equal(created.status, 201);
      assert.equal(created.headers.get("cache-control"), "no-store");
      const initial = await created.json() as LocalAccountLibraryItem;
      assert.equal(initial.ownerIdentityId, f.owner.id);
      assert.equal(initial.version, 1);
      const path = `/local/account/library/${initial.id}`;
      assert.deepEqual(await (await request(path)).json(), initial);
      const update = { action: "save", expectedVersion: 1, content: { ...content, name: "Updated" } };
      const response = await request(path, "PATCH", update);
      assert.equal(response.status, 200);
      const updated = await response.json() as LocalAccountLibraryItem;
      assert.equal(updated.id, initial.id);
      assert.equal(updated.version, 2);
      assert.equal(updated.name, "Updated");
      assert.equal((await request(path, "PATCH", update)).status, 409);
      assert.deepEqual(await (await request(`${path}/versions`)).json(), [initial, updated]);
      assert.equal((await request(path, "PATCH", { action: "archive", expectedVersion: 1 })).status, 409);
      assert.equal((await request(path, "PATCH", { action: "archive", expectedVersion: 2 })).status, 200);
      const archived = await (await request(path)).json() as LocalAccountLibraryItem;
      assert.equal(archived.state, "archived");
      assert.equal(archived.version, 3);
      assert.equal((await request(path, "PATCH", { ...update, expectedVersion: 3 })).status, 409);
      assert.equal((await (await request(`${path}/versions`)).json()).length, 3);
      assert.equal((await request(`${path}/versions`, "POST", {})).status, 405);
      assert.equal((await request(path, "PUT", {})).status, 405);
    } finally { await f.close(); }
  });
}

test("HTTP account library isolates accounts, rejects forged ownership and never grants workspace access", async () => {
  const f = await fixture();
  try {
    const owner = await f.login(f.owner.id);
    const other = await f.login(f.other.id);
    const item = await (await owner.request(undefined, "POST", skill)).json() as LocalAccountLibraryItem;
    const path = `/local/account/library/${item.id}`;
    assert.deepEqual(await (await other.request()).json(), []);
    for (const [url, method, body] of [[path, "GET"], [`${path}/versions`, "GET"], [path, "PATCH", { action: "archive", expectedVersion: 1 }]] as const) {
      const denied = await other.request(url, method, body);
      assert.equal(denied.status, 404);
      assert.doesNotMatch(await denied.text(), /Read the diff|Review a change/);
    }
    assert.equal((await other.request(undefined, "POST", { ...skill, ownerIdentityId: f.owner.id })).status, 400);
    assert.equal((await other.request(undefined, "POST", { ...template, configuration: { accountSkillIds: [item.id] } })).status, 400);
    const workspace = await f.client.createWorkspace({ slug: "private", name: "Private" });
    await f.client.addWorkspaceMember(workspace.id, { identityId: f.owner.id, mentionHandle: "owner", accessRole: "owner" });
    const before = await f.client.listWorkspaceMembers(workspace.id);
    assert.equal((await other.request(undefined, "POST", template)).status, 201);
    assert.deepEqual(await f.client.listWorkspaceMembers(workspace.id), before);
    assert.deepEqual(await f.store.listWorkspaceAgentConfigs(workspace.id), []);
    assert.equal((await fetch(`${owner.server.endpoint}/local/account/library`)).status, 401);
    await assert.rejects(f.configuration.listAccountLibraryItems(f.agent.id), /human account/);
    const selected = await owner.request(undefined, "POST", { ...template, configuration: { ...template.configuration, accountSkillIds: [item.id] } });
    assert.equal(selected.status, 201);
    assert.equal((await owner.request(path, "PATCH", { action: "save", expectedVersion: 1, content: { ...skill, content: "New content" } })).status, 200);
    assert.deepEqual((await (await owner.request(`/local/account/library/${(await selected.json()).id}`)).json()).configuration.accountSkillIds, [item.id]);
  } finally { await f.close(); }
});

test("account library validates content, refuses runtime state and immutable-field changes", async () => {
  const f = await fixture();
  try {
    const { request } = await f.login(f.owner.id);
    for (const body of [null, [], {}, { ...skill, kind: "instructions" }, { ...skill, name: " " },
      { ...skill, description: "" }, { ...skill, content: "" }, { ...skill, content: "a".repeat(65_537) },
      { ...skill, workspaceId: "workspace" }, { ...skill, version: 7 },
      ...["credentials", "permissions", "runtimeSessionId", "history", "personaRef", "skillIds"].map(key => ({ ...template, configuration: { [key]: "private" } })),
      { ...template, configuration: { modelId: "model" } }, { ...template, configuration: { reasoningLevel: "bad" } },
      { ...template, configuration: { accountSkillIds: ["missing"] } },
      { ...template, configuration: { accountSkillIds: ["duplicate", "duplicate"] } },
    ]) assert.equal((await request(undefined, "POST", body)).status, 400, JSON.stringify(body)?.slice(0, 200));
    assert.deepEqual(await (await request()).json(), []);
    const item = await (await request(undefined, "POST", skill)).json() as LocalAccountLibraryItem;
    const path = `/local/account/library/${item.id}`;
    for (const body of [{ action: "save", expectedVersion: 1, content: template },
      { action: "save", expectedVersion: 1, content: { ...skill, ownerIdentityId: f.other.id } },
      { action: "archive" }, { action: "archive", expectedVersion: 1.5 }, { action: "publish", expectedVersion: 1 },
      { action: "archive", expectedVersion: 1, ownerIdentityId: f.other.id },
    ]) assert.equal((await request(path, "PATCH", body)).status, 400);
    assert.deepEqual(await (await request(`${path}/versions`)).json(), [item]);
  } finally { await f.close(); }
});
