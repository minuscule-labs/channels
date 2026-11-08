import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ConversationClient, createConversationHttpServer, createResourceId } from "@minu/channels-core";
import { conversationAgentConfiguration, InMemoryRelayBindingStore } from "@minu/channels-relay";
import { LocalAgentHost, type ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { LocalAgentHostConfiguration, LocalConfigurationRequestError } from "../src/configuration.ts";
import { LocalAgentSessionInspections } from "../src/agent-session-inspection.ts";
import { LocalControlBrowserSessions, LocalControlService, createLocalControlHttpServer } from "../src/server.ts";

async function fixture(t: test.TestContext) {
  const core = await createConversationHttpServer({ port: 0 });
  t.after(() => core.close());
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const member = await client.createIdentity({ type: "human", displayName: "Member" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
  const workspace = await client.createWorkspace({ slug: "presets", name: "Presets" });
  for (const [identity, mentionHandle, accessRole] of [[owner, "owner", "owner"], [member, "member", "member"], [agent, "builder", "member"]] as const) {
    await client.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle, accessRole });
  }
  const store = new InMemoryRelayBindingStore();
  const starts: ManagedRuntimeStartConfig[] = [];
  const runtime = {
    async capabilities() { return { models: [...["saved", "preset"].map((id) => ({ provider: "test", id, name: id, reasoning: true })),
      { provider: "test", id: "plain", name: "Plain", reasoning: false }],
      reasoningLevels: ["off", "low", "high"] as Array<"off" | "low" | "high">, skills: [] }; },
    async start(config: ManagedRuntimeStartConfig) {
      if (config.model?.id === "plain" && config.reasoningLevel && config.reasoningLevel !== "off") {
        throw new Error("Reasoning is unavailable for the selected model");
      }
      starts.push(config); return { id: `session-${starts.length}` };
    },
    async status() { return "idle" as const; }, async send() {}, async messages() { return []; }, async stop() {},
  };
  const now = new Date().toISOString();
  await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: pathToFileURL(tmpdir()).href, createdAt: now, updatedAt: now });
  await store.putAgentConfig({ id: "config", workspaceId: workspace.id, agentIdentityId: agent.id, personaPrompt: "Workspace instructions",
    runtimeAdapter: "test", modelProvider: "test", modelId: "saved", reasoningLevel: "low", status: "active", createdAt: now, updatedAt: now });
  const config = new LocalAgentHostConfiguration({ client, store, runtimes: { test: runtime } });
  const input = { id: createResourceId("conversation"), name: "調査".repeat(30), participants: [{ identityId: agent.id, role: "Investigator" }],
    model: { provider: "test", id: "preset" }, reasoningLevel: "high" as const, guidance: "Check in after diagnosis." };
  return { client, owner, member, agent, workspace, store, starts, runtime, config, input };
}

