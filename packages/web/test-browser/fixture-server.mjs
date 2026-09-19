import { createServer } from "node:http";
import { LocalAgentHostConfiguration } from "../../control/dist/src/configuration.js";
import {
  createLocalControlHttpServer,
  LocalControlBrowserSessions,
  LocalControlService,
} from "../../control/dist/src/server.js";
import { createConversationHttpServer } from "../../core/dist/src/http-server.js";
import { ConversationService } from "../../core/dist/src/conversation-service.js";
import { ConversationClient } from "../../core/dist/src/client.js";
import { InMemoryRelayBindingStore } from "../../relay/dist/src/binding-store.js";

const conversationsPort = Number(process.env.MINU_TEST_CHANNELS_PORT ?? 58410);
const controlPort = Number(process.env.MINU_TEST_CONTROL_PORT ?? 58411);
const webPort = Number(process.env.MINU_TEST_WEB_PORT ?? 58412);
const fixturePort = Number(process.env.MINU_TEST_FIXTURE_PORT ?? 58413);
const service = new ConversationService();
const listWorkspaces = service.listWorkspaces.bind(service);
let hideWorkspaces = false;
service.listWorkspaces = async () => hideWorkspaces ? [] : listWorkspaces();
const serviceToken = process.env.MINU_TEST_CHANNELS_SERVICE_TOKEN ?? "browser-fixture-service-token";
let conversationServer = await createConversationHttpServer({ service, port: conversationsPort, serviceToken });
const human = await service.createIdentity({ type: "human", displayName: "David Kennedy" });
const agent = await service.createIdentity({ type: "agent", displayName: "Builder Agent" });
const member = await service.createIdentity({ type: "human", displayName: "Workspace Member" });
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
await service.addWorkspaceMember(workspace.id, {
  identityId: member.id,
  mentionHandle: "member",
});
const conversation = await service.createConversation({
  workspaceId: workspace.id,
  name: "browser-collaboration",
  participantIds: [human.id, agent.id],
});
const initialTrigger = await service.createMessage(conversation.id, {
  participantId: human.id,
  body: "@builder Verify the browser collaboration flow.",
});
const alternateConversation = await service.createConversation({
  workspaceId: workspace.id,
  name: "alternate-collaboration",
  participantIds: [human.id, agent.id],
});
for (let index = 1; index <= 6; index += 1) {
  await service.createConversation({
    workspaceId: workspace.id,
    name: `connection-pool-${index}`,
    participantIds: [human.id, agent.id],
  });
}
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
const secondaryConversation = await service.createConversation({
  workspaceId: secondaryWorkspace.id,
  name: "secondary-collaboration",
  participantIds: [human.id, agent.id],
});

