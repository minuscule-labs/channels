import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec=promisify(execFile),cli=fileURLToPath(new URL("../src/local-cli.js",import.meta.url));
const fixture=(name:string)=>fileURLToPath(new URL(`./fixtures/${name}.js`,import.meta.url));
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>Promise<boolean>|boolean,message:string){const deadline=Date.now()+10000;while(!await predicate()){assert.ok(Date.now()<deadline,message);await delay(20);}}
async function freePort():Promise<number>{const server=createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;}
async function rows(path:string):Promise<Array<Record<string,any>>>{try{return(await readFile(path,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}}
interface Running {child:ChildProcess;exit:Promise<unknown[]>;endpoint:string;cookie:string;pid:number;}

// The driver uses only fresh CLIs, authenticated HTTP, and owned backend logs.
// It never imports Runtime adapters, stores, agent hosts, or application factories.
test("Channels CLI black box: per-agent Codex, restart without replay, existing Pi binding",{timeout:60000},async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"channels-codex-cli-"))),workspace=join(directory,"workspace"),web=join(directory,"web"),runtimeRoot=resolve(process.cwd(),"../runtime");
  const adapterLog=join(directory,"adapter.jsonl"),nativeLog=join(directory,"native.jsonl"),managedRoot=join(directory,"codex-managed");
  await Promise.all([mkdir(workspace),mkdir(web),mkdir(join(directory,"home"))]);await writeFile(join(web,"index.html"),"<!doctype html><title>CLI test fixture</title>");
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??"",HOME:join(directory,"home"),TMPDIR:tmpdir(),LANG:"C.UTF-8",MINU_TEST_RUNTIME_ROOT:runtimeRoot,MINU_TEST_CODEX_ROOT:managedRoot,MINU_TEST_CODEX_LOG:nativeLog,MINU_TEST_ADAPTER_LOG:adapterLog,MINU_TEST_PI_STATE:join(directory,"pi-state.json"),MINU_RUNTIME_DIR:join(directory,"pi-registry")};
  let app:Running|undefined;const controllers:number[]=[];
  async function stop(){const running=app;if(!running)return;running.child.kill("SIGINT");const [code]=await running.exit;assert.equal(code,0,"Fixture CLI must close normally");app=undefined;}
  async function start(){
    const ports=await Promise.all([freePort(),freePort(),freePort()]);assert.equal(new Set(ports).size,3);
    const child=spawn(process.execPath,[cli,"run","--no-open","--data-dir",join(directory,"data"),"--cwd",workspace,"--web-dir",web,"--conversations-port",String(ports[0]),"--control-port",String(ports[1]),"--web-port",String(ports[2]),"--runtime-module",fixture("cli-black-box-pi"),"--codex-runtime-module",fixture("cli-black-box-codex")],{env,stdio:["ignore","pipe","pipe"]});
    const exit=once(child,"exit");void exit.catch(()=>{});let output="";
    const capture=(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-65536);};child.stdout!.on("data",capture);child.stderr!.on("data",capture);
    try{await until(()=>{assert.equal(child.exitCode,null,`CLI exited during startup: ${output}`);return output.includes("Press Ctrl-C to stop MinuChannels.");},`CLI did not become ready: ${output}`);}catch(error){child.kill("SIGTERM");await exit;throw error;}
    const endpoint=`http://127.0.0.1:${ports[2]}`,match=output.match(/http:\/\/[^\s]+\/local\/session\/bootstrap\?[^\s]+/);assert.ok(match,"CLI must print its one-time browser launch URL");
    const url=new URL(match[0]);url.hostname="127.0.0.1";
    const response=await fetch(url,{redirect:"manual"});assert.equal(response.status,303);const cookie=response.headers.get("set-cookie")?.split(";",1)[0];assert.ok(cookie);
    const running={child,exit,endpoint,cookie,pid:child.pid!};app=running;controllers.push(running.pid);return running;
  }
  async function request(path:string,method="GET",body?:unknown,expected=200){
    assert.ok(app);const response=await fetch(app.endpoint+path,{method,headers:{cookie:app.cookie,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,expected,`${method} ${path}: ${await response.clone().text()}`);return response.json();
  }
  async function receive(conversation:string,agent:string,marker:string,count:number){
    await request(`/conversations/${conversation}/messages`,"POST",{participantId:human,body:`@builder ${marker}`},201);
    await until(async()=>((await request(`/conversations/${conversation}/messages`)).messages as Array<{participantId:string}>).filter(m=>m.participantId===agent).length===count,`Missing fixture reply for ${marker}`);
    return ((await request(`/conversations/${conversation}/messages`)).messages as Array<{participantId:string;body:string}>).filter(m=>m.participantId===agent);
  }
  t.after(async()=>{
    await stop();
    for(const row of await rows(adapterLog))if(row.adapter==="codex"&&row.method==="startManaged"){
      await exec(process.execPath,[join(runtimeRoot,"packages/runtime/bin/minu-runtime.js"),"--owner",row.ownerId,"--managed-root",managedRoot,"stop",`codex:${row.id}`],{env,timeout:10000});
    }
    for(const row of await rows(nativeLog))if(typeof row.pid==="number")await until(()=>{try{process.kill(row.pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return true;throw error;}},"Owned native fixture must exit");
    await rm(directory,{recursive:true,force:true});
  });
  let human:string,agent:string,workspaceId:string,piConversation:string,codexConversation:string,piReply:string;
  await t.test("fresh CLI preserves the default Pi setup and creates its existing binding",async()=>{
    await start();human=(await request("/local/session")).identityId;workspaceId=(await request("/workspaces")).workspaces[0].id;
    const identities=(await request("/identities")).identities as Array<{id:string;type:string}>;agent=identities.find(i=>i.type==="agent")!.id;
    piConversation=(await request(`/workspaces/${workspaceId}/conversations`)).conversations[0].id;
    assert.equal((await request(`/local/workspaces/${workspaceId}/agents/${agent}/config`)).runtimeAdapter,"pi");
    await request(`/local/conversations/${piConversation}/agents/${agent}/start`,"POST",{},201);
    piReply=(await receive(piConversation,agent,"Pi before adapter change",1))[0]!.body;assert.match(piReply,/Pi fixture reply from pi-fixture-1/);
    assert.equal((await rows(adapterLog)).filter(r=>r.adapter==="pi"&&r.method==="startManaged").length,1);
  });
  await t.test("public per-agent setup selects Codex without replacing Pi and delivers a turn",async()=>{
    await request(`/local/workspaces/${workspaceId}/agents/${agent}/config`,"PATCH",{runtimeAdapter:"codex"});
    assert.equal((await request(`/local/workspaces/${workspaceId}/agents/${agent}/config`)).runtimeAdapter,"codex");
    codexConversation=(await request("/conversations","POST",{workspaceId,participantIds:[human,agent],name:"CLI Codex fixture"},201)).conversation.id;
    await request(`/local/conversations/${codexConversation}/agents/${agent}/start`,"POST",{},201);
    assert.equal((await rows(nativeLog)).filter(r=>r.method==="thread/start").length,0,"Managed creation stays lazy");
    const replies=await receive(codexConversation,agent,"Codex before restart",1);assert.match(replies[0]!.body,/Answer 1:/);
    assert.equal((await rows(nativeLog)).filter(r=>r.method==="turn/start").length,1);
    assert.equal((await receive(piConversation,agent,"Pi after adapter change",2))[1]!.body,piReply);
  });
  await t.test("a second fresh CLI resumes routing without duplicate native dispatch or Pi replacement",async()=>{
    await stop();await start();assert.notEqual(controllers[0],controllers[1]);
    assert.equal((await request(`/local/workspaces/${workspaceId}/agents/${agent}/config`)).runtimeAdapter,"codex");
    assert.equal((await rows(nativeLog)).filter(r=>r.method==="turn/start").length,1,"Restart must not redispatch previous input");
    const replies=await receive(codexConversation,agent,"Codex after restart",2);assert.match(replies[1]!.body,/Answer 2:/);
    assert.equal((await receive(piConversation,agent,"Pi after controller restart",3))[2]!.body,piReply);
    await stop();
    const calls=await rows(nativeLog),adapters=await rows(adapterLog);
    assert.equal(calls.filter(r=>r.method==="thread/start").length,1);assert.equal(calls.filter(r=>r.method==="turn/start").length,2);
    assert.equal(adapters.filter(r=>r.adapter==="codex"&&r.method==="startManaged").length,1);
    assert.equal(adapters.filter(r=>r.adapter==="pi"&&r.method==="startManaged").length,1);
    assert.equal(new Set(adapters.filter(r=>r.adapter==="pi"&&r.method==="send").map(r=>r.id)).size,1);
  });
});
