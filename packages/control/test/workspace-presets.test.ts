import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResourceId, createConversationHttpServer } from "@minu/channels-core";
import { ConversationClient } from "@minu/channels-core/client";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHost, type ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { LocalAgentHostConfiguration, LocalConfigurationRequestError } from "../src/configuration.ts";
import { createLocalControlHttpServer, LocalControlBrowserSessions, LocalControlService } from "../src/server.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "minu-workspace-preset-"));
  const core = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const other = await client.createIdentity({ type: "human", displayName: "Other" });
  const url = localRelayLibSqlUrl(join(directory, "relay.db"));
  let store = await DrizzleLibSqlRelayStorage.open({ url });
  let config = new LocalAgentHostConfiguration({ client, store });
  const skill = await config.createAccountLibraryItem(owner.id, { kind: "skill", name: "Review", description: "Shared", content: "PRIVATE_SHARED_PROCEDURE" });
  const templateContent = { kind: "agent-template" as const, name: "Base", description: "Private", configuration: { personaPrompt: "BASE_PRIVATE_PROMPT", runtimeAdapter: "pi", accountSkillIds: [skill.id] } };
  const template = await config.createAccountLibraryItem(owner.id, templateContent);
  const content = { kind: "workspace-preset" as const, name: "Engineering", description: "Starter", definition: {
    agents: [{ key: "review", templateId: template.id, displayName: "Reviewer", mentionHandle: "reviewer", accountSkillIds: [skill.id] }],
    conversationPresets: [{ name: "Review channel", agentKeys: ["review"], guidance: "Discuss findings" }], instructions: "DEFAULT_WORKSPACE_INSTRUCTIONS", idleSleepTimeoutMs: 900_000, turnTimeoutMs: 7_200_000,
  } };
  const preset = await config.createAccountLibraryItem(owner.id, content);
  const plan = await config.previewWorkspacePreset(preset.id, owner.id);
  const input = { requestId: "creation_request_12345", slug: "new-workspace", name: "New workspace", rootUri: directory, plan };
  const servers: Array<Awaited<ReturnType<typeof createLocalControlHttpServer>>> = [];
  async function login(actor = owner.id) {
    const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: actor });
    const server = await createLocalControlHttpServer({ port: 0, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], service: new LocalControlService({ conversations: client, bindings: store, runtimes: {}, configuration: config }) });
    servers.push(server);
    const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    return (path: string, method = "GET", body?: unknown) => fetch(`${server.endpoint}${path}`, { method, headers: { cookie, origin: sessions.browserOrigin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { directory, client, owner, other, skill, template, templateContent, preset, content, plan, input, login,
    get store() { return store; }, get config() { return config; },
    async reopen() { await store.close(); store = await DrizzleLibSqlRelayStorage.open({ url }); config = new LocalAgentHostConfiguration({ client, store }); },
    async close() { for (const server of servers) await server.close(); await core.close(); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("workspace presets retain stable versioned ownership and reject non-reusable fields", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const other = await f.login(f.other.id);
    const path = `/local/account/library/${f.preset.id}`;
    assert.equal((await other(path)).status, 404);
    assert.equal((await other(`${path}/preview`)).status, 404);
    assert.equal((await request(path, "PATCH", { action: "save", expectedVersion: 1, content: { ...f.content, name: "Updated preset" } })).status, 200);
    assert.equal((await request(path, "PATCH", { action: "archive", expectedVersion: 1 })).status, 409);
    for (const definition of [{ ...f.content.definition, credentials: {} }, { ...f.content.definition, rootUri: "/private/source" },
      { ...f.content.definition, agents: [{ ...f.content.definition.agents[0], accessRole: "owner" }] },
      { ...f.content.definition, conversationPresets: [{ name: "Bad", agentKeys: ["foreign"] }] },
      { ...f.content.definition, agents: [{ ...f.content.definition.agents[0], mentionHandle: "you" }] },
    ]) assert.equal((await request("/local/account/library", "POST", { ...f.content, definition })).status, 400);
    assert.equal((await request(path, "PATCH", { action: "archive", expectedVersion: 2 })).status, 200);
    assert.equal((await request(`${path}/preview`)).status, 404);
    assert.equal((await (await request(`${path}/versions`)).json()).length, 3);
    assert.deepEqual(await f.client.listWorkspaces(), []);
  } finally { await f.close(); }
});

test("workspace composition creates customized independent agents, shared refs, conversation presets and defaults only", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const input = structuredClone(f.input);
    input.plan.instructions = "CUSTOMIZED_DEFAULTS";
    input.plan.agents[0]!.displayName = "Local reviewer";
    input.plan.agents[0]!.configuration.personaPrompt = "CUSTOMIZED_AGENT_PROMPT";
    const response = await request("/local/workspace-compositions", "POST", input);
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json();
    const record = await f.config.getWorkspaceComposition(input.requestId, f.owner.id);
    assert.equal(record.state, "complete");
    assert.equal(record.workspaceId, result.workspaceId);
    const ids = record.agents[0]!;
    assert.notEqual(ids.identityId, f.template.id);
    const agent = (await f.store.getWorkspaceAgentConfig(result.workspaceId, ids.identityId))!;
    assert.equal(agent.personaPrompt, "CUSTOMIZED_AGENT_PROMPT");
    assert.deepEqual(agent.accountSkills, { ownerIdentityId: f.owner.id, skillIds: [f.skill.id] });
    assert.deepEqual(agent.skillIds, []);
    assert.equal(agent.personaRef, undefined);
    const members = await f.client.listWorkspaceMembers(result.workspaceId);
    assert.deepEqual(members.map(member => member.accessRole).sort(), ["member", "owner"]);
    assert.equal((await f.client.getIdentity(ids.identityId)).publicProfile, undefined);
    const conversation = await f.client.getConversation(result.conversationId);
    assert.deepEqual(conversation.participants.map(p => p.id), [f.owner.id]);
    assert.deepEqual(await f.client.listMessages(conversation.id), []);
    assert.deepEqual(await f.store.listWorkspaceBindings(result.workspaceId), []);
    assert.deepEqual(await f.store.listSessionHistory(conversation.id), []);
    const workspace = (await f.store.getWorkspaceConfig(result.workspaceId))!;
    assert.equal(workspace.idleSleepTimeoutMs, 900_000);
    assert.equal(workspace.turnTimeoutMs, 7_200_000);
    assert.equal(workspace.notesFolderId, undefined);
    assert.equal(workspace.runtimeModelPolicies, undefined);
    const presets = await f.store.listConversationPresets(result.workspaceId);
    assert.deepEqual(presets[0]!.participants, [{ identityId: ids.identityId }]);
    assert.equal(presets[0]!.guidance, "Discuss findings");
    // Explicitly create a Conversation from the installed preset, then launch its fresh agent.
    // Composition itself creates neither assignments nor Runtime sessions.
    const channel = await f.config.createConversationWithSetup(result.workspaceId, f.owner.id, {
      id: createResourceId("conversation"), name: "Reviewed channel", participants: presets[0]!.participants, guidance: presets[0]!.guidance,
    });
    await f.config.updateAccountLibraryItem(f.skill.id, f.owner.id, { action: "save", expectedVersion: 1,
      content: { kind: "skill", name: "Review", description: "Shared", content: "SHARED_EDIT_AFTER_COMPOSITION" } });
    const starts: ManagedRuntimeStartConfig[] = [];
    const runtime = { async start(config: ManagedRuntimeStartConfig) { starts.push(config); return { id: "composed-session" }; }, async status() { return "idle" as const; }, async send() {}, async messages() { return []; }, async stop() {} };
    const host = new LocalAgentHost({ client: f.client, store: f.store, runtimes: { pi: runtime } });
    try {
      await host.startConversationAgent(channel.id, ids.identityId, f.owner.id);
      assert.match(starts[0]!.appendSystemPrompt!, /SHARED_EDIT_AFTER_COMPOSITION/);
      assert.match(starts[0]!.appendSystemPrompt!, /CUSTOMIZED_DEFAULTS/);
      assert.match(starts[0]!.appendSystemPrompt!, /Discuss findings/);
      assert.equal((await f.store.listSessionHistory(channel.id))[0]!.authoredContext?.accountSkills?.[0]?.revision, 2);
    } finally { await host.close(); }
    assert.equal((await f.store.listAuthoredDocuments(result.workspaceId))[0]!.content, "CUSTOMIZED_DEFAULTS");
    assert.doesNotMatch(JSON.stringify({ conversation, members, identity: await f.client.getIdentity(ids.identityId) }), /CUSTOMIZED_AGENT_PROMPT|PRIVATE_SHARED_PROCEDURE|CUSTOMIZED_DEFAULTS/);
    await f.config.updateAccountLibraryItem(f.template.id, f.owner.id, { action: "save", expectedVersion: 1, content: { ...f.templateContent, configuration: { ...f.templateContent.configuration, personaPrompt: "NEW_TEMPLATE" } } });
    assert.equal((await f.store.getWorkspaceAgentConfig(result.workspaceId, ids.identityId))?.personaPrompt, "CUSTOMIZED_AGENT_PROMPT");
    await f.store.putAgentConfig({ ...agent, personaPrompt: "LOCAL_AFTER_CREATION" });
    assert.deepEqual(await (await request("/local/workspace-compositions", "POST", input)).json(), result);
    assert.equal((await f.store.getWorkspaceAgentConfig(result.workspaceId, ids.identityId))?.personaPrompt, "LOCAL_AFTER_CREATION");
    const other = await f.login(f.other.id);
    assert.equal((await other(`/local/workspace-compositions/${input.requestId}`)).status, 404);
  } finally { await f.close(); }
});

test("partial composition reopens from its frozen receipt and retries without duplicate workspaces or agents", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const write = f.store.createAgentConfig.bind(f.store);
    let writes = 0;
    f.store.createAgentConfig = async config => { writes++; if (writes === 1) throw new Error("injected failure"); return write(config); };
    assert.equal((await request("/local/workspace-compositions", "POST", f.input)).status, 409);
    const receiptResponse = await request(`/local/workspace-compositions/${f.input.requestId}`);
    assert.equal(receiptResponse.headers.get("cache-control"), "no-store");
    const receipt = await receiptResponse.json();
    assert.equal(receipt.state, "pending");
    const beforeIdentities = await f.client.listIdentities();
    assert.equal((await request("/local/workspace-compositions", "POST", { ...f.input, name: "Changed intent" })).status, 409);
    await f.config.updateAccountLibraryItem(f.template.id, f.owner.id, { action: "save", expectedVersion: 1, content: { ...f.templateContent, configuration: { personaPrompt: "NEW_BASE" } } });
    await f.config.updateAccountLibraryItem(f.preset.id, f.owner.id, { action: "archive", expectedVersion: 1 });
    await f.reopen();
    const retry = await f.login();
    const response = await retry("/local/workspace-compositions", "POST", receipt.request);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).workspaceId, receipt.workspaceId);
    assert.deepEqual(await f.client.listIdentities(), beforeIdentities);
    assert.equal((await f.client.listWorkspaces()).length, 1);
    assert.equal((await f.store.listWorkspaceAgentConfigs(receipt.workspaceId)).length, 1);
    assert.equal((await f.store.getWorkspaceAgentConfig(receipt.workspaceId, receipt.agents[0].identityId))?.personaPrompt, "BASE_PRIVATE_PROMPT");
    assert.equal((await f.config.getWorkspaceComposition(f.input.requestId, f.owner.id)).state, "complete");
  } finally { await f.close(); }
});

