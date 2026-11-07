import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import { captureAuthoredContext } from "@minu/channels-relay";
import { LocalControlClient } from "../src/client.ts";
import { LocalControlBrowserSessions, LocalControlService, createLocalControlHttpServer } from "../src/server.ts";
import type { LocalAuthoredDocument, LocalConversationAuthoredSkillCatalog } from "../src/contracts.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "channels-skill-catalog-"));
  const core = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(join(directory, "relay.db")) });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const member = await client.createIdentity({ type: "human", displayName: "Member" });
  const absent = await client.createIdentity({ type: "human", displayName: "Absent" });
  const outsider = await client.createIdentity({ type: "human", displayName: "Outsider" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
  const workspace = await client.createWorkspace({ slug: "catalog", name: "Catalog" });
  const foreign = await client.createWorkspace({ slug: "foreign-catalog", name: "Foreign" });
  for (const [identity, accessRole] of [[owner, "owner"], [member, "member"], [absent, "member"], [agent, "member"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase(), accessRole });
  }
  await client.addWorkspaceMember(foreign.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id, agent.id] });
  const sibling = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, member.id] });
  const foreignChannel = await client.createConversation({ workspaceId: foreign.id, participantIds: [owner.id] });
  const root = await client.postMessage(parent.id, { participantId: member.id, body: "Thread root", to: [] });
  const thread = await client.createThread(parent.id, { actorIdentityId: member.id, rootMessageId: root.id });
  const configuration = new LocalAgentHostConfiguration({ client, store });
  const create = (value: { name: string; description: string; content: string; conversationId?: string }, workspaceId = workspace.id) =>
    configuration.createAuthoredDocument(workspaceId, owner.id, { kind: "skill", ...value });
  const publish = async (document: LocalAuthoredDocument) => {
    await configuration.updateAuthoredDocument(document.workspaceId, document.id, owner.id, { action: "publish", expectedVersion: document.version });
    return document;
  };
  const shared = await publish(await create({ name: "Decision", description: "Workspace published", content: "PRIVATE_WORKSPACE_PROCEDURE" }));
  const channel = await publish(await create({ name: "Decision", description: "Channel published", content: "PRIVATE_CHANNEL_PROCEDURE", conversationId: parent.id }));
  await create({ name: "PRIVATE_DRAFT_ONLY", description: "PRIVATE_DRAFT_DESCRIPTION", content: "PRIVATE_DRAFT_PROCEDURE" });
  await publish(await create({ name: "PRIVATE_SIBLING", description: "Sibling", content: "PRIVATE_SIBLING_PROCEDURE", conversationId: sibling.id }));
  await publish(await create({ name: "PRIVATE_FOREIGN", description: "Foreign", content: "PRIVATE_FOREIGN_PROCEDURE" }, foreign.id));
  const archived = await publish(await create({ name: "PRIVATE_ARCHIVED", description: "Retired", content: "PRIVATE_ARCHIVED_PROCEDURE" }));
  await configuration.updateAuthoredDocument(workspace.id, archived.id, owner.id, { action: "archive", expectedVersion: 2 });
  const instructions = await configuration.createAuthoredDocument(workspace.id, owner.id, { kind: "instructions", content: "PRIVATE_INSTRUCTIONS" });
  await configuration.updateAuthoredDocument(workspace.id, instructions.id, owner.id, { action: "publish", expectedVersion: 1 });
  await configuration.updateAuthoredDocument(workspace.id, shared.id, owner.id, { action: "save", expectedVersion: 2,
    name: "PRIVATE_DRAFT_NAME", description: "PRIVATE_DRAFT_DESCRIPTION", content: "PRIVATE_NEW_DRAFT_PROCEDURE" });
  const service = new LocalControlService({ conversations: client, bindings: store, runtimes: {}, configuration });
  const servers: Awaited<ReturnType<typeof createLocalControlHttpServer>>[] = [];
  const path = (scope = parent.id) => `/local/conversations/${scope}/authored-skill-catalog`;
  const login = async (identityId: string, options: { now?: () => Date; sessionTtlMs?: number } = {}) => {
    const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: identityId, ...options });
    const server = await createLocalControlHttpServer({ service, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], port: 0 });
    servers.push(server);
    const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!, origin: sessions.browserOrigin, "content-type": "application/json" };
    return { server, headers, request: (route = path(), method = "GET") => fetch(`${server.endpoint}${route}`, { method, headers }) };
  };
  const session = await login(member.id);
  let sideEffects = 0;
  return { ...session, login, path, client, store, configuration, service, workspace, parent, thread, sibling, foreignChannel,
    owner, member, absent, outsider, agent, shared, channel, instructions,
    get sideEffects() { return sideEffects; },
    forbidSideEffects() {
      const fail = async (): Promise<never> => { sideEffects += 1; throw new Error("PRIVATE_CATALOG_SIDE_EFFECT"); };
      client.postMessage = fail; client.postResponse = fail;
      store.reserveAuthoredSkillInvocation = fail; store.reserveAuthoredInvocationMessageLink = fail;
      store.putBinding = fail; store.acquireBindingLease = fail; store.setCursor = fail;
    },
    async close() {
      for (const server of servers) await server.close();
      await core.close(); await store.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}

test("member catalog projects only current published metadata with duplicate provenance and inherited thread scope, without writes", async () => {
  const f = await fixture();
  try {
    const before = await f.client.listMessages(f.parent.id);
    const revisions = f.store.listAuthoredDocumentRevisions.bind(f.store);
    const reads = new Map<string, number>();
    f.store.listAuthoredDocumentRevisions = async (...args) => {
      assert.notEqual(args[1], f.instructions.id, "Catalog does not resolve private standing instructions");
      reads.set(args[1], (reads.get(args[1]) ?? 0) + 1);
      return revisions(...args);
    };
    f.forbidSideEffects();
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const catalog = await response.json() as LocalConversationAuthoredSkillCatalog;
    assert.deepEqual(Object.keys(catalog).sort(), ["agents", "availability", "channelId", "conversationId", "skills", "workspaceId"]);
    assert.equal(catalog.availability, "not_checked", "Discovery is not recipient availability or a send grant");
    assert.equal(catalog.channelId, f.parent.id);
    assert.equal(catalog.skills.length, 2);
    assert.deepEqual([...reads.values()], [1, 1], "Each publication history is read only once per catalog");
    assert.deepEqual(catalog.skills.map(skill => [skill.documentId, skill.source, skill.name, skill.description, skill.revision]).sort(), [
      [f.shared.id, "workspace", "Decision", "Workspace published", 1],
      [f.channel.id, "channel", "Decision", "Channel published", 1],
    ].sort());
    for (const skill of catalog.skills) {
      assert.deepEqual(Object.keys(skill).sort(), ["contentHash", "description", "documentId", "name", "revision", "source"]);
      assert.match(skill.contentHash, /^[a-f0-9]{64}$/);
    }
    const inherited = await f.request(f.path(f.thread.id));
    assert.equal(inherited.status, 200);
    assert.deepEqual(await inherited.json(), { ...catalog, conversationId: f.thread.id });
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_|createdBy|publishedBy|content"|instructions|binding|session|runtime/);
    assert.equal(f.service.authoredSkillPublicationEnabled, false);
    assert.equal(f.sideEffects, 0);
    assert.deepEqual(await f.client.listMessages(f.parent.id), before);
    assert.deepEqual(await f.store.listWorkspaceBindings(f.workspace.id), []);
  } finally { await f.close(); }
});

test("catalog uses cookie identity and current member participation without widening authoring or foreign access", async () => {
  const f = await fixture();
  try {
    assert.equal((await (await f.login(f.owner.id)).request()).status, 200);
    for (const identity of [f.outsider, f.absent, f.agent]) {
      assert.equal((await (await f.login(identity.id)).request()).status, 403);
    }
    assert.equal((await f.request(f.path(f.foreignChannel.id))).status, 403);
    assert.equal((await f.request(f.path("missing"))).status, 404);
    for (const route of [
      `/local/conversations/${f.parent.id}/authored-context`,
      `/local/workspaces/${f.workspace.id}/authored-documents`,
      `/local/workspaces/${f.workspace.id}/authored-documents/${f.shared.id}`,
      `/local/workspaces/${f.workspace.id}/authored-documents/${f.shared.id}/revisions`,
    ]) assert.equal((await f.request(route)).status, 403);
  } finally { await f.close(); }
});

test("catalog HTTP is credentialed GET-only, no-store and accepts no actor/scope/query overrides", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.server.endpoint}${f.path()}`, { headers: { origin: f.headers.origin } })).status, 401);
    assert.equal((await fetch(`${f.server.endpoint}${f.path()}`, { headers: { ...f.headers, origin: "https://foreign.invalid" } })).status, 403);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const denied = await f.request(f.path(), method);
      assert.equal(denied.status, 405);
      assert.equal(denied.headers.get("allow"), "GET");
    }
    assert.equal((await f.request(`${f.path()}?actorIdentityId=${f.owner.id}`)).status, 400);
    assert.equal((await f.request(`${f.path()}?workspaceId=foreign`)).status, 400);
    assert.equal((await f.request(f.path("%ZZ"))).status, 400);
  } finally { await f.close(); }
});

for (const duringRead of [false, true]) {
  test(`catalog denies revoked human access ${duringRead ? "during" : "before"} private reads`, async () => {
    const f = await fixture();
    try {
      let reads = 0;
      const original = f.store.listAuthoredDocumentRevisions.bind(f.store);
      const revoke = () => f.client.updateWorkspaceMember(f.workspace.id, f.member.id, { actorIdentityId: f.owner.id, status: "disabled" });
      f.store.listAuthoredDocumentRevisions = async (...args) => {
        reads += 1;
        const result = await original(...args);
        if (duringRead && reads === 1) await revoke();
        return result;
      };
      if (!duringRead) await revoke();
      const response = await f.request();
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /Decision|PRIVATE_/);
      if (!duringRead) assert.equal(reads, 0);
    } finally { await f.close(); }
  });
}

test("catalog reauthenticates the browser session after awaited catalog I/O", async () => {
  const f = await fixture();
  try {
    let now = Date.now();
    const browser = await f.login(f.member.id, { now: () => new Date(now), sessionTtlMs: 60_000 });
    const get = f.configuration.getConversationAuthoredSkillCatalog.bind(f.configuration);
    f.configuration.getConversationAuthoredSkillCatalog = async (...args) => {
      const catalog = await get(...args); now += 60_001; return catalog;
    };
    const response = await browser.request();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /Decision|PRIVATE_/);
  } finally { await f.close(); }
});

for (const action of ["archive", "publish"] as const) {
  test(`catalog tolerates a publication-head ${action} change during reads without granting execution`, async () => {
    const f = await fixture();
    try {
      const original = f.store.listAuthoredDocumentRevisions.bind(f.store);
      let changed = false;
      f.store.listAuthoredDocumentRevisions = async (...args) => {
        const result = await original(...args);
        if (!changed && args[1] === f.channel.id) {
          changed = true;
          await f.configuration.updateAuthoredDocument(f.workspace.id, f.channel.id, f.owner.id, { action, expectedVersion: 2 });
        }
        return result;
      };
      const response = await f.request();
      assert.equal(response.status, 200);
      assert.equal(changed, true);
      const catalog = await response.json() as LocalConversationAuthoredSkillCatalog;
      assert.equal(catalog.availability, "not_checked");
      const selected = catalog.skills.find(skill => skill.documentId === f.channel.id)!;
      assert.equal(selected.revision, 1);
      assert.equal(selected.name, "Decision");
      if (action === "archive") {
        await assert.rejects(f.configuration.acceptAuthoredSkillInvocation(f.parent.id, f.member.id, "stale-selection", {
          documentId: selected.documentId, source: selected.source, revision: selected.revision, arguments: "", to: [f.agent.id],
        }), /Skill publication is unavailable/);
        const fresh = await (await f.request()).json() as LocalConversationAuthoredSkillCatalog;
        assert.equal(fresh.skills.some(skill => skill.documentId === selected.documentId), false);
      }
    } finally { await f.close(); }
  });
}

for (const fault of ["missing", "corrupt", "foreign", "read_error"] as const) {
  test(`catalog fails closed on ${fault} published metadata with no draft/body fallback`, async () => {
    const f = await fixture();
    try {
      const original = f.store.listAuthoredDocumentRevisions.bind(f.store);
      f.store.listAuthoredDocumentRevisions = async (...args) => {
        if (args[1] !== f.shared.id) return original(...args);
        if (fault === "read_error") throw new Error("PRIVATE_DATABASE_DETAILS");
        if (fault === "missing") return [];
        if (fault === "foreign") return (await original(...args)).map(revision => ({ ...revision, workspaceId: "foreign" }));
        return (await original(...args)).map(revision => ({ ...revision, content: "PRIVATE_CORRUPT_PROCEDURE" }));
      };
      const response = await f.request();
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "Skill catalog is unavailable" });
    } finally { await f.close(); }
  });
}

test("catalog service projection strips accidental private provider fields", async () => {
  const f = await fixture();
  try {
    const get = f.configuration.getConversationAuthoredSkillCatalog.bind(f.configuration);
    f.configuration.getConversationAuthoredSkillCatalog = async (...args) => {
      const catalog = await get(...args);
      return { ...catalog, content: "PRIVATE_EXTRA_BODY", skills: catalog.skills.map(skill => ({ ...skill, content: "PRIVATE_EXTRA_PROCEDURE", path: "PRIVATE_HOST_PATH" })) };
    };
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /PRIVATE_|content"|path"/);
  } finally { await f.close(); }
});

test("catalog projects skill-only session references and safe configured Harness IDs without Runtime calls", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    await f.store.putAgentConfig({ id: "picker-agent", workspaceId: f.workspace.id, agentIdentityId: f.agent.id,
      runtimeAdapter: "picker", skillIds: ["skill:review", "/private/skill.md", "../hidden"], status: "active", createdAt: now, updatedAt: now });
    const manifest = await captureAuthoredContext(f.store, f.workspace.id, f.parent.id);
    await f.store.putBinding({ id: "picker-binding", workspaceAgentConfigId: "picker-agent", workspaceId: f.workspace.id,
      conversationId: f.parent.id, agentIdentityId: f.agent.id, runtimeAdapter: "picker", runtimeSessionId: "PRIVATE_SESSION",
      runtimeOwnerId: "PRIVATE_OWNER", generation: 1, state: "connected", wakePolicy: "mentions", createdAt: now, updatedAt: now }, { authoredContext: manifest });
    let calls = 0;
    const configuration = new LocalAgentHostConfiguration({ client: f.client, store: f.store, runtimes: { picker: {
      async startTurn() { calls += 1; throw new Error("No dispatch during discovery"); }, async turn() { calls += 1; return undefined; },
    } } });
    f.configuration.getConversationAuthoredSkillCatalog = configuration.getConversationAuthoredSkillCatalog.bind(configuration);
    const response = await f.request();
    assert.equal(response.status, 200);
    const catalog = await response.json() as LocalConversationAuthoredSkillCatalog;
    assert.equal(catalog.agents?.length, 1);
    assert.equal(catalog.agents[0]!.state, "ready");
    assert.equal(catalog.agents[0]!.supported, true);
    assert.equal(catalog.agents[0]!.skills.length, 2);
    assert.deepEqual(catalog.agents[0]!.harness, ["skill:review"]);
    assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_|private\/|hidden|instructions|runtimeSessionId|bindingId|generation/);
  } finally { await f.close(); }
});

test("typed catalog client encodes scope and uses a credentialed GET without mutation", async t => {
  const catalog: LocalConversationAuthoredSkillCatalog = { workspaceId: "workspace", conversationId: "scope /? ü", channelId: "parent", availability: "not_checked", skills: [] };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const client = new LocalControlClient("http://127.0.0.1:1234");
    assert.deepEqual(await client.getConversationAuthoredSkillCatalog(catalog.conversationId), catalog);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `http://127.0.0.1:1234/local/conversations/${encodeURIComponent(catalog.conversationId)}/authored-skill-catalog`);
    assert.equal(calls[0]!.init?.credentials, "include");
    assert.equal(calls[0]!.init?.method ?? "GET", "GET");
    assert.equal(calls[0]!.init?.body, undefined);
  } finally { mock.mock.restore(); }
});
