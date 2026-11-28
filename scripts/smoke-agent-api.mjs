// Real Channels daemon/HTTP/private SQLite and real Pi Runtime-owned worker/status HTTP.
// Only the final Pi RPC harness is controlled; no installed Pi, model or shared agent is invoked.
// Run after the Channels control build with MINU_RUNTIME_ROOT naming an existing built Runtime.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationClient, createConversationHttpServer } from "../packages/core/dist/src/index.js";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "../packages/relay-storage-drizzle/dist/src/storage.js";
import { createLocalControlDaemon } from "../packages/control/dist/src/daemon.js";

if (!process.env.MINU_RUNTIME_ROOT) throw new Error("Set MINU_RUNTIME_ROOT to the exact prebuilt Runtime checkout; no implicit sibling selection");
const runtimeRoot = resolve(process.env.MINU_RUNTIME_ROOT);
const runtimeModule = join(runtimeRoot, "packages/pi/dist/src/client.js");
const { PiAgentRuntime } = await import(pathToFileURL(runtimeModule).href);
async function compiledIdentity() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(join(runtimeRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  }
  await walk("packages/pi/dist"); await walk("packages/core/dist");
  const hash = createHash("sha256");
  for (const path of files.sort()) hash.update(`${path}\0${createHash("sha256").update(await readFile(join(runtimeRoot, path))).digest("hex")}\n`);
  return { files: files.length, sha256: hash.digest("hex") };
}
const runtimeIdentity = { commit: execFileSync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["-C", runtimeRoot, "status", "--porcelain"], { encoding: "utf8" }).trim()),
  compiled: await compiledIdentity() };
const channelsPin = JSON.parse(await readFile(new URL("../runtime-source.json", import.meta.url), "utf8")).commit;
const directory = await mkdtemp(join(tmpdir(), "channels-agent-api-runtime-"));
const saved = { PI_COMMAND: process.env.PI_COMMAND, MINU_RUNTIME_DIR: process.env.MINU_RUNTIME_DIR };
const actualRuntime = new PiAgentRuntime({ requestTimeoutMs: 1500, startTimeoutMs: 10_000 });
let session, core, daemon, store;
try {
  const harness = join(directory, "controlled-pi.mjs");
  await writeFile(harness, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const file = process.argv[process.argv.indexOf("--session") + 1];
const header = JSON.parse(readFileSync(file, "utf8").split("\\n")[0]);
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n"), request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (request.type === "prompt") process.exit(42);
    const data = request.type === "get_state" ? { sessionId: header.id, sessionFile: file, isStreaming: false }
      : request.type === "get_messages" ? { messages: [{ role: "system", content: "PRIVATE_RUNTIME_TRANSCRIPT", timestamp: 1000 }] } : {};
    console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }));
  }
});
process.on("SIGTERM", () => process.exit(0));
`, { mode: 0o700 });
  process.env.PI_COMMAND = harness;
  process.env.MINU_RUNTIME_DIR = join(directory, "runtime");
  session = await actualRuntime.startManaged({ cwd: directory }, "channels-agent-api-fixture");
  assert.equal(await actualRuntime.status(session.id), "idle");
  core = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const owner = await client.createIdentity({ type: "human" });
  const agent = await client.createIdentity({ type: "agent" });
  const workspace = await client.createWorkspace({ slug: "agent-api-runtime", name: "Runtime fixture" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
  const path = join(directory, "relay.db");
  store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(path) });
  let statusCalls = 0, capabilityCalls = 0;
  daemon = await createLocalControlDaemon({ currentHumanIdentityId: owner.id, conversationsEndpoint: core.endpoint,
    conversationsServiceToken: core.serviceToken, relayDatabasePath: path, webUrl: "http://127.0.0.1:5174", port: 0,
    recordAgentDiagnostics: false, autoResumeOfflineAgents: false,
    runtimes: { pi: { async status(id) { statusCalls++; return actualRuntime.status(id); },
      async sessionCapabilities() { capabilityCalls++; throw new Error("Inspection must not probe capabilities"); } } } });
  const timestamp = new Date().toISOString();
  await store.putAgentConfig({ id: "private-config", workspaceId: workspace.id, agentIdentityId: agent.id,
    status: "active", createdAt: timestamp, updatedAt: timestamp });
  await store.putBinding({ id: "private-binding", workspaceAgentConfigId: "private-config", workspaceId: workspace.id,
    conversationId: conversation.id, agentIdentityId: agent.id, runtimeAdapter: "pi", runtimeSessionId: session.id,
    generation: 1, state: "connected", wakePolicy: "mentions", lastVerifiedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
  const bootstrap = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const created = await fetch(`${daemon.endpoint}/local/workspaces/${workspace.id}/agent-credentials`, { method: "POST",
    headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ requestId: "runtime_fixture_request_0001", name: "Fixture",
      capabilities: ["conversation.inspect"], scope: { mode: "locked", conversationId: conversation.id, includeThreads: false } }) });
  assert.equal(created.status, 201);
  const issued = await created.json();
  const before = { conversation: await client.getConversation(conversation.id), messages: await client.listMessages(conversation.id),
    cursor: await client.getCursor(conversation.id, agent.id), bindings: await store.listConversationBindings(conversation.id),
    transcript: await actualRuntime.messages(session.id), managed: await actualRuntime.listManagedSessions("channels-agent-api-fixture") };
  const response = await fetch(`${daemon.endpoint}/api/agent/v1/conversation/inspect`, { method: "POST",
    headers: { authorization: `Bearer ${issued.secret}`, "content-type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id }) });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  // The fixture worker is live but intentionally not attached to Channels Relay: same UI meaning is disconnected.
  assert.equal(snapshot.participants.find(item => item.identityId === agent.id).runtime.state, "disconnected");
  assert.equal(statusCalls, 1); assert.equal(capabilityCalls, 0);
  const encoded = JSON.stringify(snapshot);
  for (const secret of [issued.secret, session.id, "PRIVATE_RUNTIME_TRANSCRIPT", "private-config", "private-binding", directory])
    assert.ok(!encoded.includes(secret));
  const after = { conversation: await client.getConversation(conversation.id), messages: await client.listMessages(conversation.id),
    cursor: await client.getCursor(conversation.id, agent.id), bindings: await store.listConversationBindings(conversation.id),
    transcript: await actualRuntime.messages(session.id), managed: await actualRuntime.listManagedSessions("channels-agent-api-fixture") };
  assert.deepEqual(after, before, "inspection does not change public/private data, transcript, managed-worker identity or cursor");
  assert.equal(await actualRuntime.status(session.id), "idle");
  console.log(JSON.stringify({ passed: true, node: process.version, channelsCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runtime: runtimeIdentity, channelsRuntimePin: channelsPin, pinMatchesRuntimeHead: channelsPin === runtimeIdentity.commit,
    boundary: "real daemon HTTP + private SQLite + real Pi Runtime client/owned worker/status HTTP; controlled final Pi RPC harness",
    statusCalls, capabilityCalls, unchangedDataAndWorkers: true, installedPiOrModelUsed: false }, null, 2));
} finally {
  await daemon?.close();
  await store?.close();
  await core?.close();
  if (session) await actualRuntime.destroy(session.id, "channels-agent-api-fixture");
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(directory, { recursive: true, force: true });
}
