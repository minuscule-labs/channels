// Real Channels HTTP/gateway, private libSQL storage and Runtime-owned workers.
// Only the final Pi RPC process is controlled: no installed Pi or model is invoked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConversationClient, ConversationService, createConversationHttpServer } from "../packages/core/dist/src/index.js";
import { DrizzleLibSqlConversationStorage } from "../packages/storage-drizzle/dist/src/storage.js";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../packages/relay-storage-drizzle/dist/src/storage.js";
import { createLocalControlDaemon } from "../packages/control/dist/src/daemon.js";
import { createLocalWebServer } from "../packages/control/dist/src/local-web-server.js";

const runtimeRoot = resolve(process.env.MINU_RUNTIME_ROOT ?? fileURLToPath(new URL("../../runtime/", import.meta.url)));
const runtimeModule = resolve(process.env.MINU_RUNTIME_MODULE ?? join(runtimeRoot, "packages/pi/dist/src/client.js"));
const { PiAgentRuntime } = await import(pathToFileURL(runtimeModule).href);
const directory = await mkdtemp(join(tmpdir(), "channels-folder-boundary-"));
const savedEnvironment = { PI_COMMAND: process.env.PI_COMMAND, MINU_RUNTIME_DIR: process.env.MINU_RUNTIME_DIR };
const actualRuntime = new PiAgentRuntime({ requestTimeoutMs: 5_000, controlRequestTimeoutMs: 5_000, startTimeoutMs: 10_000 });
const mutations = new Set(["start", "startManaged", "resume", "suspend", "forceStopManaged", "destroy", "stop", "send", "startTurn", "steer", "interrupt"]);
const calls = [], owned = [];
const runtime = new Proxy(actualRuntime, {
  get(target, method) {
    const value = Reflect.get(target, method, target);
    if (typeof value !== "function") return value;
    if (!mutations.has(method)) return value.bind(target);
    return async (...args) => {
      calls.push(method);
      const result = await value.apply(target, args);
      if (method === "startManaged") owned.push(result);
      return result;
    };
  },
});
let storage, core, client, daemon, web, privateStore, headers;
let workspace, owner, agent, parent, thread;
const coreUrl = `file:${join(directory, "channels.db")}`;
const relayPath = join(directory, "relay.db");
const browserOrigin = "http://127.0.0.1:5174";