test("concurrent submissions and lost acknowledgments reconcile the same reserved identities", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const create = f.client.createWorkspace.bind(f.client);
    let creates = 0;
    f.client.createWorkspace = async input => { creates++; await create(input); throw new Error("lost acknowledgement"); };
    const results = await Promise.all([request("/local/workspace-compositions", "POST", f.input), request("/local/workspace-compositions", "POST", f.input)]);
    assert.deepEqual(results.map(result => result.status), [201, 201]);
    assert.deepEqual(await results[0]!.json(), await results[1]!.json());
    assert.equal(creates, 1);
    assert.equal((await f.client.listWorkspaces()).length, 1);
    assert.equal((await f.client.listIdentities()).filter(identity => identity.type === "agent").length, 1);
  } finally { await f.close(); }
});

test("composition rejects stale/foreign sources and unsafe overrides before allocating public resources", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const other = await f.login(f.other.id);
    assert.equal((await other("/local/workspace-compositions", "POST", f.input)).status, 404);
    for (const input of [{ ...f.input, plan: { ...f.plan, credentials: {} } },
      { ...f.input, plan: { ...f.plan, agents: [{ ...f.plan.agents[0], configuration: { credentials: {} } }] } },
      { ...f.input, accessRole: "owner" },
    ]) assert.equal((await request("/local/workspace-compositions", "POST", input)).status, 400);
    assert.equal((await request("/local/workspace-compositions", "POST", { ...f.input, plan: { ...f.plan, presetVersion: 99 } })).status, 409);
    assert.equal((await request("/local/workspace-compositions", "POST", { ...f.input, plan: { ...f.plan, agents: [{ ...f.plan.agents[0], templateVersion: 99 }] } })).status, 409);
    assert.deepEqual(await f.client.listWorkspaces(), []);
    assert.equal((await f.client.listIdentities()).length, 2);
    assert.deepEqual(await f.config.listWorkspaceCompositions(f.owner.id), []);
  } finally { await f.close(); }
});

