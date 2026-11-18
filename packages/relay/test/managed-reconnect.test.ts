import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { InMemoryRelayBindingStore, LocalRelayDirectory, restoreConversationBindings, type AgentRuntimePort } from "../src/index.ts";

for(const outcome of ["correct","wrong-owner","wrong-id","rejected"] as const)test(`managed restore ${outcome} authenticates the living worker before status without resume`,async()=>{
  const server=await createConversationHttpServer({port:0});let restored:Awaited<ReturnType<typeof restoreConversationBindings>>|undefined;
  try {
    const client=new ConversationClient(server.endpoint,{serviceToken:server.serviceToken}),store=new InMemoryRelayBindingStore();
    const agent=await client.createIdentity({type:"agent",displayName:"Agent"}),workspace=await client.createWorkspace({slug:"reconnect",name:"Reconnect"});
    await client.addWorkspaceMember(workspace.id,{identityId:agent.id,mentionHandle:"agent"});
    const conversation=await client.createConversation({workspaceId:workspace.id,participantIds:[agent.id]});
    const directory=new LocalRelayDirectory(client,store);await directory.configureWorkspace({workspaceId:workspace.id,rootUri:"file:///tmp"});await directory.configureAgent({workspaceId:workspace.id,agentIdentityId:agent.id,runtimeAdapter:"codex"});
    const binding=await directory.bindAgent({conversationId:conversation.id,agentIdentityId:agent.id,runtimeAdapter:"codex",runtimeSessionId:"session",runtimeOwnerId:"owner"});
    const calls:string[]=[];
    const runtime:AgentRuntimePort={
      async listManagedSessions(owner){assert.equal(owner,"owner");calls.push("list");return[{id:"session",ownerId:"owner",state:"active"}];},
      async connectManaged(id,owner){assert.equal(id,"session");assert.equal(owner,"owner");calls.push("connect");if(outcome==="rejected")throw new Error("Fenced");return{id:outcome==="wrong-id"?"other":"session",ownerId:outcome==="wrong-owner"?"other":"owner"};},
      async resume(){throw new Error("Live restoration must not resume");},
      async status(){calls.push("status");return"idle";},async send(){},async messages(){return[];},
    };
    restored=await restoreConversationBindings({client,store,conversationId:conversation.id,leaseOwner:"test",runtimes:{codex:runtime}});
    assert.deepEqual(calls,outcome==="correct"?["list","connect","status"]:["list","connect"]);
    assert.equal(restored.bindings.length,outcome==="correct"?1:0);
    if(outcome!=="correct")assert.equal(restored.outcomes.get(binding.id),"runtime_uncertain");
  } finally {await restored?.close();await server.close();}
});
