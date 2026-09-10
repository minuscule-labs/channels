import { createServer } from "node:http";
import { LocalAgentHostConfiguration } from "../../control/dist/src/configuration.js";
import {
  createLocalControlHttpServer,
  LocalControlBrowserSessions,
  LocalControlService,
} from "../../control/dist/src/server.js";
import { createChannelHttpServer } from "../../core/dist/src/http-server.js";
import { ChannelService } from "../../core/dist/src/channel-service.js";
import { ChannelClient } from "../../core/dist/src/client.js";
import { InMemoryRelayBindingStore } from "../../relay/dist/src/binding-store.js";

const channelsPort = Number(process.env.MINU_TEST_CHANNELS_PORT ?? 58410);
const controlPort = Number(process.env.MINU_TEST_CONTROL_PORT ?? 58411);
const webPort = Number(process.env.MINU_TEST_WEB_PORT ?? 58412);
const fixturePort = Number(process.env.MINU_TEST_FIXTURE_PORT ?? 58413);
const service = new ChannelService();
const listWorkspaces = service.listWorkspaces.bind(service);
let hideWorkspaces = false;
service.listWorkspaces = async () => hideWorkspaces ? [] : listWorkspaces();
const serviceToken = process.env.MINU_TEST_CHANNELS_SERVICE_TOKEN ?? "browser-fixture-service-token";
let channelServer = await createChannelHttpServer({ service, port: channelsPort, serviceToken });
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
const channel = await service.createChannel({
  workspaceId: workspace.id,
  name: "browser-collaboration",
  participantIds: [human.id, agent.id],
});
const initialTrigger = await service.createMessage(channel.id, {
  participantId: human.id,
  body: "@builder Verify the browser collaboration flow.",
});
const alternateChannel = await service.createChannel({
  workspaceId: workspace.id,
  name: "alternate-collaboration",
  participantIds: [human.id, agent.id],
});
const secondaryWorkspace = await service.createWorkspace({ slug: "browser-secondary", name: "Browser Secondary" });
await service.addWorkspaceMember(secondaryWorkspace.id, {
  identityId: human.id,
  mentionHandle: "david",
  accessRole: "owner",
});
await service.addWorkspaceMember(secondaryWorkspace.id, {
  identityId: agent.id,
  mentionHandle: "builder",
});
const secondaryChannel = await service.createChannel({
  workspaceId: secondaryWorkspace.id,
  name: "secondary-collaboration",
  participantIds: [human.id, agent.id],
});

const privateStore = new InMemoryRelayBindingStore();
const channelClient = new ChannelClient(channelServer.endpoint, { serviceToken });
const browserSessions = new LocalControlBrowserSessions({
  browserUrl: `http://minu-channels.localhost:${webPort}/`,
  currentHumanIdentityId: human.id,
});
const agentBindings = new Map([[`${channel.id}:${agent.id}`, "connected"]]);
let agentActivity;
const fixtureRuntime = {
  async status() { return agentActivity ? "working" : "idle"; },
  async interrupt() {},
  async capabilities() {
    return {
      models: [
        { provider: "openai", id: "gpt-browser-fast", name: "Browser Fast", reasoning: true },
        { provider: "openai", id: "gpt-browser-deep", name: "Browser Deep", reasoning: true },
      ],
      reasoningLevels: ["off", "low", "medium", "high"],
      skills: [
        { id: "skill:review", name: "review", description: "Review changes for correctness" },
        { id: "skill:handoff", name: "handoff", description: "Prepare a concise handoff" },
      ],
    };
  },
};
const fixtureRuntimes = {
  "browser-test": fixtureRuntime,
  "pi-private-browser": fixtureRuntime,
  pi: fixtureRuntime,
};
const localControl = await createLocalControlHttpServer({
  port: controlPort,
  selectLocalFolder: async () => "/tmp",
  allowedOrigins: [browserSessions.browserOrigin],
  browserSessions,
  service: new LocalControlService({
    channels: service,
    bindings: {
      async listChannelBindings(channelId) {
        const state = agentBindings.get(`${channelId}:${agent.id}`);
        if (!state) return [];
        return [{
          agentIdentityId: agent.id,
          runtimeAdapter: "browser-test",
          runtimeSessionId: "private-browser-session",
          state,
          wakePolicy: "mentions",
        }];
      },
    },
    runtimes: fixtureRuntimes,
    lifecycle: {
      available: true,
      async startChannelAgent(channelId, identityId) {
        if (identityId !== agent.id) throw new Error("Unknown fixture agent");
        agentBindings.set(`${channelId}:${identityId}`, "connected");
      },
      async replaceChannelAgent(channelId, identityId) {
        if (identityId !== agent.id) throw new Error("Unknown fixture agent");
        agentBindings.set(`${channelId}:${identityId}`, "connected");
      },
      async stopChannelAgent(channelId, identityId) {
        if (identityId !== agent.id) throw new Error("Unknown fixture agent");
        agentBindings.set(`${channelId}:${identityId}`, "disabled");
      },
      async startAllChannelAgents() {
        return [{ identityId: agent.id, outcome: "skipped", reason: "already_idle" }];
      },
      async stopAllChannelAgents() {
        agentBindings.set(`${channel.id}:${agent.id}`, "disabled");
        return [{ identityId: agent.id, outcome: "stopped" }];
      },
      async cancelCurrentChannelAgent(channelId, identityId) {
        if (channelId !== channel.id || identityId !== agent.id || !agentActivity) throw new Error("No active fixture turn");
        agentActivity = { ...agentActivity, phase: "canceling" };
      },
      activity(channelId, identityId) {
        return channelId === channel.id && identityId === agent.id ? agentActivity : undefined;
      },
    },
    configuration: new LocalAgentHostConfiguration({
      client: channelClient,
      store: privateStore,
      runtimes: fixtureRuntimes,
    }),
  }),
});

const controlServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${fixturePort}`);
  if (request.method === "GET" && url.pathname === "/control-launch") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ launchUrl: browserSessions.issueLaunchUrl(
      localControl.endpoint,
      url.searchParams.get("destination") ?? "/",
    ) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/agent-activity") {
    const phase = url.searchParams.get("phase") ?? "running";
    if (phase === "idle") {
      agentActivity = undefined;
    } else {
      agentActivity = {
        phase,
        triggerMessageId: initialTrigger.id,
        triggerSequence: initialTrigger.sequence,
        startedAt: new Date(Date.now() - 62_000).toISOString(),
        queuedTurns: Number(url.searchParams.get("queued") ?? 0),
        ...(phase === "retrying" ? { retryAttempt: 2 } : {}),
      };
    }
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/peer-message") {
    const mention = url.searchParams.get("mention") === "true";
    const author = url.searchParams.get("author") === "human" ? human : agent;
    const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count") ?? 1)));
    const targetChannel = url.searchParams.get("workspace") === "inactive"
      ? secondaryChannel
      : url.searchParams.get("channel") === "alternate" ? alternateChannel : channel;
    const created = [];
    for (let index = 0; index < count; index += 1) {
      const input = {
        participantId: author.id,
        body: `${url.searchParams.get("body") ?? "A new peer message."}${count > 1 ? ` ${index + 1}` : ""}`,
        ...(mention ? { to: [human.id] } : {}),
      };
      const idempotencyKey = url.searchParams.get("duplicate") === "true" ? `browser-duplicate-${Date.now()}-${index}` : undefined;
      created.push(await service.createMessage(targetChannel.id, input, idempotencyKey));
      if (idempotencyKey) await service.createMessage(targetChannel.id, input, idempotencyKey);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ messages: created }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/hide-workspaces") {
    hideWorkspaces = url.searchParams.get("value") === "true";
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/disconnect") {
    response.writeHead(404).end();
    return;
  }
  await channelServer.close();
  const disconnectedChannel = url.searchParams.get("workspace") === "inactive" ? secondaryChannel : channel;
  await service.createMessage(disconnectedChannel.id, {
    participantId: url.searchParams.get("workspace") === "inactive" ? agent.id : human.id,
    body: "Message created while the browser was offline.",
  });
  response.writeHead(202).end();
  setTimeout(async () => {
    channelServer = await createChannelHttpServer({ service, port: channelsPort, serviceToken });
  }, 2_000);
});
controlServer.listen(fixturePort, "127.0.0.1");

console.log(JSON.stringify({ workspaceId: workspace.id, channelId: channel.id }));

const close = async () => {
  await channelServer.close().catch(() => undefined);
  await localControl.close().catch(() => undefined);
  await privateStore.close().catch(() => undefined);
  controlServer.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
await new Promise(() => {});