test("composition errors distinguish definitive pre-reservation rejection from uncertain reservation dispatch", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const rejected = await request("/local/workspace-compositions", "POST", { ...f.input, plan: { ...f.plan, presetVersion: 99 } });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).compositionOutcome, "rejected-before-reservation");
    const oversized = await request("/local/workspace-compositions", "POST", { ...f.input, plan: { ...f.plan, instructions: "x".repeat(128 * 1024) } });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).compositionOutcome, "rejected-before-reservation");
    const reserve = f.store.reserveWorkspaceComposition.bind(f.store);
    f.store.reserveWorkspaceComposition = async record => { await reserve(record); throw new LocalConfigurationRequestError("Reservation acknowledgment lost", 409, "unavailable"); };
    const uncertain = await request("/local/workspace-compositions", "POST", f.input);
    assert.equal(uncertain.status, 409);
    assert.equal((await uncertain.json()).compositionOutcome, undefined);
    assert.equal((await f.config.getWorkspaceComposition(f.input.requestId, f.owner.id)).state, "pending");
    f.store.reserveWorkspaceComposition = reserve;
    assert.equal((await request("/local/workspace-compositions", "POST", f.input)).status, 201);
    const changed = await request("/local/workspace-compositions", "POST", { ...f.input, name: "Different intent" });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).compositionOutcome, undefined);
    assert.equal((await f.client.listWorkspaces()).length, 1);
  } finally { await f.close(); }
});

test("retry refuses to overwrite edited partial resources", async () => {
  const f = await fixture();
  try {
    const create = f.store.createAuthoredDocument.bind(f.store);
    f.store.createAuthoredDocument = async () => { throw new Error("injected publication failure"); };
    await assert.rejects(f.config.composeWorkspace(f.owner.id, f.input), /incomplete/);
    const receipt = await f.config.getWorkspaceComposition(f.input.requestId, f.owner.id);
    const config = (await f.store.getWorkspaceAgentConfig(receipt.workspaceId, receipt.agents[0]!.identityId))!;
    await f.store.putAgentConfig({ ...config, personaPrompt: "PRESERVE_LOCAL_EDIT" });
    f.store.createAuthoredDocument = create;
    await assert.rejects(f.config.composeWorkspace(f.owner.id, f.input), /incomplete/);
    assert.equal((await f.store.getAgentConfig(config.id))?.personaPrompt, "PRESERVE_LOCAL_EDIT");
    assert.equal((await f.client.listIdentities()).filter(identity => identity.type === "agent").length, 1);
  } finally { await f.close(); }
});
