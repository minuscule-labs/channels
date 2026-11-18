import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { createLocalControlDaemon, type LocalControlDaemon } from "../src/daemon.ts";
import type { LocalAgentSessionInspection } from "../src/contracts.ts";

// Real Channels -> managed Runtime worker -> installed pinned artifact. No model/business calls.
test("Channels diagnostics observe the spawned participant worker through the pinned native bridge", { skip: !process.env.PI_INTEGRATIONS_TEST_COMMAND, timeout: 30000 }, async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "channels-integrations-worker-"));
  const agentDir = join(root, "agent"), workspaceRoot = join(root, "workspace"), project = join(workspaceRoot, "project");
  await mkdir(agentDir); await mkdir(project, { recursive: true });
  const requests = join(root, "requests.jsonl"), serverFile = join(root, "server.mjs");
  await writeFile(serverFile, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(requests)},JSON.stringify(r.method)+'\\n');if(r.id===undefined)return;if(r.method==='tools/list'&&process.argv[2]==='fail-discovery'){console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'SECRET_DISCOVERY_ERROR'}}));return;}const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'read_note',description:'Read an authorized fixture note',inputSchema:{type:'object',properties:{}}}]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});\n`);
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    minunotes_fixture: { command: process.execPath, args: [serverFile], env: { TOKEN: "SECRET_FIXTURE" }, exposure: "codemode" },
    mongodb_fixture: { command: join(root, "SECRET_MISSING_SERVER") },
    discovery_fixture: { command: process.execPath, args: [serverFile, "fail-discovery"] },
  } }));
  process.env = { PATH: previous.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, MINU_RUNTIME_DIR: join(root, "runtime"), PI_COMMAND: previous.PI_INTEGRATIONS_TEST_COMMAND };
  const core = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const relayPath = join(root, "relay.db");
  const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
  let daemon: LocalControlDaemon | undefined;
  let started = false;
  let conversationId = "", agentId = "";
  let headers: Record<string, string> = {};
  try {
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const agent = await client.createIdentity({ type: "agent", displayName: "Fixture participant" }); agentId = agent.id;
    const workspace = await client.createWorkspace({ slug: "integration-fixture", name: "Integration fixture" });
    await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "fixture" });
    const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] }); conversationId = conversation.id;
    const now = new Date().toISOString();
    await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: workspaceRoot, createdAt: now, updatedAt: now });
    await store.putAgentConfig({ id: "fixture-config", workspaceId: workspace.id, agentIdentityId: agent.id, runtimeAdapter: "pi", status: "active", createdAt: now, updatedAt: now });
    await store.replaceConversationWorkingFolders(workspace.id, conversation.id, [{ workspaceId: workspace.id, conversationId: conversation.id, relativePath: "project", position: 0, primary: true }]);
    const { PiAgentRuntime } = await import(previous.MINU_RUNTIME_ROOT
      ? pathToFileURL(join(previous.MINU_RUNTIME_ROOT, "packages/pi/dist/src/index.js")).href
      : new URL("../../../../../runtime/packages/pi/dist/src/index.js", import.meta.url).href);
    const runtimes = { pi: new PiAgentRuntime() };
    daemon = await createLocalControlDaemon({ relayDatabasePath: relayPath, currentHumanIdentityId: owner.id,
      conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken, port: 0, webUrl: "http://127.0.0.1:5174/", runtimes });
    const login = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
    headers = { cookie: login.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174", "content-type": "application/json" };
    const base = `${daemon.endpoint}/local/conversations/${conversation.id}/agents/${agent.id}`;
    const start = await fetch(`${base}/start`, { method: "POST", headers });
    assert.equal(start.status, 201, await start.text()); started = true;
    async function inspect(): Promise<LocalAgentSessionInspection> {
      const response = await fetch(`${base}/session-inspection`, { headers }); assert.equal(response.status, 200);
      return response.json() as Promise<LocalAgentSessionInspection>;
    }
    let observed = await inspect();
    const deadline = Date.now() + 10000;
    while (["minunotes_fixture", "mongodb_fixture", "discovery_fixture"].map(name => observed.integrations?.integrations.find(item => item.name === name)?.connection).join("|") !== "connected|failed|failed" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50)); observed = await inspect();
    }
    assert.equal(observed.integrations?.integrations.find(item => item.name === "minunotes_fixture")?.connection, "connected");
    assert.equal(observed.integrations?.integrations.find(item => item.name === "mongodb_fixture")?.connection, "failed");
    assert.equal(observed.integrations?.integrations.find(item => item.name === "mongodb_fixture")?.failureCode, "connection_failed");
    assert.equal(observed.integrations?.integrations.find(item => item.name === "discovery_fixture")?.failureCode, "discovery_failed");
    assert.equal(observed.integrations?.issues.includes("connection_failed"), false);
    assert.ok(observed.integrations?.tools.some(tool => tool.name === "mcp__minunotes_fixture__read_note"));
    assert.doesNotMatch(JSON.stringify(observed), /SECRET|nativeSessionId|endpoint|sourcePath/);
    const before = JSON.stringify(await store.getSessionInspectionRecords(workspace.id, conversation.id, agent.id));
    const requestsBefore = await readFile(requests, "utf8");
    const messagesBefore = await client.listMessages(conversation.id);
    const again = await inspect();
    assert.equal(again.integrations?.workerId, observed.integrations?.workerId);
    assert.equal(await readFile(requests, "utf8"), requestsBefore);
    assert.equal(JSON.stringify(await store.getSessionInspectionRecords(workspace.id, conversation.id, agent.id)), before);
    assert.deepEqual(await client.listMessages(conversation.id), messagesBefore);
  } finally {
    if (started && daemon) await fetch(`${daemon.endpoint}/local/conversations/${conversationId}/agents/${agentId}/stop`, { method: "POST", headers });
    await daemon?.close(); await store.close(); await core.close();
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
