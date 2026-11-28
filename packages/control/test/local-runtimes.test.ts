import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalRuntimes, LOCAL_AGENT_ACCESS, LOCAL_AGENT_ACCESS_OPTIONS } from "../src/local-runtimes.ts";
import { createLocalProductApp } from "../src/local.ts";
import { ConversationClient } from "@minu/channels-core";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";

const methods = "start(){} send(){} messages(){} status(){} startManaged(){} listManagedSessions(){} resume(){} suspend(){} destroy(){}";
const moduleOf = (name: string) => `data:text/javascript,${encodeURIComponent(`export class ${name} { ${methods} }`)}`;

test("explicit Runtime root selects every adapter and per-adapter overrides retain precedence", async t => {
  const root = await mkdtemp(join(tmpdir(), "channels-explicit-runtime-"));
  const previous = process.env.MINU_RUNTIME_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.MINU_RUNTIME_ROOT; else process.env.MINU_RUNTIME_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  for (const [adapter, name] of [["pi", "PiAgentRuntime"], ["codex", "CodexAgentRuntime"], ["claude-code", "ClaudeCodeAgentRuntime"]]) {
    const directory = join(root, "packages", adapter!, "dist/src");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.js"), `export class ${name} { constructor() { this.selectedRoot = ${JSON.stringify(root)}; } ${methods} }`);
  }
  process.env.MINU_RUNTIME_ROOT = root;
  const loaded = await loadLocalRuntimes();
  for (const runtime of Object.values(loaded)) assert.equal((runtime as unknown as { selectedRoot: string }).selectedRoot, root);
  const overridden = await loadLocalRuntimes({ pi: moduleOf("PiAgentRuntime") });
  assert.equal((overridden.pi as unknown as { selectedRoot?: string }).selectedRoot, undefined);
  assert.equal((overridden.codex as unknown as { selectedRoot: string }).selectedRoot, root);
});

test("invalid explicit Runtime roots fail closed without borrowing a sibling; complete overrides still win", async t => {
  const root = await mkdtemp(join(tmpdir(), "channels-invalid-runtime-"));
  const previous = process.env.MINU_RUNTIME_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.MINU_RUNTIME_ROOT; else process.env.MINU_RUNTIME_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  process.env.MINU_RUNTIME_ROOT = join(root, "missing");
  await assert.rejects(loadLocalRuntimes(), /Runtime module missing under MINU_RUNTIME_ROOT/);
  const overridden = await loadLocalRuntimes({ pi: moduleOf("PiAgentRuntime"), codex: moduleOf("CodexAgentRuntime"), claudeCode: moduleOf("ClaudeCodeAgentRuntime") });
  assert.equal(overridden.codex.constructor.name, "CodexAgentRuntime");
  process.env.MINU_RUNTIME_ROOT = "";
  await assert.rejects(loadLocalRuntimes(), /MINU_RUNTIME_ROOT must name a non-empty/);
});

test("local runtime loading exposes all per-agent adapters without starting work", async () => {
  const runtimes = await loadLocalRuntimes();
  assert.equal(runtimes.pi.constructor.name, "PiAgentRuntime");
  assert.equal(runtimes.codex.constructor.name, "CodexAgentRuntime");
  assert.equal(runtimes["claude-code"].constructor.name, "ClaudeCodeAgentRuntime");
  assert.notEqual(runtimes.pi, runtimes.codex);
  assert.notEqual(runtimes.codex, runtimes["claude-code"]);
  if (process.env.MINU_RUNTIME_ROOT) {
    for (const [adapter, name] of [["pi", "PiAgentRuntime"], ["codex", "CodexAgentRuntime"], ["claude-code", "ClaudeCodeAgentRuntime"]] as const) {
      const selectedModule: Record<string, unknown> = await import(pathToFileURL(resolve(process.env.MINU_RUNTIME_ROOT, "packages", adapter, "dist/src/index.js")).href);
      assert.equal(runtimes[adapter].constructor, selectedModule[name], "actual selected artifact must be the explicit root module");
    }
  }
});

test("every adapter gets the one shared full access level; Pi keeps its no-argument construction", async () => {
  const recording = (name: string) => `data:text/javascript,${encodeURIComponent(`export class ${name} { constructor(...args) { this.args = args; } ${methods} }`)}`;
  const runtimes = await loadLocalRuntimes({ pi: recording("PiAgentRuntime"), codex: recording("CodexAgentRuntime"), claudeCode: recording("ClaudeCodeAgentRuntime") });
  assert.deepEqual((runtimes["claude-code"] as unknown as { args: unknown[] }).args, [{ permissions: "full" }]);
  assert.deepEqual((runtimes.pi as unknown as { args: unknown[] }).args, []);
  assert.deepEqual((runtimes.codex as unknown as { args: unknown[] }).args, [{ sandbox: "danger-full-access" }]);
  await assert.rejects(loadLocalRuntimes({ pi: recording("PiAgentRuntime"), codex: recording("CodexAgentRuntime"), claudeCode: recording("PiAgentRuntime") }), /claude-code.*ClaudeCodeAgentRuntime/);
});

