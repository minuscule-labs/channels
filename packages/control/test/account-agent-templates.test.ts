import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createConversationHttpServer } from "@minu/channels-core";
import { ConversationClient } from "@minu/channels-core/client";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHostConfiguration } from "../src/configuration.ts";
import type { CreateWorkspaceAgentFromAccountTemplateResult } from "../src/contracts.ts";
import { createLocalControlHttpServer, LocalControlBrowserSessions, LocalControlService } from "../src/server.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "minu-account-template-"));
  const publicServer = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(publicServer.endpoint, { serviceToken: publicServer.serviceToken });
  const databaseUrl = localRelayLibSqlUrl(join(directory, "relay.db"));
  const store = await DrizzleLibSqlRelayStorage.open({ url: databaseUrl });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const other = await client.createIdentity({ type: "human", displayName: "Other" });
  const member = await client.createIdentity({ type: "human", displayName: "Member" });
  const workspace = await client.createWorkspace({ slug: "template-target", name: "Target" });
  const second = await client.createWorkspace({ slug: "template-target-2", name: "Target 2" });
  for (const w of [workspace, second]) {
    await client.addWorkspaceMember(w.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
    await store.putWorkspaceConfig({ workspaceId: w.id, rootUri: pathToFileURL(directory).href, createdAt: "now", updatedAt: "now" });
  }
  await client.addWorkspaceMember(workspace.id, { identityId: other.id, mentionHandle: "other", accessRole: "admin" });
  await client.addWorkspaceMember(workspace.id, { identityId: member.id, mentionHandle: "member" });
  const conversation = await client.createConversation({ workspaceId: workspace.id, name: "Keep separate", participantIds: [owner.id] });
  await client.postMessage(conversation.id, { participantId: owner.id, body: "WORKSPACE_HISTORY_MUST_NOT_COPY" });
  const configuration = new LocalAgentHostConfiguration({ client, store, runtimes: { pi: { async capabilities() {
    return { models: [{ provider: "provider", id: "model", name: "Model", reasoning: true }], reasoningLevels: ["high"], skills: [] };
  } } } });
  const service = new LocalControlService({ conversations: client, bindings: store, runtimes: {}, configuration });
  const servers: Array<Awaited<ReturnType<typeof createLocalControlHttpServer>>> = [];
  async function login(identityId = owner.id) {
    const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: identityId });
    const server = await createLocalControlHttpServer({ service, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], port: 0 });
    servers.push(server);
    const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    return (path: string, method = "POST", body?: unknown) => fetch(`${server.endpoint}${path}`, {
      method, headers: { cookie, origin: sessions.browserOrigin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const skill = await configuration.createAccountLibraryItem(owner.id, { kind: "skill", name: "Review skill", description: "Shared reference", content: "ACCOUNT_SKILL_BODY" });
  const content = { kind: "agent-template" as const, name: "Base reviewer", description: "PRIVATE_TEMPLATE_DESCRIPTION",
    configuration: { personaPrompt: "PRIVATE_TEMPLATE_INSTRUCTIONS", runtimeAdapter: "pi", modelProvider: "provider", modelId: "model", reasoningLevel: "high", accountSkillIds: [skill.id] } };
  const template = await configuration.createAccountLibraryItem(owner.id, content);
  const input = { templateId: template.id, expectedTemplateVersion: 1, displayName: "Local reviewer", mentionHandle: "local-reviewer" };
  return { directory, databaseUrl, store, client, configuration, workspace, second, conversation, owner, other, member, skill, content, template, input, login,
    path: `/local/workspaces/${workspace.id}/agents/from-account-template`,
    async close() { for (const server of servers) await server.close(); await publicServer.close(); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("account agent additions create fresh independent workspace configs without runtime state or elevated access", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const originalMessages = await f.client.listMessages(f.conversation.id);
    const response = await request(f.path, "POST", f.input);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const first = await response.json() as CreateWorkspaceAgentFromAccountTemplateResult;
    assert.equal(first.identity.type, "agent");
    assert.equal(first.identity.publicProfile, undefined);
    assert.equal(first.member.accessRole, "member");
    assert.equal(first.member.roleLabel, undefined);
    assert.equal(first.member.profileOverride, undefined);
    assert.equal(first.templateVersion, 1);
    const config = (await f.store.getWorkspaceAgentConfig(f.workspace.id, first.identity.id))!;
    assert.equal(config.personaPrompt, f.content.configuration.personaPrompt);
    assert.equal(config.runtimeAdapter, "pi");
    assert.equal(config.modelProvider, "provider");
    assert.equal(config.modelId, "model");
    assert.equal(config.reasoningLevel, "high");
    assert.deepEqual(config.accountSkills, { ownerIdentityId: f.owner.id, skillIds: [f.skill.id] });
    assert.deepEqual(config.skillIds, []);
    assert.equal(config.personaRef, undefined);
    assert.deepEqual(await f.store.listWorkspaceBindings(f.workspace.id), []);
    assert.deepEqual(await f.store.listSessionHistory(f.conversation.id, first.identity.id), []);
    assert.deepEqual(await f.client.listMessages(f.conversation.id), originalMessages);
    assert.equal((await f.client.getConversation(f.conversation.id)).participants.some(p => p.id === first.identity.id), false);
    // Existing workspace-local configuration editing cannot mutate the source library.
    await f.configuration.updateWorkspaceAgentConfiguration(f.workspace.id, first.identity.id, f.owner.id, { personaPrompt: "LOCAL_CUSTOMIZATION" });
    assert.deepEqual(await f.configuration.getAccountLibraryItem(f.template.id, f.owner.id), f.template);
    const source = await f.configuration.updateAccountLibraryItem(f.template.id, f.owner.id, { action: "save", expectedVersion: 1,
      content: { ...f.content, configuration: { ...f.content.configuration, personaPrompt: "NEW_SOURCE_INSTRUCTIONS", accountSkillIds: [] } } });
    assert.equal((await f.store.getWorkspaceAgentConfig(f.workspace.id, first.identity.id))?.personaPrompt, "LOCAL_CUSTOMIZATION");
    const second = await request(`/local/workspaces/${f.second.id}/agents/from-account-template`, "POST", { ...f.input, expectedTemplateVersion: source.version });
    assert.equal(second.status, 201);
    const added = await second.json() as CreateWorkspaceAgentFromAccountTemplateResult;
    assert.notEqual(added.identity.id, first.identity.id);
    const nextConfig = (await f.store.getWorkspaceAgentConfig(f.second.id, added.identity.id))!;
    assert.notEqual(nextConfig.id, config.id);
    assert.equal(nextConfig.personaPrompt, "NEW_SOURCE_INSTRUCTIONS");
    assert.equal(nextConfig.accountSkills, undefined);
    assert.deepEqual((await f.store.getWorkspaceAgentConfig(f.workspace.id, first.identity.id))?.accountSkills, config.accountSkills);
    assert.equal((await f.store.getWorkspaceAgentConfig(f.workspace.id, first.identity.id))?.personaPrompt, "LOCAL_CUSTOMIZATION");
    // Private reference metadata survives persistence and local saves without aliasing.
    const reopened = await DrizzleLibSqlRelayStorage.open({ url: f.databaseUrl });
    try { assert.deepEqual((await reopened.getWorkspaceAgentConfig(f.workspace.id, first.identity.id))?.accountSkills, config.accountSkills); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("account-template addition rejects ownership, access, invalid/stale inputs and retired sources before side effects", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const before = await f.client.listIdentities();
    assert.equal((await (await f.login(f.other.id))(f.path, "POST", f.input)).status, 404);
    assert.equal((await (await f.login(f.member.id))(f.path, "POST", f.input)).status, 403);
    assert.equal((await request(`/local/workspaces/${f.second.id}/agents/from-account-template`, "GET")).status, 405);
    for (const body of [{ ...f.input, accessRole: "owner" }, { ...f.input, credentials: {} }, { ...f.input, configuration: {} },
      { ...f.input, actorIdentityId: f.other.id }, { ...f.input, ownerIdentityId: f.other.id },
      { ...f.input, mentionHandle: "conversation" }, { ...f.input, mentionHandle: "bad handle" },
      { ...f.input, expectedTemplateVersion: null }, { ...f.input, expectedTemplateVersion: 1.5 },
    ]) assert.equal((await request(f.path, "POST", body)).status, 400);
    assert.equal((await request(f.path, "POST", { ...f.input, mentionHandle: "owner" })).status, 409);
    assert.equal((await request(f.path, "POST", { ...f.input, expectedTemplateVersion: 99 })).status, 409);
    assert.equal((await request(f.path, "POST", { ...f.input, templateId: f.skill.id })).status, 404);
    await f.configuration.updateAccountLibraryItem(f.template.id, f.owner.id, { action: "archive", expectedVersion: 1 });
    assert.equal((await request(f.path, "POST", f.input)).status, 404);
    assert.deepEqual(await f.client.listIdentities(), before);
    assert.deepEqual(await f.store.listWorkspaceAgentConfigs(f.workspace.id), []);
  } finally { await f.close(); }
});

test("destination model policy and source skill retirement are enforced without granting additional access", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const before = await f.client.listIdentities();
    const workspace = (await f.store.getWorkspaceConfig(f.workspace.id))!;
    await f.store.putWorkspaceConfig({ ...workspace, runtimeModelPolicies: { pi: [] } });
    assert.equal((await request(f.path, "POST", f.input)).status, 409);
    assert.deepEqual(await f.client.listIdentities(), before);
    await f.store.putWorkspaceConfig(workspace);
    await f.configuration.updateAccountLibraryItem(f.skill.id, f.owner.id, { action: "archive", expectedVersion: 1 });
    assert.equal((await request(f.path, "POST", f.input)).status, 400);
    assert.deepEqual(await f.client.listIdentities(), before);
  } finally { await f.close(); }
});

test("account-template addition rechecks destination authority after private source reads", async () => {
  const f = await fixture();
  try {
    await f.client.updateWorkspaceMember(f.workspace.id, f.other.id, { actorIdentityId: f.owner.id, accessRole: "owner" });
    const request = await f.login();
    const before = await f.client.listIdentities();
    const read = f.store.getAccountLibraryItem.bind(f.store);
    let demoted = false;
    f.store.getAccountLibraryItem = async (...args) => {
      const result = await read(...args);
      if (!demoted) { demoted = true; await f.client.updateWorkspaceMember(f.workspace.id, f.owner.id, { actorIdentityId: f.other.id, accessRole: "member" }); }
      return result;
    };
    assert.equal((await request(f.path, "POST", f.input)).status, 403);
    assert.deepEqual(await f.client.listIdentities(), before);
    assert.deepEqual(await f.store.listWorkspaceAgentConfigs(f.workspace.id), []);
  } finally { await f.close(); }
});

test("shared skill selection and independent-copy APIs enforce owning account and workspace scope", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    const added = await (await request(f.path, "POST", f.input)).json() as CreateWorkspaceAgentFromAccountTemplateResult;
    const configPath = `/local/workspaces/${f.workspace.id}/agents/${added.identity.id}/config`;
    const copyPath = `/local/workspaces/${f.workspace.id}/account-skills/${f.skill.id}/copy`;
    const other = await f.login(f.other.id);
    const member = await f.login(f.member.id);
    assert.equal((await other(copyPath, "POST", { expectedVersion: 1 })).status, 404);
    assert.equal((await member(copyPath, "POST", { expectedVersion: 1 })).status, 403);
    assert.equal((await request(copyPath, "GET")).status, 405);
    assert.equal((await request(copyPath, "POST", { expectedVersion: 99 })).status, 409);
    assert.equal((await request(copyPath, "POST", { expectedVersion: 1, ownerIdentityId: f.other.id })).status, 400);
    assert.deepEqual(await f.store.listAuthoredDocuments(f.workspace.id), []);
    const copiedResponse = await request(copyPath, "POST", { expectedVersion: 1 });
    assert.equal(copiedResponse.status, 201);
    const copied = await copiedResponse.json();
    assert.notEqual(copied.id, f.skill.id);
    assert.equal(copied.content, "ACCOUNT_SKILL_BODY");
    assert.equal(copied.publishedRevision, 1);
    assert.equal((await request(configPath, "PATCH", { accountSkillIds: [], workspaceSkillIds: [copied.id] })).status, 200);
    const config = await (await request(configPath, "GET")).json();
    assert.deepEqual(config.accountSkills, { ownerIdentityId: f.owner.id, skillIds: [] });
    assert.deepEqual(config.workspaceSkillIds, [copied.id]);
    const foreignSkill = await f.configuration.createAccountLibraryItem(f.other.id, { kind: "skill", name: "Foreign", description: "Other account", content: "PRIVATE_FOREIGN_BODY" });
    const wrongWorkspace = await f.configuration.createAuthoredDocument(f.second.id, f.owner.id, { action: "commit", kind: "skill", name: "Wrong workspace", description: "Wrong scope", content: "PRIVATE_WRONG_SCOPE" });
    const channel = await f.configuration.createAuthoredDocument(f.workspace.id, f.owner.id, { action: "commit", kind: "skill", conversationId: f.conversation.id, name: "Channel", description: "Wrong scope", content: "CHANNEL_BODY" });
    const draft = await f.configuration.createAuthoredDocument(f.workspace.id, f.owner.id, { kind: "skill", name: "Draft", content: "UNPUBLISHED_BODY" });
    for (const input of [{ accountSkillIds: [foreignSkill.id] }, { workspaceSkillIds: [wrongWorkspace.id] },
      { workspaceSkillIds: [channel.id] }, { workspaceSkillIds: [draft.id] }, { accountSkillIds: [f.skill.id, f.skill.id] },
      { accountSkillIds: [f.skill.id], accountSkillOwnerIdentityId: f.other.id }]) {
      assert.equal((await request(configPath, "PATCH", input)).status, 400);
    }
    assert.equal((await member(configPath, "PATCH", { accountSkillIds: [f.skill.id] })).status, 403);
    assert.deepEqual(await (await request(configPath, "GET")).json(), config);
    await f.configuration.updateAuthoredDocument(f.workspace.id, copied.id, f.owner.id, { action: "commit", expectedVersion: 1, name: "Local", description: "Customized", content: "LOCAL_ONLY_BODY" });
    assert.equal((await f.configuration.getAccountLibraryItem(f.skill.id, f.owner.id)).kind, "skill");
    assert.equal((await f.store.getAccountLibraryItem(f.owner.id, f.skill.id) as { content: string }).content, "ACCOUNT_SKILL_BODY");
    await f.configuration.updateAccountLibraryItem(f.skill.id, f.owner.id, { action: "archive", expectedVersion: 1 });
    assert.equal((await request(configPath, "PATCH", { accountSkillIds: [f.skill.id] })).status, 400);
    assert.equal((await request(copyPath, "POST", { expectedVersion: 2 })).status, 404);
  } finally { await f.close(); }
});

test("partial cross-store addition is reported as unconfirmed and is never retried automatically", async () => {
  const f = await fixture();
  try {
    const request = await f.login();
    let writes = 0;
    f.store.putAgentConfig = async () => { writes++; throw new Error("injected private storage failure"); };
    const before = await f.client.listIdentities();
    const response = await request(f.path, "POST", f.input);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /may be incomplete; inspect workspace agents/);
    assert.equal(writes, 1);
    assert.equal((await f.client.listIdentities()).length, before.length + 1);
    assert.deepEqual(await f.store.listWorkspaceBindings(f.workspace.id), []);
  } finally { await f.close(); }
});