test("preset administration and creation enforce membership, validate roles and defaults, and retry a lost response without duplicates", async (t) => {
  const f = await fixture(t);
  const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: f.owner.id });
  const control = await createLocalControlHttpServer({ port: 0, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin],
    service: new LocalControlService({ conversations: f.client, bindings: f.store, runtimes: {}, configuration: f.config }) });
  t.after(() => control.close());
  const bootstrap = await fetch(sessions.issueLaunchUrl(control.endpoint), { redirect: "manual" });
  const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!, origin: sessions.browserOrigin, "content-type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown, customHeaders = headers) => fetch(`${control.endpoint}${path}`,
    { method, headers: customHeaders, ...(body ? { body: JSON.stringify(body) } : {}) });
  const path = `/local/workspaces/${f.workspace.id}/conversation-presets`;
  const id = `preset_${"a".repeat(32)}`;
  const presetInput = { name: "Debug", participants: f.input.participants, model: f.input.model, reasoningLevel: f.input.reasoningLevel, guidance: f.input.guidance, expectedRevision: null };
  assert.equal((await request(path, "GET", undefined, { ...headers, cookie: "" })).status, 401);
  assert.equal((await request(`${path}/${id}`, "PUT", presetInput, { ...headers, origin: "https://foreign.example" })).status, 403);
  await assert.rejects(f.config.listConversationPresets(f.workspace.id, f.member.id), { status: 403 });
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.member.id, f.input), { status: 403 });
  const saved = await request(`${path}/${id}`, "PUT", presetInput);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  const retried = await request(`${path}/${id}`, "PUT", presetInput);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).revision, 1);
  assert.equal((await request(`${path}/${id}`, "PUT", { ...presetInput, guidance: "Changed retry" })).status, 409);
  const list = await (await request(path)).json();
  assert.equal(list.presets[0].name, "Debug");
  const before = (await f.client.listWorkspaceConversations(f.workspace.id)).length;
  for (const invalid of [
    { participants: [{ role: "Unassigned" }] }, { participants: [f.input.participants[0], f.input.participants[0]] },
    { participants: [{ identityId: f.member.id, role: "Human" }] },
    { participants: [{ identityId: createResourceId("identity"), role: "Missing" }] },
    { model: { provider: "test", id: "missing" } }, { reasoningLevel: "max" }, { guidance: "x".repeat(16 * 1024 + 1) },
    { name: "x".repeat(101) }, { reasoningLevel: ["high"] },
    { actorIdentityId: f.member.id },
  ]) await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, { ...f.input, ...invalid }), LocalConfigurationRequestError);
  assert.equal((await f.client.listWorkspaceConversations(f.workspace.id)).length, before);
  const create = f.client.createConversation.bind(f.client);
  f.client.createConversation = async (input) => { await create(input); throw new Error("Lost response"); };
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, f.input), /Lost response/);
  f.client.createConversation = create;
  const created = await request(`/local/workspaces/${f.workspace.id}/conversations`, "POST", f.input);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).conversation.id, f.input.id);
  assert.equal((await f.client.listWorkspaceConversations(f.workspace.id)).length, before + 1);
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, { ...f.input, name: "Changed retry" }), { status: 409 });
  assert.equal((await request(`${path}/${id}`, "PUT", { ...presetInput, expectedRevision: 1, guidance: "New guidance" })).status, 200);
  assert.equal((await request(`${path}/${id}`, "DELETE", { expectedRevision: 1 })).status, 409);
  assert.equal((await request(`${path}/${id}`, "DELETE", { expectedRevision: 2 })).status, 200);
  const setup = await (await request(`/local/conversations/${f.input.id}/creation-setup`)).json();
  assert.equal(setup.setup.guidance, f.input.guidance);
  const publicConversation = await f.client.getConversation(f.input.id);
  assert.doesNotMatch(JSON.stringify(publicConversation), /preset|Check in after diagnosis/);
});

test("preset creation files atomically and preserves its reviewed setup across a lost-response retry", async (t) => {
  const f = await fixture(t);
  const folder = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: "Delivery" });
  const other = await f.client.createWorkspaceFolder(f.workspace.id, { actorIdentityId: f.owner.id, name: "Other" });
  const input = { ...f.input, folderId: folder.id };
  const create = f.client.createConversation.bind(f.client);
  f.client.createConversation = async (value) => { await create(value); throw new Error("Lost filed response"); };
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input), /Lost filed response/);
  f.client.createConversation = create;
  const created = await f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input);
  assert.equal(created.id, input.id);
  assert.equal(created.folderId, folder.id);
  assert.equal((await f.client.listWorkspaceConversations(f.workspace.id)).length, 1);
  const setup = await f.store.getConversationCreationSetup(f.workspace.id, input.id);
  assert.equal(setup?.guidance, f.input.guidance);
  assert.deepEqual(setup?.participants, f.input.participants);
  assert.ok(!("folderId" in setup!), "Filing is public navigation metadata, not private agent setup");
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, { ...input, folderId: other.id }), { status: 409 });
  assert.equal((await f.client.getConversation(input.id)).folderId, folder.id);
  assert.deepEqual(await f.store.getConversationCreationSetup(f.workspace.id, input.id), setup);
  assert.equal(f.starts.length, 0);
});