test("the shared access constant is the single source for every adapter's native setting", () => {
  assert.equal(LOCAL_AGENT_ACCESS, "full");
  assert.deepEqual(LOCAL_AGENT_ACCESS_OPTIONS, { pi: { full: undefined }, "claude-code": { full: { permissions: "full" } }, codex: { full: { sandbox: "danger-full-access" } } });
});

test("explicit module overrides stay adapter-specific and never silently fall back", async () => {
  const runtimes = await loadLocalRuntimes({ pi: moduleOf("PiAgentRuntime"), codex: moduleOf("CodexAgentRuntime"), claudeCode: moduleOf("ClaudeCodeAgentRuntime") });
  assert.equal(runtimes.codex.constructor.name, "CodexAgentRuntime");
  const claude = moduleOf("ClaudeCodeAgentRuntime");
  await assert.rejects(loadLocalRuntimes({ pi: moduleOf("PiAgentRuntime"), codex: moduleOf("PiAgentRuntime"), claudeCode: claude }), /codex.*CodexAgentRuntime/);
  await assert.rejects(loadLocalRuntimes({ pi: moduleOf("CodexAgentRuntime"), codex: moduleOf("CodexAgentRuntime"), claudeCode: claude }), /pi.*PiAgentRuntime/);
});

test("bundled adapters keep isolated worker resources and Codex resumes the same history", { timeout:30000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "channels-runtime-bundle-"))), bin = join(directory, "bin");
  const runtimeRoot = resolve(process.env.MINU_RUNTIME_ROOT ?? resolve(process.cwd(), "../runtime")), log = join(directory, "native.log");
  const { build } = await import("esbuild");
  await mkdir(join(bin, "codex"), { recursive:true }); await mkdir(join(bin, "claude-code"), { recursive:true });
  const targets = [["pi", "index", "runtime-pi.js"], ["pi", "owned-worker", "owned-worker.js"], ["codex", "index", "codex/runtime-codex.js"], ["codex", "owned-worker", "codex/owned-worker.js"], ["claude-code", "index", "claude-code/runtime-claude-code.js"], ["claude-code", "worker-entry", "claude-code/worker-entry.js"]];
  await Promise.all(targets.map(([adapter, entry, output]) => build({ entryPoints:[join(runtimeRoot, `packages/${adapter}/dist/src/${entry}.js`)], outfile:join(bin, output!), bundle:true, platform:"node", format:"esm", target:"node22" })));
  // The output directory must be ESM just like the shipped package.
  const { writeFile } = await import("node:fs/promises"); await writeFile(join(directory,"package.json"), '{"type":"module"}');
  await build({ entryPoints:[resolve(process.cwd(),"packages/control/dist/src/local-runtimes.js")], outfile:join(bin,"runtime-loader.js"), bundle:true, platform:"node", format:"esm", target:"node22" });
  const packagedLoader = await import(pathToFileURL(join(bin,"runtime-loader.js")).href);
  const selectedRoot = process.env.MINU_RUNTIME_ROOT;
  let loaded: Awaited<ReturnType<typeof loadLocalRuntimes>>;
  // No root override: prove the packaged loader uses its bundled resources, not the source tree.
  delete process.env.MINU_RUNTIME_ROOT;
  try { loaded = await packagedLoader.loadLocalRuntimes(); }
  finally { if (selectedRoot === undefined) delete process.env.MINU_RUNTIME_ROOT; else process.env.MINU_RUNTIME_ROOT = selectedRoot; }
  assert.equal(loaded.pi.constructor.name,"PiAgentRuntime");assert.equal(loaded.codex.constructor.name,"CodexAgentRuntime");assert.equal(loaded["claude-code"].constructor.name,"ClaudeCodeAgentRuntime");
  const { CodexAgentRuntime } = await import(pathToFileURL(join(bin,"codex/runtime-codex.js")).href);
  assert.equal(loaded.codex.constructor, CodexAgentRuntime);
  process.env.MINU_RUNTIME_ROOT = runtimeRoot;
  try {
    const explicit = await packagedLoader.loadLocalRuntimes();
    const selected = await import(pathToFileURL(join(runtimeRoot, "packages/codex/dist/src/index.js")).href);
    assert.equal(explicit.codex.constructor, selected.CodexAgentRuntime);
    assert.notEqual(explicit.codex.constructor, loaded.codex.constructor, "explicit root overrides packaged discovery too");
  } finally { if (selectedRoot === undefined) delete process.env.MINU_RUNTIME_ROOT; else process.env.MINU_RUNTIME_ROOT = selectedRoot; }
  const options = { managedRoot:join(directory,"managed"), command:process.execPath, args:[join(runtimeRoot,"packages/codex/dist/test/fixtures/app-server.js"),"lifecycle",log] };
  let runtime = new CodexAgentRuntime(options), session: {id:string;ownerId:string}|undefined;
  t.after(async()=>{if(session)await runtime.stop(session.id).catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const created: {id:string;ownerId:string}=await runtime.startManaged({cwd:directory},"bundle-owner");session=created;
  await runtime.send(session.id,"First bundled input");const history=await runtime.messages(session.id);assert.match(JSON.stringify(history),/First bundled input/);
  if(process.platform==="darwin"){
    await runtime.suspend(session.id,session.ownerId);runtime=new CodexAgentRuntime(options);
    const resumed=await runtime.resume(session.id,session.ownerId);assert.equal(resumed.id,session.id);
    assert.deepEqual(await runtime.messages(session.id),history);await runtime.destroy(session.id,session.ownerId);
    assert.match(await readFile(log+".history.json","utf8"),/First bundled input/);session=undefined;
  } else await runtime.stop(session.id);
});