const privateStore = new InMemoryRelayBindingStore();
const conversationClient = new ConversationClient(conversationServer.endpoint, { serviceToken });
const browserSessions = new LocalControlBrowserSessions({
  browserUrl: `http://minu-channels.localhost:${webPort}/`,
  currentHumanIdentityId: human.id,
});
const agentBindings = new Map([[`${conversation.id}:${agent.id}`, "connected"]]);
const attachedAgents = new Set([`${conversation.id}:${agent.id}`]);
let agentActivity;
let runtimeReachable = true;
let runtimeCapabilityMode = "available";
let diagnosticOpenCount = 0;
let turnFailuresVisible = false;
let turnFailureTokenVersion = 0;
const fixtureRuntime = {
  async status() { return runtimeReachable ? (agentActivity ? "working" : "idle") : "offline"; },
  async sessionCapabilities() {
    if (runtimeCapabilityMode === "failed") {
      throw new Error("SECRET_RUNTIME_CAPABILITY_TRANSPORT");
    }
    return {
      version: runtimeCapabilityMode === "malformed" ? 2 : 1,
      safeActivityEvents: false,
      interrupt: true,
      reconnectExisting: true,
      interactiveAttach: false,
      openDiagnostic: true,
      liveSkillVerification: false,
    };
  },
  async interrupt() {},
  async openDiagnostic() { diagnosticOpenCount += 1; },
  async capabilities() {
    return {
      models: [
        { provider: "openai", id: "gpt-browser-fast", name: "Browser Fast", reasoning: true },
        { provider: "openai", id: "gpt-browser-deep", name: "Browser Deep", reasoning: true },
        { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true },
      ],
      reasoningLevels: ["off", "low", "medium", "high"],
      defaultModel: { provider: "openai", id: "gpt-browser-deep" },
      defaultReasoningLevel: "high",
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
    conversations: service,
    bindings: {
      async listConversationBindings(conversationId) {
        const state = agentBindings.get(`${conversationId}:${agent.id}`);
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
      async startConversationAgent(conversationId, identityId) {
        if (identityId !== agent.id) throw new Error("Unknown fixture agent");
        agentBindings.set(`${conversationId}:${identityId}`, "connected");
        attachedAgents.add(`${conversationId}:${identityId}`);
      },
      async reconnectConversationAgent(conversationId, identityId) {
        if (identityId !== agent.id) throw new Error("Unknown fixture agent");
        attachedAgents.add(`${conversationId}:${identityId}`);
      },
      isAttached(conversationId, identityId) {
        return attachedAgents.has(`${conversationId}:${identityId}`);
      },
      async replaceConversationAgent(conversationId, identityId) {
        if (identityId !== agent.id) throw new Error("Unknown fixture agent");
        agentBindings.set(`${conversationId}:${identityId}`, "connected");
        attachedAgents.add(`${conversationId}:${identityId}`);
      },
      async stopConversationAgent(conversationId, identityId) {
        if (identityId !== agent.id) throw new Error("Unknown fixture agent");
        agentBindings.set(`${conversationId}:${identityId}`, "disabled");
        attachedAgents.delete(`${conversationId}:${identityId}`);
      },
      async startAllConversationAgents() {
        return [{ identityId: agent.id, outcome: "skipped", reason: "already_idle" }];
      },
      async stopAllConversationAgents() {
        agentBindings.set(`${conversation.id}:${agent.id}`, "disabled");
        attachedAgents.delete(`${conversation.id}:${agent.id}`);
        return [{ identityId: agent.id, outcome: "stopped" }];
      },
      async cancelCurrentConversationAgent(conversationId, identityId) {
        if (conversationId !== conversation.id || identityId !== agent.id || !agentActivity) throw new Error("No active fixture turn");
        agentActivity = { ...agentActivity, phase: "canceling" };
      },
      async listConversationTurnFailures(conversationId) {
        if (!turnFailuresVisible || conversationId !== conversation.id) {
          return { protocolVersion: 17, conversationId, diagnostics: [] };
        }
        turnFailureTokenVersion += 1;
        return {
          protocolVersion: 17,
          conversationId,
          diagnostics: [{
            participant: { identityId: agent.id, displayLabel: "Builder Agent" },
            causeCategory: "runtime_request_timeout",
            failedAt: "2026-09-18T13:00:00.000Z",
            elapsedMs: 2_400,
            attemptCount: 2,
            deliveryOutcome: "delivered",
            remediation: { code: "retry_request", label: "Retry request" },
            openDiagnostic: runtimeReachable ? { state: "available", token: `fixture-turn-failure-token-${turnFailureTokenVersion}` } : { state: "unavailable" },
          }],
        };
      },
      async openConversationTurnFailureDiagnostic(conversationId, _actorIdentityId, _scope, token) {
        if (!turnFailuresVisible || conversationId !== conversation.id || token !== `fixture-turn-failure-token-${turnFailureTokenVersion}` || !runtimeReachable) {
          return { protocolVersion: 17, status: "unavailable" };
        }
        await fixtureRuntime.openDiagnostic();
        return { protocolVersion: 17, status: "accepted" };
      },
      activity(conversationId, identityId) {
        return conversationId === conversation.id && identityId === agent.id ? agentActivity : undefined;
      },
    },
    configuration: new LocalAgentHostConfiguration({
      client: conversationClient,
      store: privateStore,
      runtimes: fixtureRuntimes,
    }),
  }),
});

const controlServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${fixturePort}`);
  if (request.method === "GET" && url.pathname === "/control-launch") {
    browserSessions.currentHumanIdentityId = url.searchParams.get("actor") === "member" ? member.id : human.id;
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
        queuedTurnsExact: url.searchParams.get("exact") !== "false",
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
    const targetConversation = url.searchParams.get("workspace") === "inactive"
      ? secondaryConversation
      : url.searchParams.get("conversation") === "alternate" ? alternateConversation : conversation;
    const created = [];
    for (let index = 0; index < count; index += 1) {
      const input = {
        participantId: author.id,
        body: `${url.searchParams.get("body") ?? "A new peer message."}${count > 1 ? ` ${index + 1}` : ""}`,
        ...(mention ? { to: [human.id] } : {}),
      };
      const idempotencyKey = url.searchParams.get("duplicate") === "true" ? `browser-duplicate-${Date.now()}-${index}` : undefined;
      created.push(await service.createMessage(targetConversation.id, input, idempotencyKey));
      if (idempotencyKey) await service.createMessage(targetConversation.id, input, idempotencyKey);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ messages: created }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/detach-agent") {
    attachedAgents.delete(`${conversation.id}:${agent.id}`);
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/turn-failures") {
    turnFailuresVisible = url.searchParams.get("value") !== "false";
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/runtime-reachable") {
    runtimeReachable = url.searchParams.get("value") !== "false";
    response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/diagnostic-opens") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ count: diagnosticOpenCount }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/runtime-capabilities") {
    runtimeCapabilityMode = url.searchParams.get("mode") ?? "available";
    response.writeHead(204).end();
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
  await conversationServer.close();
  const disconnectedConversation = url.searchParams.get("workspace") === "inactive" ? secondaryConversation : conversation;
  await service.createMessage(disconnectedConversation.id, {
    participantId: url.searchParams.get("workspace") === "inactive" ? agent.id : human.id,
    body: "Message created while the browser was offline.",
  });
  response.writeHead(202).end();
  setTimeout(async () => {
    conversationServer = await createConversationHttpServer({ service, port: conversationsPort, serviceToken });
  }, 2_000);
});
controlServer.listen(fixturePort, "127.0.0.1");

console.log(JSON.stringify({ workspaceId: workspace.id, conversationId: conversation.id }));

const close = async () => {
  await conversationServer.close().catch(() => undefined);
  await localControl.close().catch(() => undefined);
  await privateStore.close().catch(() => undefined);
  controlServer.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
await new Promise(() => {});