test("preset creation rejects malformed, missing and foreign folders before saving public or private data", async (t) => {
  const f = await fixture(t);
  const other = await f.client.createWorkspace({ slug: "other-preset-folder", name: "Other" });
  await f.client.addWorkspaceMember(other.id, { identityId: f.owner.id, mentionHandle: "owner", accessRole: "owner" });
  const foreign = await f.client.createWorkspaceFolder(other.id, { actorIdentityId: f.owner.id, name: "Foreign" });
  for (const [folderId, status] of [["bad", 400], [42, 400], [createResourceId("folder"), 404], [foreign.id, 404]] as const) {
    const input = { ...f.input, id: createResourceId("conversation"), folderId };
    await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input), { status });
    assert.equal(await f.store.getConversationCreationSetup(f.workspace.id, input.id), undefined);
    await assert.rejects(f.client.getConversation(input.id), { status: 404 });
  }
  assert.equal((await f.client.listWorkspaceConversations(f.workspace.id)).length, 0);
  assert.equal(f.starts.length, 0);
});

test("preset saves recover exact create and update retries while preserving intervening edits", async (t) => {
  const f = await fixture(t);
  const id = `preset_${"c".repeat(32)}`;
  const input = { name: "Retry", participants: f.input.participants, guidance: "First", expectedRevision: null };
  const save = (value: unknown) => f.config.saveConversationPreset(f.workspace.id, id, f.owner.id, value);
  const [created, duplicate] = await Promise.all([save(input), save(input)]);
  assert.equal(created.revision, 1);
  assert.deepEqual(duplicate, created);
  assert.equal((await f.store.listConversationPresets(f.workspace.id)).length, 1);
  const update = { ...input, guidance: "Second", expectedRevision: 1 };
  const updated = await save(update);
  assert.equal(updated.revision, 2);
  assert.deepEqual(await save(update), updated, "A lost update response does not advance the revision again");
  await assert.rejects(save({ ...update, guidance: "Different stale edit" }), { status: 409 });
  await assert.rejects(save(input), { status: 409 });
  await save({ ...update, guidance: "Third", expectedRevision: 2 });
  await assert.rejects(save(update), { status: 409 }, "An intervening edit cannot be acknowledged as an exact retry");
  assert.equal((await f.store.listConversationPresets(f.workspace.id))[0]!.guidance, "Third");
  await assert.rejects(f.config.saveConversationPreset(f.workspace.id, id, f.member.id, update), { status: 403 });
});

test("creation rejects incompatible explicit and inherited model/effort pairs before saving its snapshot", async (t) => {
  const f = await fixture(t);
  const original = (await f.store.getWorkspaceAgentConfig(f.workspace.id, f.agent.id))!;
  const plain = { provider: "test", id: "plain" };
  const create = (defaults: { model?: typeof plain; reasoningLevel?: "off" | "high" }) => {
    const input = { id: createResourceId("conversation"), name: "Model compatibility", participants: f.input.participants, ...defaults };
    return { input, result: f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input) };
  };
  const before = (await f.client.listWorkspaceConversations(f.workspace.id)).length;
  for (const defaults of [{ model: plain, reasoningLevel: "high" as const }, { model: plain }]) {
    const { input, result } = create(defaults);
    await assert.rejects(result, /choose off/);
    assert.equal(await f.store.getConversationCreationSetup(f.workspace.id, input.id), undefined);
  }
  await f.store.putAgentConfig({ ...original, modelId: "plain", reasoningLevel: "off" });
  const inheritedModel = create({ reasoningLevel: "high" });
  await assert.rejects(inheritedModel.result, /choose off/);
  assert.equal(await f.store.getConversationCreationSetup(f.workspace.id, inheritedModel.input.id), undefined);
  // A harness default model also participates when the agent has no saved model.
  await f.store.putAgentConfig({ ...original, modelProvider: undefined, modelId: undefined });
  const capabilities = f.runtime.capabilities;
  f.runtime.capabilities = async () => ({ ...await capabilities(), defaultModel: plain });
  const freshConfiguration = new LocalAgentHostConfiguration({ client: f.client, store: f.store, runtimes: { test: f.runtime } });
  const defaultModelInput = { id: createResourceId("conversation"), name: "Default model", participants: f.input.participants, reasoningLevel: "high" };
  await assert.rejects(freshConfiguration.createConversationWithSetup(f.workspace.id, f.owner.id, defaultModelInput), /choose off/);
  assert.equal(await f.store.getConversationCreationSetup(f.workspace.id, defaultModelInput.id), undefined);
  assert.equal((await f.client.listWorkspaceConversations(f.workspace.id)).length, before);
  await f.store.putAgentConfig(original);
  const valid = await create({ model: plain, reasoningLevel: "off" }).result;
  const host = new LocalAgentHost({ client: f.client, store: f.store, runtimes: { test: f.runtime } });
  t.after(() => host.close());
  await host.startConversationAgent(valid.id, f.agent.id, f.owner.id);
  assert.deepEqual(f.starts[0]!.model, plain);
  assert.equal(f.starts[0]!.reasoningLevel, "off");
  assert.deepEqual(await f.store.getWorkspaceAgentConfig(f.workspace.id, f.agent.id), original);
});

