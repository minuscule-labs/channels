import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { createLocalControlDaemon, type LocalControlDaemon } from "../src/daemon.ts";
import { loadLocalRuntimes } from "../src/local-runtimes.ts";
import type { LocalAgentSessionInspection } from "../src/contracts.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Explicit owner-authorized inference acceptance. Preserve the spawning worker's model/auth;
// isolate only tools, MCP configuration, Runtime state and Conversation data. Never copy credentials.
test("real spawned Channels model selects working notes when wrapper is broken without a transport hint", {
  skip: process.env.PI_INTEGRATIONS_MODEL_ACCEPTANCE !== "1", timeout: 180000,
}, async () => {
  const previous = { ...process.env };
  const provider = previous.PI_PROVIDER, model = previous.PI_MODEL;
  const pinned = previous.PI_INTEGRATIONS_TEST_COMMAND;
  assert.ok(provider && model, "The spawning worker must supply its actual PI_PROVIDER and PI_MODEL");
  assert.ok(pinned, "An explicit pinned artifact launcher is required");
  const root = await mkdtemp(join(tmpdir(), "channels-integrations-selection-"));
  const workspaceRoot = join(root, "workspace"), project = join(workspaceRoot, "project");
  await mkdir(project, { recursive: true });
  const packageRoot = join(dirname(pinned), "node_modules/@earendil-works/pi-coding-agent");
  const rpcEntry = join(packageRoot, "dist/bundle/rpc-entry.js");
  const audit = join(root, "fixture-audit.jsonl"), serverFile = join(root, "notes-server.mjs");
  const note = { id: "note_fixture", title: "Disposable Runtime Integration Fixture", content: "A configured integration may be disconnected. A broken convenience wrapper does not invalidate a healthy notes connection." };
  await writeFile(serverFile, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'notes-fixture',version:'1'}};
else if(r.method==='tools/list')result={tools:[{name:'notes_get_note',description:'Read an authorized MinuNotes note by its noteId.',inputSchema:{type:'object',properties:{noteId:{type:'string'}},required:['noteId']},annotations:{readOnlyHint:true,destructiveHint:false}}]};
else if(r.method==='tools/call'){appendFileSync(${JSON.stringify(audit)},JSON.stringify({kind:'notes_read',name:r.params.name,noteId:r.params.arguments?.noteId})+'\\n');result=r.params.name==='notes_get_note'&&r.params.arguments?.noteId==='note_fixture'?{content:[{type:'text',text:JSON.stringify({note:${JSON.stringify(note)}})}]}:{isError:true,content:[{type:'text',text:'Fixture note not found'}]};}
else result={};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});\n`);
  const extension = join(root, "fixture-tools.mjs");
  await writeFile(extension, `import {appendFileSync} from 'node:fs';
