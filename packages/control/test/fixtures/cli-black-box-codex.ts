import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function required(name:string):string { const value=process.env[name];if(!value)throw new Error(`Missing fixture setting ${name}`);return value; }
const runtimeRoot=required("MINU_TEST_RUNTIME_ROOT");
const {CodexAgentRuntime:NativeRuntime}=await import(pathToFileURL(join(runtimeRoot,"packages/codex/dist/src/index.js")).href);

/** Inject only the existing owned, credential-free app-server fixture. */
export class CodexAgentRuntime extends NativeRuntime {
  constructor(){super({managedRoot:required("MINU_TEST_CODEX_ROOT"),command:process.execPath,args:[join(runtimeRoot,"packages/codex/dist/test/fixtures/app-server.js"),"lifecycle",required("MINU_TEST_CODEX_LOG")]});}
  async startManaged(config:unknown,ownerId:string){
    const session=await super.startManaged(config,ownerId);
    // Public returned identity only, for public-CLI teardown and creation-count assertions.
    appendFileSync(required("MINU_TEST_ADAPTER_LOG"),JSON.stringify({adapter:"codex",method:"startManaged",id:session.id,ownerId:session.ownerId})+"\n");
    return session;
  }
}