test("Conversation launch defaults and roles reach initial and fresh replacement sessions in main and threads without changing other Conversations", async (t) => {
  const f = await fixture(t);
  const created = await f.config.createConversationWithSetup(f.workspace.id, f.owner.id, f.input);
  const root = await f.client.postMessage(created.id, { participantId: f.owner.id, body: "Investigate this in a thread." });
  const thread = await f.client.createThread(created.id, { actorIdentityId: f.owner.id, rootMessageId: root.id });
  const other = await f.client.createConversation({ workspaceId: f.workspace.id, participantIds: [f.owner.id, f.agent.id] });
  const host = new LocalAgentHost({ client: f.client, store: f.store, runtimes: { test: f.runtime } });
  t.after(() => host.close());
  await host.startConversationAgent(created.id, f.agent.id, f.owner.id);
  await host.replaceConversationAgent(created.id, f.agent.id, f.owner.id, "fresh");
  await host.startConversationAgent(thread.id, f.agent.id, f.owner.id);
  await host.replaceConversationAgent(thread.id, f.agent.id, f.owner.id, "fresh");
  await host.startConversationAgent(other.id, f.agent.id, f.owner.id);
  assert.equal(f.starts.length, 5);
  for (const start of f.starts.slice(0, 4)) {
    assert.deepEqual(start.model, f.input.model); assert.equal(start.reasoningLevel, "high");
    assert.match(start.appendSystemPrompt!, /Workspace instructions/);
    assert.match(start.appendSystemPrompt!, /Your role in this Conversation: Investigator/);
    assert.match(start.appendSystemPrompt!, /Check in after diagnosis/);
  }
  assert.deepEqual(f.starts[4]!.model, { provider: "test", id: "saved" });
  assert.equal(f.starts[4]!.reasoningLevel, "low");
  assert.doesNotMatch(f.starts[4]!.appendSystemPrompt!, /Investigator|diagnosis/);
  assert.equal((await f.store.getWorkspaceAgentConfig(f.workspace.id, f.agent.id))!.modelId, "saved");
  const inspection = new LocalAgentSessionInspections({ client: f.client, store: f.store, runtimes: {} });
  for (const scope of [created.id, thread.id]) {
    const read = await inspection.read(scope, f.agent.id, f.owner.id);
    assert.equal(read.saved.status, "available");
    if (read.saved.status === "available") assert.deepEqual(read.saved.profile.model, f.input.model);
  }
  await f.store.putWorkspaceConfig({ ...(await f.store.getWorkspaceConfig(f.workspace.id))!, runtimeModelPolicies: { test: [{ provider: "test", id: "saved" }] } });
  for (const scope of [created.id, thread.id]) {
    await assert.rejects(host.replaceConversationAgent(scope, f.agent.id, f.owner.id, "fresh"), /disabled/);
  }
  assert.equal(f.starts.length, 5);
  await f.config.updateConversationSettings(created.id, f.owner.id, { expectedRevision: 0,
    participants: f.input.participants, guidance: "Updated Conversation guidance", turnTimeoutMs: 60_000 });
  const inherited = await f.config.getConversationSettings(thread.id, f.owner.id);
  assert.equal(inherited.settings.conversationId, created.id);
  assert.equal(inherited.settings.guidance, "Updated Conversation guidance");
  await assert.rejects(f.config.updateConversationSettings(thread.id, f.owner.id, { ...inherited.settings, expectedRevision: 1 }), { status: 409 });
  for (const scope of [created.id, thread.id]) await host.replaceConversationAgent(scope, f.agent.id, f.owner.id, "fresh");
  assert.equal(f.starts.length, 7);
  for (const start of f.starts.slice(5)) {
    assert.deepEqual(start.model, { provider: "test", id: "saved" });
    assert.match(start.appendSystemPrompt!, /Updated Conversation guidance/);
    assert.doesNotMatch(start.appendSystemPrompt!, /Check in after diagnosis/);
  }
  assert.equal((await f.store.getConversationCreationSetup(f.workspace.id, created.id))?.guidance, f.input.guidance);
});