test("real Codex adapter serves per-agent Conversation turns across product-controller restart",{timeout:30000},async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"channels-native-codex-"))),runtimeRoot=resolve(process.env.MINU_RUNTIME_ROOT??resolve(process.cwd(),"../runtime")),log=join(directory,"native.log");
  const {CodexAgentRuntime}=await import(pathToFileURL(join(runtimeRoot,"packages/codex/dist/src/index.js")).href);
  const nativeOptions={managedRoot:join(directory,"managed"),command:process.execPath,args:[join(runtimeRoot,"packages/codex/dist/test/fixtures/app-server.js"),"lifecycle",log]};
  const pi=(await loadLocalRuntimes()).pi;let codex=new CodexAgentRuntime(nativeOptions),app:Awaited<ReturnType<typeof createLocalProductApp>>|undefined;
  let sessionId:string|undefined,ownerId:string|undefined;
  const diagnostics:unknown[]=[];
  const options=()=>({dataDirectory:join(directory,"data"),workspaceRoot:directory,conversationsPort:0,controlPort:0,webUrl:"http://127.0.0.1:5199/",runtimeAdapter:"pi",runtime:pi,runtimes:{pi,codex},onAudit:(event:unknown)=>diagnostics.push(event),onDiagnostic:(event:unknown)=>diagnostics.push(event)});
  const calls=async()=>{try{return(await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}};
  try {
    app=await createLocalProductApp(options());const workspace=app.workspaceId!,conversation=app.conversationId!,human=app.humanIdentityId!;
    let client=new ConversationClient(app.conversationsEndpoint,{serviceToken:app.conversationsServiceToken});const agent=(await client.listIdentities()).find(i=>i.type==="agent")!.id;
    const bootstrap=await fetch(app.issueBrowserLaunchUrl(),{redirect:"manual"}),cookie=bootstrap.headers.get("set-cookie")!.split(";",1)[0]!;
    const request=async(path:string,method:string,body:unknown)=>fetch(app!.controlEndpoint+path,{method,headers:{cookie,origin:"http://127.0.0.1:5199","content-type":"application/json"},body:JSON.stringify(body)});
    const configured=await request(`/local/workspaces/${workspace}/agents/${agent}/config`,"PATCH",{runtimeAdapter:"codex"});assert.equal(configured.status,200,await configured.text());
    const started=await request(`/local/conversations/${conversation}/agents/${agent}/start`,"POST",{});assert.equal(started.status,201,await started.text());
    const store=await DrizzleLibSqlRelayStorage.open({url:localRelayLibSqlUrl(join(directory,"data/relay.db"))});
    try{const binding=(await store.listConversationBindings(conversation))[0]!;assert.equal(binding.runtimeAdapter,"codex");sessionId=binding.runtimeSessionId;ownerId=binding.runtimeOwnerId;}finally{await store.close();}
    assert.equal((await calls()).filter(c=>c.method==="thread/start").length,0);
    const receive=async(marker:string,count:number)=>{await client.postMessage(conversation,{participantId:human,body:`@builder ${marker}`});const deadline=Date.now()+10000;while((await client.listMessages(conversation)).filter(m=>m.participantId===agent).length<count){assert.ok(Date.now()<deadline,`Native fixture response did not reach Conversations: ${marker}; ${JSON.stringify(diagnostics)}`);await new Promise(r=>setTimeout(r,20));}};
    await receive("First native fixture turn",1);await app.close();app=undefined;
    codex=new CodexAgentRuntime(nativeOptions);app=await createLocalProductApp(options());client=new ConversationClient(app.conversationsEndpoint,{serviceToken:app.conversationsServiceToken});
    await receive("Second native fixture turn",2);
    assert.equal((await calls()).filter(c=>c.method==="thread/start").length,1);assert.equal((await calls()).filter(c=>c.method==="turn/start").length,2);
    assert.equal((await codex.listManagedSessions(ownerId!))[0].id,sessionId);
  } finally {
    await app?.close();if(sessionId&&ownerId){await codex.connectManaged(sessionId,ownerId);await codex.stop(sessionId);}
    await rm(directory,{recursive:true,force:true});
  }
});
