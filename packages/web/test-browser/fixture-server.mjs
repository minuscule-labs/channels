import { createServer } from "node:http";
import { createLocalControlHttpServer, LocalControlService } from "../../control/dist/src/server.js";
import { createChannelHttpServer } from "../../core/dist/src/http-server.js";
import { ChannelService } from "../../core/dist/src/channel-service.js";

const service = new ChannelService();
let channelServer = await createChannelHttpServer({ service, port: 4310 });
const human = await service.createIdentity({ type: "human", displayName: "David Kennedy" });
const agent = await service.createIdentity({ type: "agent", displayName: "Builder Agent" });
const workspace = await service.createWorkspace({ slug: "browser-test", name: "Browser Test" });
await service.addWorkspaceMember(workspace.id, {
  identityId: human.id,
  mentionHandle: "david",
  accessRole: "owner",
});
await service.addWorkspaceMember(workspace.id, {
  identityId: agent.id,
  mentionHandle: "builder",
  roleLabel: "builder",
  profileOverride: "Implements features and verifies changes.",
});
const channel = await service.createChannel({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
await service.createMessage(channel.id, {
  participantId: human.id,
  body: "@builder Verify the browser collaboration flow.",
});

const localControl = await createLocalControlHttpServer({
  port: 4311,
  allowedOrigins: ["http://127.0.0.1:5174"],
  service: new LocalControlService({
    channels: service,
    bindings: {
      async listChannelBindings() {
        return [{
          agentIdentityId: agent.id,
          runtimeAdapter: "browser-test",
          runtimeSessionId: "private-browser-session",
          state: "connected",
          wakePolicy: "mentions",
        }];
      },
    },
    runtimes: { "browser-test": { async status() { return "idle"; } } },
  }),
});

const controlServer = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/disconnect") {
    response.writeHead(404).end();
    return;
  }
  await channelServer.close();
  await service.createMessage(channel.id, {
    participantId: human.id,
    body: "Message created while the browser was offline.",
  });
  response.writeHead(202).end();
  setTimeout(async () => {
    channelServer = await createChannelHttpServer({ service, port: 4310 });
  }, 2_000);
});
controlServer.listen(4312, "127.0.0.1");

console.log(JSON.stringify({ workspaceId: workspace.id, channelId: channel.id }));

const close = async () => {
  await channelServer.close().catch(() => undefined);
  await localControl.close().catch(() => undefined);
  controlServer.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
await new Promise(() => {});