import {createMcpExtension} from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/index.js")).href)};
export default function(pi){
createMcpExtension({logPath:${JSON.stringify(join(root, "fixture-mcp.log"))},loadConfig:()=>({errors:[],servers:[
{name:'minunotes',scope:'extension',source:'fixture',config:{command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(serverFile)}],exposure:'codemode',description:'Read authorized MinuNotes notes'}},
{name:'mongodb',scope:'extension',source:'fixture',config:{command:${JSON.stringify(join(root, "unavailable-mongodb-fixture"))}}}]})})(pi);
pi.registerTool({name:'minunotes_read_note',label:'Read MinuNotes note',description:'Read a MinuNotes note, including metadata and contentHash for safe edits.',parameters:{type:'object',properties:{noteId:{type:'string'}},required:['noteId']},annotations:{readOnlyHint:true,destructiveHint:false},execute:async()=>{appendFileSync(${JSON.stringify(audit)},JSON.stringify({kind:'wrapper_failed',reason:'MINUNOTES_API_URL is not set'})+'\\n');throw new Error('MINUNOTES_API_URL is not set');}});
pi.on('tool_call',event=>{appendFileSync(${JSON.stringify(audit)},JSON.stringify({kind:'tool_call',name:event.toolName})+'\\n');});
}\n`);
  execFileSync(process.execPath, ["--check", serverFile], { stdio: "pipe" });
  execFileSync(process.execPath, ["--check", extension], { stdio: "pipe" });
  const launcher = join(root, "fixture-pi");
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(rpcEntry)} --offline --no-extensions --no-skills --no-context-files --no-prompt-templates -e builtin:codemode -e builtin:integration-observation -e ${quote(extension)} --tools inspect_integrations,minunotes_read_note,codemode "$@"\n`, { mode: 0o700 });
  // Keep HOME, PI_CODING_AGENT_DIR and all provider authentication exactly as inherited.
  process.env = { ...previous, MINU_RUNTIME_DIR: join(root, "runtime"), PI_COMMAND: launcher };
  const core = await createConversationHttpServer({ port: 0 });
  const client = new ConversationClient(core.endpoint, { serviceToken: core.serviceToken });
  const relayPath = join(root, "relay.db");
  const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayPath) });
  let daemon: LocalControlDaemon | undefined;
  let started = false, conversationId = "", agentId = "";
  let headers: Record<string, string> = {};
  try {
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const agent = await client.createIdentity({ type: "agent", displayName: "Acceptance participant" }); agentId = agent.id;
    const workspace = await client.createWorkspace({ slug: "selection-fixture", name: "Selection fixture" });
    await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "fixture" });
    const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] }); conversationId = conversation.id;
    const now = new Date().toISOString();
    await store.putWorkspaceConfig({ workspaceId: workspace.id, rootUri: workspaceRoot, createdAt: now, updatedAt: now });
    await store.putAgentConfig({ id: "selection-config", workspaceId: workspace.id, agentIdentityId: agent.id, runtimeAdapter: "pi", modelProvider: provider, modelId: model, status: "active", createdAt: now, updatedAt: now });
    await store.replaceConversationWorkingFolders(workspace.id, conversation.id, [{ workspaceId: workspace.id, conversationId: conversation.id, relativePath: "project", position: 0, primary: true }]);
    const runtimes = await loadLocalRuntimes();
    daemon = await createLocalControlDaemon({ relayDatabasePath: relayPath, currentHumanIdentityId: owner.id,
      conversationsEndpoint: core.endpoint, conversationsServiceToken: core.serviceToken, port: 0, webUrl: "http://127.0.0.1:5174/", runtimes });
    const login = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
    headers = { cookie: login.headers.get("set-cookie")!.split(";", 1)[0]!, origin: "http://127.0.0.1:5174", "content-type": "application/json" };
    const base = `${daemon.endpoint}/local/conversations/${conversation.id}/agents/${agent.id}`;
    const start = await fetch(`${base}/start`, { method: "POST", headers });
    assert.equal(start.status, 201, await start.text()); started = true;
    const inspected = await fetch(`${base}/session-inspection`, { headers }); assert.equal(inspected.status, 200);
    const observations = await inspected.json() as LocalAgentSessionInspection;
    assert.equal(observations.running.status, "available");
    if (observations.running.status !== "available") throw new Error("Actual worker model is not verified");
    assert.deepEqual(observations.running.profile.model, { status: "verified", provider, id: model });
    assert.deepEqual(observations.integrations?.integrations.map(item => item.name).sort(), ["minunotes", "mongodb"]);
    const task = "Read MinuNotes note note_fixture and give its title and a one-sentence summary. Also check whether the note wrapper and MongoDB are usable in this session. Distinguish configuration from connection/registration, and do not change any setup. Return JSON only with fields: note {title, summary}, wrapper {usable, reason}, mongodb {configured, usable, reason}, and routeUsed.";
    assert.doesNotMatch(task, /MCP|codemode|searchTools/i, "The user task must not hint at a transport or discovery tool");
    await client.postMessage(conversation.id, { participantId: owner.id, body: `@fixture ${task}` });
    let answer = "";
    const deadline = Date.now() + 120000;
    while (!answer && Date.now() < deadline) {
      const messages = await client.listMessages(conversation.id);
      answer = messages.filter(message => message.participantId === agent.id).at(-1)?.body ?? "";
      if (!answer) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(answer, "No participant reply within the acceptance deadline");
    const cleaned = answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let result: { note: { title: string; summary: string }; wrapper: { usable: boolean; reason: string }; mongodb: { configured: boolean; usable: boolean; reason: string }; routeUsed: string };
    try { result = JSON.parse(cleaned); } catch { throw new Error(`Participant did not return the requested JSON: ${answer.slice(0, 2000)}`); }
    assert.equal(result.note.title, note.title);
    assert.ok(result.note.summary.length > 0);
    assert.equal(result.wrapper.usable, false);
    assert.match(result.wrapper.reason, /MINUNOTES_API_URL/);
    assert.equal(result.mongodb.configured, true);
    assert.equal(result.mongodb.usable, false);
    const records = (await readFile(audit, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { kind: string; name?: string; noteId?: string });
    assert.ok(records.some(record => record.kind === "wrapper_failed"));
    assert.ok(records.some(record => record.kind === "notes_read" && record.name === "notes_get_note" && record.noteId === "note_fixture"));
    assert.ok(records.some(record => record.kind === "tool_call" && record.name === "inspect_integrations"));
    assert.doesNotMatch(answer, /access_token|refresh_token|auth\.json|sessionId|endpoint/i);
    console.log(JSON.stringify({ acceptance: "real-model-selection", provider, model, result,
      toolCalls: records.filter(record => record.kind === "tool_call").map(record => record.name) }));
  } finally {
    if (started && daemon) await fetch(`${daemon.endpoint}/local/conversations/${conversationId}/agents/${agentId}/stop`, { method: "POST", headers });
    await daemon?.close(); await store.close(); await core.close();
    process.env = previous;
    if (previous.PI_INTEGRATIONS_KEEP_FIXTURE === "1") console.log(JSON.stringify({ fixturePath: root }));
    else await rm(root, { recursive: true, force: true });
  }
});
