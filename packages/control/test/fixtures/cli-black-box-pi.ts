import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

type Message={role:"user"|"assistant";content:string};
type Session={id:string;ownerId:string;status:"idle"|"offline";messages:Message[]};
type State={next:number;sessions:Session[]};
function required(name:string):string{const value=process.env[name];if(!value)throw new Error(`Missing fixture setting ${name}`);return value;}
function read():State{const path=required("MINU_TEST_PI_STATE");return existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{next:0,sessions:[]};}
function save(state:State){writeFileSync(required("MINU_TEST_PI_STATE"),JSON.stringify(state),{mode:0o600});}
function log(method:string,id:string){appendFileSync(required("MINU_TEST_ADAPTER_LOG"),JSON.stringify({adapter:"pi",method,id})+"\n");}
function session(state:State,id:string,owner?:string):Session{const value=state.sessions.find(s=>s.id===id&&(owner===undefined||s.ownerId===owner));if(!value)throw new Error("Pi fixture session unavailable");return value;}

/** Persistent offline Pi stand-in; no executable, model, credentials or network. */
export class PiAgentRuntime {
  async capabilities(){return{models:[],reasoningLevels:[],skills:[]};}
  async start(config:unknown){return this.startManaged(config,"legacy-fixture");}
  async startManaged(_config:unknown,ownerId:string){const state=read(),id=`pi-fixture-${++state.next}`;state.sessions.push({id,ownerId,status:"idle",messages:[]});save(state);log("startManaged",id);return{id,ownerId};}
  async listManagedSessions(ownerId:string){return read().sessions.filter(s=>s.ownerId===ownerId).map(s=>({id:s.id,ownerId,state:s.status==="offline"?"suspended":"active"}));}
  async resume(id:string,ownerId:string){const state=read();session(state,id,ownerId).status="idle";save(state);log("resume",id);return{id,ownerId};}
  async status(id:string){return read().sessions.find(s=>s.id===id)?.status??"offline";}
  async send(id:string,input:string){const state=read(),value=session(state,id);value.messages.push({role:"user",content:input},{role:"assistant",content:`Pi fixture reply from ${id}`});save(state);log("send",id);}
  async messages(id:string){return session(read(),id).messages;}
  async interrupt(_id:string){}
  async stop(id:string){const state=read();session(state,id).status="offline";save(state);}
  async suspend(id:string,owner:string){session(read(),id,owner);await this.stop(id);}
  async destroy(id:string,owner:string){const state=read();session(state,id,owner);state.sessions=state.sessions.filter(s=>s.id!==id);save(state);}
}