test("creation validates and prepares its folder before publication and preserves it on retries", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "channels-create-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  await symlink(tmpdir(), join(root, "outside"));
  await f.config.updateWorkspaceConfiguration(f.workspace.id, f.owner.id, { rootUri: root });
  for (const workingFolder of [{ relativePath: "../" }, { path: tmpdir() }, { relativePath: "outside" }, { relativePath: "missing" }]) {
    await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, { ...f.input, workingFolder }), LocalConfigurationRequestError);
    assert.equal(await f.store.getConversationCreationSetup(f.workspace.id, f.input.id), undefined);
  }
  const create = f.client.createConversation.bind(f.client);
  f.client.createConversation = async (input) => {
    assert.deepEqual((await f.store.getConversationWorkingFolders(f.workspace.id, f.input.id)).map(({ relativePath, primary }) => ({ relativePath, primary })), [{ relativePath: "project", primary: true }]);
    await create(input); throw new Error("Lost folder response");
  };
  const input = { ...f.input, workingFolder: { relativePath: "project" } };
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input), /Lost folder response/);
  f.client.createConversation = create;
  assert.equal((await f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input)).id, f.input.id);
  await f.config.updateConversationWorkingFolders(f.input.id, f.owner.id, { folders: [] });
  await f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input);
  assert.deepEqual(await f.store.getConversationWorkingFolders(f.workspace.id, f.input.id), []);
  await rm(join(root, "project"), { recursive: true });
  assert.equal((await f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input)).id, f.input.id, "recover exact retries even after a folder is removed");
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, { ...input, workingFolder: { relativePath: "." } }), { status: 409 });
  await mkdir(join(root, "unpublished"));
  const unfinished = { ...f.input, id: createResourceId("conversation"), workingFolder: { relativePath: "unpublished" } };
  f.client.createConversation = async () => { throw new Error("Before publication"); };
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, unfinished), /Before publication/);
  f.client.createConversation = create;
  await rm(join(root, "unpublished"), { recursive: true });
  await assert.rejects(f.config.createConversationWithSetup(f.workspace.id, f.owner.id, unfinished), { status: 409 });
  await assert.rejects(f.client.getConversation(unfinished.id), { status: 404 });
});

test("editable settings use scoped revisions, validate defaults, and leave creation snapshots immutable", async (t) => {
  const f = await fixture(t);
  await f.config.createConversationWithSetup(f.workspace.id, f.owner.id, f.input);
  const original = await f.store.getConversationCreationSetup(f.workspace.id, f.input.id);
  const settings = await f.config.getConversationSettings(f.input.id, f.owner.id);
  assert.equal(settings.settings.revision, 0);
  const update = { participants: f.input.participants, guidance: "New instructions", turnTimeoutMs: 5 * 60_000, idleSleepTimeoutMs: null, expectedRevision: 0 };
  await assert.rejects(f.config.getConversationSettings(f.input.id, f.member.id), { status: 403 });
  await assert.rejects(f.config.updateConversationSettings(f.input.id, f.member.id, update), { status: 403 });
  for (const invalid of [{ turnTimeoutMs: 0 }, { idleSleepTimeoutMs: 1 }, { model: { provider: "test", id: "missing" } }, { participants: [], model: { provider: "test", id: "plain" }, reasoningLevel: "high" }]) {
    await assert.rejects(f.config.updateConversationSettings(f.input.id, f.owner.id, { ...update, ...invalid }), LocalConfigurationRequestError);
  }
  const saved = await f.config.updateConversationSettings(f.input.id, f.owner.id, update);
  assert.equal(saved.settings.revision, 1);
  assert.deepEqual(await f.config.updateConversationSettings(f.input.id, f.owner.id, update), saved);
  await assert.rejects(f.config.updateConversationSettings(f.input.id, f.owner.id, { ...update, guidance: "Stale" }), { status: 409 });
  const effective = await conversationAgentConfiguration(f.store, f.workspace.id, f.input.id, f.agent.id);
  assert.equal(effective?.modelId, "saved");
  assert.match(effective!.personaPrompt!, /New instructions/);
  assert.doesNotMatch(effective!.personaPrompt!, /Check in after diagnosis/);
  assert.deepEqual(await f.store.getConversationCreationSetup(f.workspace.id, f.input.id), original);
  await f.client.updateWorkspaceMember(f.workspace.id, f.agent.id, { actorIdentityId: f.owner.id, status: "disabled" });
  assert.deepEqual(await f.config.updateConversationSettings(f.input.id, f.owner.id, update), saved, "exact settings retries survive subsequent membership changes");
  await f.config.updateWorkspaceConfiguration(f.workspace.id, f.owner.id, { turnTimeoutMs: 10 * 60_000 });
  assert.equal((await f.config.getWorkspaceConfiguration(f.workspace.id, f.owner.id)).turnTimeoutMs, 10 * 60_000);
  await f.config.updateWorkspaceConfiguration(f.workspace.id, f.owner.id, { turnTimeoutMs: null });
  assert.equal((await f.config.getWorkspaceConfiguration(f.workspace.id, f.owner.id)).turnTimeoutMs, undefined);
});