async function waitFor(check, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(`Folder integration timed out: ${label}`);
}
async function open() {
  storage = await DrizzleLibSqlConversationStorage.open({ url: coreUrl });
  core = await createConversationHttpServer({ service: new ConversationService(storage), port: 0 });
  client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
}
async function launch() {
  daemon = await createLocalControlDaemon({ relayDatabasePath: relayPath, currentHumanIdentityId: owner.id,
    conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken,
    withConversationMessageAdmission: core.service.withConversationMessageAdmission.bind(core.service),
    webUrl: browserOrigin, port: 0, runtimes: { pi: runtime }, recordAgentDiagnostics: false });
  web = await createLocalWebServer({ conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken,
    controlEndpoint: daemon.endpoint, webDirectory: directory, port: 0, authenticateBrowser: daemon.authenticateBrowser });
  const bootstrap = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  assert.equal(bootstrap.status, 303);
  headers = { cookie: bootstrap.headers.get("set-cookie").split(";", 1)[0], origin: web.endpoint, "content-type": "application/json" };
}
async function request(path, status = 200, method = "GET", body) {
  const response = await fetch(`${web.endpoint}${path}`, { method, headers, signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function control(scope, suffix, status = 200, method = "GET", body) {
  const response = await fetch(`${daemon.endpoint}/local/conversations/${scope}${suffix}`, {
    method, headers: { ...headers, origin: browserOrigin }, signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${suffix}: ${JSON.stringify(result)}`);
  return result;
}
async function bindingIdentity() {
  const records = await privateStore.listWorkspaceBindings(workspace.id);
  assert.equal(records.length, 2);
  return records.map(({ id, workspaceAgentConfigId, workspaceId, conversationId, agentIdentityId,
    runtimeAdapter, runtimeSessionId, runtimeOwnerId, executionEnvironmentId, generation, wakePolicy }) => ({
    id, workspaceAgentConfigId, workspaceId, conversationId, agentIdentityId, runtimeAdapter,
    runtimeSessionId, runtimeOwnerId, executionEnvironmentId, generation, wakePolicy,
  })).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}
async function executionSnapshot() {
  return {
    bindings: await bindingIdentity(),
    workspace: await privateStore.getWorkspaceConfig(workspace.id),
    working: await privateStore.getConversationWorkingFolders(workspace.id, parent.id),
    inherited: (await control(thread.id, "/working-folders")).folders,
    configs: await privateStore.listWorkspaceAgentConfigs(workspace.id),
  };
}
async function publicSnapshot() {
  const scopes = await Promise.all([parent.id, thread.id].map(async id => {
    const { folderId: _folderId, ...metadata } = await client.getConversation(id);
    return { metadata, messages: await client.listMessages(id) };
  }));
  assert.doesNotMatch(JSON.stringify(scopes), /PRIVATE_RUNTIME_ONLY|PRIVATE_AGENT_INSTRUCTIONS|runtimeSessionId|runtimeOwnerId/);
  return { scopes, members: await client.listWorkspaceMembers(workspace.id) };
}
async function nativeSnapshot() {
  return Promise.all(owned.map(async ({ id, ownerId }) => {
    const ownerKey = createHash("sha256").update(ownerId).digest("hex");
    const manifestPath = join(process.env.MINU_RUNTIME_DIR, "managed", ownerKey, `${id}.json`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.cwd, await realpath(join(directory, "workspace", "project")));
    const transcript = await readFile(manifest.sessionFile, "utf8");
    assert.match(transcript, /PRIVATE_RUNTIME_ONLY/);
    return { manifest, transcript };
  }));
}
async function withoutExecutionChange(operation) {
  const beforeCalls = [...calls], beforeExecution = await executionSnapshot(), beforeNative = await nativeSnapshot();
  const result = await operation();
  assert.deepEqual(await executionSnapshot(), beforeExecution);
  assert.deepEqual(await nativeSnapshot(), beforeNative);
  assert.deepEqual(calls, beforeCalls, "Folder/reopen actions must not start, stop, resume, replace or prompt any Runtime session");
  return result;
}
async function assign(folderId, scope = parent.id, status = 200) {
  return withoutExecutionChange(() => request(`/conversations/${scope}/folder`, status, "PATCH", { actorIdentityId: owner.id, folderId }));
}
async function closeProduct() {
  await web?.close(); web = undefined;
  await daemon?.close(); daemon = undefined;
  await core?.close(); core = undefined;
  await storage?.close(); storage = undefined;
  await privateStore?.close(); privateStore = undefined;
}

try {
  const fakePi = join(directory, "controlled-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[process.argv.indexOf("--session") + 1];
const lines = readFileSync(file, "utf8").trim().split("\\n");
const header = JSON.parse(lines[0]);
const messages = lines.slice(1).map(line => JSON.parse(line).message).filter(Boolean);
function persist() {
  const entries = messages.map((message, index) => ({ type: "message", id: String(index + 1), parentId: index ? String(index) : null,
    timestamp: new Date(message.timestamp).toISOString(), message }));
  writeFileSync(file, [header, ...entries].map(entry => JSON.stringify(entry)).join("\\n") + "\\n");
}
if (!messages.length) { messages.push({ role: "system", content: "PRIVATE_RUNTIME_ONLY", timestamp: Date.now() }); persist(); }
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n"), request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const respond = data => console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }));
    if (request.type === "get_state") respond({ sessionId: header.id, sessionFile: file, isStreaming: false });
    else if (request.type === "get_messages") respond({ messages });
    else if (request.type === "prompt") {
      messages.push({ role: "user", content: request.message, timestamp: Date.now() });
      messages.push({ role: "assistant", content: [{ type: "text", text: "PUBLIC_CONTROLLED_REPLY" }], timestamp: Date.now() });
      persist(); respond(undefined); console.log(JSON.stringify({ type: "agent_settled" }));
    } else respond({});
  }
});
process.on("SIGTERM", () => process.exit(0));
`, { mode: 0o700 });
  process.env.PI_COMMAND = fakePi;
  process.env.MINU_RUNTIME_DIR = join(directory, "runtime");
  await mkdir(join(directory, "workspace", "project"), { recursive: true });
  await writeFile(join(directory, "index.html"), "<main>Conversation folder integration fixture</main>");
  await open();
  owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
  workspace = await client.createWorkspace({ slug: "folder-boundary", name: "Folder boundary" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
  parent = await client.createConversation({ workspaceId: workspace.id, actorIdentityId: owner.id, participantIds: [owner.id, agent.id], name: "Related work" });
  const root = await client.postMessage(parent.id, { participantId: owner.id, body: "Public thread root" });
  thread = await client.createThread(parent.id, { actorIdentityId: owner.id, rootMessageId: root.id });
  privateStore = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
  const now = new Date().toISOString();
  await privateStore.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: join(directory, "workspace"), createdAt: now, updatedAt: now });
  await privateStore.putAgentConfig({ id: "folder-agent-config", workspaceId: workspace.id, agentIdentityId: agent.id,
    runtimeAdapter: "pi", personaPrompt: "PRIVATE_AGENT_INSTRUCTIONS", status: "active", createdAt: now, updatedAt: now });
  await privateStore.replaceConversationWorkingFolders(workspace.id, parent.id, [{ workspaceId: workspace.id, conversationId: parent.id,
    relativePath: "project", position: 0, primary: true }]);
  await launch();
  for (const scope of [parent.id, thread.id]) {
    await control(scope, `/agents/${agent.id}/start`, 201, "POST");
    const trigger = await client.postMessage(scope, { participantId: owner.id, body: "@agent Public boundary probe" });
    await waitFor(async () => (await client.listMessages(scope)).at(-1)?.body === "PUBLIC_CONTROLLED_REPLY"
      && await privateStore.getCursor(scope, agent.id) >= trigger.sequence, "public answer and durable delivery cursor");
  }
  assert.equal(owned.length, 2, "Main and thread must own different real managed Runtime sessions");
  assert.notEqual(owned[0].id, owned[1].id);
  const publicBefore = await publicSnapshot(), executionBefore = await executionSnapshot();
  const catalogue = `/workspaces/${workspace.id}/folders`;
  const { folder } = await withoutExecutionChange(() => request(catalogue, 201, "POST", { actorIdentityId: owner.id, name: "Planning" }));
  await assign(folder.id);
  await withoutExecutionChange(() => request(`${catalogue}/${folder.id}`, 200, "PATCH", { actorIdentityId: owner.id, name: "Delivery" }));
  await assign(null);
  await assign(folder.id);
  await assign(folder.id, thread.id, 400);
  assert.deepEqual(await publicSnapshot(), publicBefore, "Folder operations may change only the parent folder metadata");

  await control(parent.id, "/lifecycle", 200, "PATCH", { state: "snoozed", snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
  await assign(null); // Snoozed Conversations can still be organized without waking agents.
  await assign(folder.id);
  await withoutExecutionChange(() => control(parent.id, "/lifecycle", 200, "PATCH", { state: "active" }));
  await control(parent.id, "/lifecycle", 200, "PATCH", { state: "settled" });
  await assign(null, parent.id, 400);
  await withoutExecutionChange(() => control(parent.id, "/lifecycle", 200, "PATCH", { state: "active" }));
  assert.deepEqual(await bindingIdentity(), executionBefore.bindings, "Lifecycle must retain binding/session identity and generation");
  assert.equal((await client.getConversation(parent.id)).folderId, folder.id);
  assert.deepEqual(await publicSnapshot(), publicBefore, "Lifecycle/folder workflows preserve IDs, rosters, messages, sequences and thread context");

  const nativeBeforeReopen = await nativeSnapshot();
  await closeProduct();
  await open();
  privateStore = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
  await launch();
  assert.equal(owned.length, 2, "Reopening the product must not create replacement Runtime sessions");
  assert.deepEqual(await executionSnapshot(), executionBefore);
  assert.deepEqual(await nativeSnapshot(), nativeBeforeReopen);
  assert.deepEqual(await publicSnapshot(), publicBefore);
  assert.equal((await request(`/conversations/${parent.id}`)).conversation.folderId, folder.id);
  assert.equal((await request(catalogue)).folders[0].name, "Delivery");
  await assign(null);
  console.log("Conversation folders boundary smoke passed: signed browser session → authenticated gateway/core → public/private libSQL → real managed Runtime HTTP/owned workers → controlled Pi RPC. File/rename/unfile, Snoozed filing, Archive guard, reopen and database restart preserved scopes, main/thread bindings, native journals, IDs, rosters and transcripts; folder/reopen actions made no Runtime mutation calls.");
} finally {
  await closeProduct();
  for (const session of owned) await actualRuntime.destroy(session.id, session.ownerId);
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
}