test("overlapping creation retries preserve folder edits made after publication", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "channels-create-overlap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([mkdir(join(root, "initial")), mkdir(join(root, "edited"))]);
  await f.config.updateWorkspaceConfiguration(f.workspace.id, f.owner.id, { rootUri: root });
  const input = { ...f.input, workingFolder: { relativePath: "initial" } };
  let releaseFirst!: () => void, releaseRetry!: () => void, publicationEntered!: () => void, retryEntered!: () => void;
  const publication = new Promise<void>((resolve) => { publicationEntered = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const retryPreparation = new Promise<void>((resolve) => { retryEntered = resolve; });
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const create = f.client.createConversation.bind(f.client);
  let publications = 0;
  f.client.createConversation = async (value) => {
    if (++publications === 1) { publicationEntered(); await firstGate; }
    return create(value);
  };
  const put = f.store.putConversationCreationSetup.bind(f.store);
  let preparations = 0;
  f.store.putConversationCreationSetup = async (value) => {
    if (++preparations === 2) { retryEntered(); await retryGate; }
    return put(value);
  };
  const first = f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input);
  await publication;
  const retry = f.config.createConversationWithSetup(f.workspace.id, f.owner.id, input);
  try {
    // An implementation that serializes the retry can keep it queued until the
    // first publication finishes. Otherwise hold its preparation across the edit.
    await Promise.race([retryPreparation, new Promise((resolve) => setTimeout(resolve, 100))]);
    releaseFirst(); await first;
    await f.config.updateConversationWorkingFolders(f.input.id, f.owner.id, { folders: [{ relativePath: "edited", primary: true }] });
    releaseRetry(); await retry;
    assert.deepEqual((await f.store.getConversationWorkingFolders(f.workspace.id, f.input.id)).map(({ relativePath }) => relativePath), ["edited"]);
  } finally {
    releaseFirst(); releaseRetry();
    await Promise.allSettled([first, retry]);
  }
});

test("settings reads keep fields and revision coherent during the first concurrent edit", async (t) => {
  const f = await fixture(t);
  await f.config.createConversationWithSetup(f.workspace.id, f.owner.id, f.input);
  const get = f.store.getConversationSettings.bind(f.store);
  let injected = false;
  f.store.getConversationSettings = async (workspaceId, conversationId) => {
    const result = await get(workspaceId, conversationId);
    if (!injected && !result) {
      injected = true;
      await f.store.putConversationSettings({ workspaceId, conversationId, revision: 1, participants: f.input.participants, guidance: "Concurrent guidance" }, 0);
    }
    return result;
  };
  const before = (await f.config.getConversationSettings(f.input.id, f.owner.id)).settings;
  assert.deepEqual([before.guidance, before.revision], [f.input.guidance, 0]);
  const after = (await f.config.getConversationSettings(f.input.id, f.owner.id)).settings;
  assert.deepEqual([after.guidance, after.revision], ["Concurrent guidance", 1]);
});
