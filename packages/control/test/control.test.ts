import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient } from "@minu/channels-core/client";
import { createChannelHttpServer } from "@minu/channels-core";
import type { ChannelMetadata } from "@minu/channels-core/types";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalControlClient, LocalControlClientError } from "../src/client.js";
import { createLocalControlDaemon } from "../src/daemon.js";
import { createLocalReviewApp } from "../src/review.js";
import {
  createLocalControlHttpServer,
  LocalControlBrowserSessions,
  LocalControlService,
  type LocalControlAuditEvent,
  type LocalControlBindingRecord,
} from "../src/server.js";

const channel: ChannelMetadata = {
  id: "channel-1",
  workspaceId: "workspace-1",
  name: "Control Test",
  rosterRevision: 1,
  createdAt: "2026-08-28T00:00:00.000Z",
  participants: [
    { id: "human-1", type: "human", handle: "david", status: "active" },
    { id: "agent-running", type: "agent", handle: "builder", status: "active" },
    { id: "agent-unbound", type: "agent", handle: "reviewer", status: "active" },
    { id: "agent-disabled", type: "agent", handle: "retired", status: "disabled" },
    { id: "service-replacing", type: "service", handle: "automation", status: "active" },
  ],
};

const records: LocalControlBindingRecord[] = [
  {
    agentIdentityId: "agent-running",
    runtimeAdapter: "pi-private-adapter",
    runtimeSessionId: "runtime-session-secret",
    state: "connected",
    wakePolicy: "mentions",
    lastVerifiedAt: "2026-08-28T00:01:00.000Z",
  },
  {
    agentIdentityId: "agent-disabled",
    runtimeAdapter: "pi-private-adapter",
    runtimeSessionId: "disabled-session-secret",
    state: "connected",
    wakePolicy: "muted",
  },
  {
    agentIdentityId: "service-replacing",
    runtimeAdapter: "pi-private-adapter",
    runtimeSessionId: "replacement-session-secret",
    state: "replacing",
    wakePolicy: "all_messages",
  },
];

async function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

function service() {
  const statusCalls: string[] = [];
  const control = new LocalControlService({
    channels: {
      async getChannel(channelId) {
        assert.equal(channelId, channel.id);
        return channel;
      },
    },
    bindings: { async listChannelBindings() { return records; } },
    runtimes: {
      "pi-private-adapter": {
        async status(sessionId) {
          statusCalls.push(sessionId);
          return "working" as const;
        },
      },
    },
  });
  return { control, statusCalls };
}

test("projects private bindings into presentation-safe Channel agent status", async () => {
  const { control, statusCalls } = service();
  const result = await control.listChannelAgents(channel.id);

  assert.deepEqual(result.agents.map(({ identityId, state }) => ({ identityId, state })), [
    { identityId: "agent-running", state: "running" },
    { identityId: "agent-unbound", state: "unbound" },
    { identityId: "agent-disabled", state: "disabled" },
    { identityId: "service-replacing", state: "uncertain" },
  ]);
  assert.deepEqual(statusCalls, ["runtime-session-secret"]);
  assert.deepEqual(result.agents[0]?.capabilities, { steer: false, interrupt: false, reconnect: false });
  assert.deepEqual(result.agents[1]?.capabilities, { steer: false, interrupt: false, reconnect: false });

  const publicJson = JSON.stringify(result);
  assert.doesNotMatch(publicJson, /runtime-session-secret|private-adapter|replacement-session-secret/);
  assert.doesNotMatch(publicJson, /runtimeSessionId|runtimeAdapter|leaseOwner/);
});

test("maps missing, failed, and stalled Runtime bridges to offline without leaking errors", async () => {
  const control = new LocalControlService({
    channels: { async getChannel() { return { ...channel, participants: [channel.participants[1]!] }; } },
    bindings: { async listChannelBindings() { return records; } },
    runtimes: {
      "pi-private-adapter": { async status() { throw new Error("credential: secret-token"); } },
    },
  });
  const result = await control.listChannelAgents(channel.id);
  assert.equal(result.agents[0]?.state, "offline");
  assert.doesNotMatch(JSON.stringify(result), /secret-token|credential/);

  const stalled = new LocalControlService({
    channels: { async getChannel() { return { ...channel, participants: [channel.participants[1]!] }; } },
    bindings: { async listChannelBindings() { return records; } },
    runtimes: { "pi-private-adapter": { async status() { return new Promise<"idle">(() => {}); } } },
    statusTimeoutMs: 1,
  });
  assert.equal((await stalled.listChannelAgents(channel.id)).agents[0]?.state, "offline");
});

test("validates bounded client and Runtime status timeouts", () => {
  assert.throws(() => new LocalControlClient("", { timeoutMs: 0 }), /positive integer/);
  assert.throws(() => new LocalControlService({
    channels: { async getChannel() { return channel; } },
    bindings: { async listChannelBindings() { return []; } },
    runtimes: {},
    statusTimeoutMs: 0,
  }), /positive integer/);
});

test("serves read-only loopback endpoints with host and Origin enforcement", async (context) => {
  const { control } = service();
  const server = await createLocalControlHttpServer({
    service: control,
    port: 0,
    allowedOrigins: ["http://127.0.0.1:5174"],
  });
  context.after(() => server.close());
  const client = new LocalControlClient(server.endpoint);

  assert.deepEqual(await client.health(), { status: "ok", protocolVersion: 1 });
  assert.equal((await client.capabilities()).features.steer, false);
  const agents = await client.listChannelAgents(channel.id);
  assert.equal(agents.agents[0]?.identityId, "agent-running");

  const allowedOrigin = await fetch(`${server.endpoint}/local/health`, {
    headers: { origin: "http://127.0.0.1:5174" },
  });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(allowedOrigin.headers.get("access-control-allow-origin"), "http://127.0.0.1:5174");

  const forbiddenOrigin = await fetch(`${server.endpoint}/local/health`, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(forbiddenOrigin.status, 403);

  assert.equal(
    await requestStatus(`${server.endpoint}/local/health`, { host: "attacker.example" }),
    403,
  );

  const write = await fetch(`${server.endpoint}/local/health`, { method: "POST" });
  assert.equal(write.status, 405);

  await assert.rejects(
    () => new LocalControlClient(server.endpoint).listChannelAgents("missing"),
    (error: unknown) => error instanceof LocalControlClientError
      && error.status === 502
      && error.message === "Local control status unavailable",
  );
});

test("exchanges a one-time launch code for an expiring HttpOnly browser session", async (context) => {
  const { control } = service();
  let currentTime = new Date("2026-08-28T00:00:00.000Z");
  const audit: LocalControlAuditEvent[] = [];
  const sessions = new LocalControlBrowserSessions({
    browserUrl: "http://127.0.0.1:5174/app/workspaces/workspace-1",
    launchCodeTtlMs: 1_000,
    sessionTtlMs: 2_000,
    now: () => currentTime,
    onAudit: (event) => audit.push(event),
  });
  const server = await createLocalControlHttpServer({
    service: control,
    port: 0,
    allowedOrigins: [sessions.browserOrigin],
    browserSessions: sessions,
  });
  context.after(() => server.close());

  const unauthenticated = await fetch(`${server.endpoint}/local/health`);
  assert.equal(unauthenticated.status, 401);
  assert.throws(
    () => sessions.issueLaunchUrl("http://localhost:4311"),
    /same loopback hostname/,
  );

  const launchUrl = sessions.issueLaunchUrl(server.endpoint, "/app/workspaces/workspace-1/channels/channel-1");
  const bootstrap = await fetch(launchUrl, { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  assert.equal(
    bootstrap.headers.get("location"),
    "http://127.0.0.1:5174/app/workspaces/workspace-1/channels/channel-1",
  );
  assert.equal(bootstrap.headers.get("referrer-policy"), "no-referrer");
  const setCookie = bootstrap.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/local/);
  const cookie = setCookie.split(";", 1)[0]!;
  assert.doesNotMatch(cookie, /code=/);

  const authenticated = await fetch(`${server.endpoint}/local/health`, {
    headers: { cookie, origin: sessions.browserOrigin },
  });
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.headers.get("access-control-allow-credentials"), "true");

  assert.equal((await fetch(launchUrl, { redirect: "manual" })).status, 401);
  currentTime = new Date("2026-08-28T00:00:03.000Z");
  assert.equal((await fetch(`${server.endpoint}/local/health`, { headers: { cookie } })).status, 401);

  const expiredLaunch = sessions.issueLaunchUrl(server.endpoint);
  currentTime = new Date("2026-08-28T00:00:05.000Z");
  assert.equal((await fetch(expiredLaunch, { redirect: "manual" })).status, 401);
  assert.deepEqual(audit.map(({ action, outcome, reason }) => ({ action, outcome, reason })), [
    { action: "session.rejected", outcome: "rejected", reason: "missing" },
    { action: "launch.created", outcome: "accepted", reason: undefined },
    { action: "launch.redeemed", outcome: "accepted", reason: undefined },
    { action: "launch.rejected", outcome: "rejected", reason: "reused" },
    { action: "session.rejected", outcome: "rejected", reason: "expired" },
    { action: "launch.created", outcome: "accepted", reason: undefined },
    { action: "launch.rejected", outcome: "rejected", reason: "expired" },
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /minu_local_session|code=|runtime-session-secret/);
});

test("review app seeds a disposable Workspace and authenticated presentation states", async () => {
  const app = await createLocalReviewApp({
    channelsPort: 0,
    controlPort: 0,
    webUrl: "http://127.0.0.1:5174/",
  });
  try {
    const client = new ChannelClient(app.channelsEndpoint);
    const workspaces = await client.listWorkspaces();
    assert.deepEqual(workspaces.map(({ id, name }) => ({ id, name })), [{
      id: app.workspaceId,
      name: "MinuChannels Review",
    }]);
    assert.equal((await client.listWorkspaceChannels(app.workspaceId))[0]?.name, "product-review");
    const messages = await client.listMessages(app.channelId);
    assert.deepEqual(messages.map(({ sequence, body }) => ({ sequence, body })), [
      {
        sequence: 1,
        body: "@builder Please prepare the first implementation pass and hand it to @reviewer.",
      },
      {
        sequence: 2,
        body: "Review mode is ready. Send @builder a message to test the simulated Relay response. Unaddressed messages remain shared context and do not wake agents.",
      },
      {
        sequence: 3,
        body: "I’ll independently review the result and report concrete findings here.",
      },
      {
        sequence: 4,
        body: "[Simulated review agent] I received “＠builder Please prepare the first implementation pass and hand it to ＠reviewer”. This confirms mention routing, Relay delivery, and response posting are working. Live Pi execution is not enabled in review mode.",
      },
    ]);

    await client.postMessage(app.channelId, {
      participantId: app.humanIdentityId,
      body: "@builder Confirm this review message.",
    });
    let updatedMessages = await client.listMessages(app.channelId);
    for (let attempt = 0; attempt < 20 && updatedMessages.length < 6; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      updatedMessages = await client.listMessages(app.channelId);
    }
    assert.equal(updatedMessages[5]?.body, "[Simulated review agent] I received “＠builder Confirm this review message”. This confirms mention routing, Relay delivery, and response posting are working. Live Pi execution is not enabled in review mode.");

    const bootstrap = await fetch(app.issueBrowserLaunchUrl(), { redirect: "manual" });
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.ok(setCookie);
    const response = await fetch(`${app.controlEndpoint}/local/channels/${app.channelId}/agents`, {
      headers: {
        cookie: setCookie.split(";", 1)[0]!,
        origin: "http://127.0.0.1:5174",
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { agents: Array<{ state: string }> };
    assert.deepEqual(body.agents.map(({ state }) => state), ["idle", "unbound"]);
    assert.doesNotMatch(JSON.stringify(body), /review-builder-session|review-mode:builder|rootUri/);
  } finally {
    await app.close();
  }
});

test("daemon composes public Channels, private Relay storage, Runtime status, and browser auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-control-daemon-"));
  const databasePath = join(directory, "relay.db");
  const channelServer = await createChannelHttpServer({ port: 0 });
  let daemon: Awaited<ReturnType<typeof createLocalControlDaemon>> | undefined;
  try {
    const client = new ChannelClient(channelServer.endpoint);
    const human = await client.createIdentity({ type: "human", displayName: "Owner" });
    const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
    const workspace = await client.createWorkspace({ slug: "daemon-test", name: "Daemon Test" });
    await client.addWorkspaceMember(workspace.id, {
      identityId: human.id,
      mentionHandle: "owner",
      accessRole: "owner",
    });
    await client.addWorkspaceMember(workspace.id, {
      identityId: agent.id,
      mentionHandle: "builder",
    });
    const createdChannel = await client.createChannel({
      workspaceId: workspace.id,
      participantIds: [human.id, agent.id],
    });

    const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(databasePath) });
    const timestamp = "2026-08-28T00:00:00.000Z";
    await store.putWorkspaceConfig({
      workspaceId: workspace.id,
      rootUri: "/private/workspace/root",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.putAgentConfig({
      id: "private-agent-config",
      workspaceId: workspace.id,
      agentIdentityId: agent.id,
      personaRef: "private-persona-reference",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.putBinding({
      id: "private-binding",
      workspaceAgentConfigId: "private-agent-config",
      workspaceId: workspace.id,
      channelId: createdChannel.id,
      agentIdentityId: agent.id,
      runtimeAdapter: "test-runtime",
      runtimeSessionId: "private-runtime-session",
      generation: 1,
      state: "connected",
      wakePolicy: "mentions",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.close();

    daemon = await createLocalControlDaemon({
      channelsEndpoint: channelServer.endpoint,
      relayDatabasePath: databasePath,
      webUrl: "http://127.0.0.1:5174/",
      port: 0,
      runtimes: {
        "test-runtime": {
          async status(sessionId) {
            assert.equal(sessionId, "private-runtime-session");
            return "idle";
          },
        },
      },
    });
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await fetch(`${daemon.endpoint}/local/health`)).status, 401);
    const bootstrap = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = setCookie.split(";", 1)[0]!;
    const response = await fetch(`${daemon.endpoint}/local/channels/${createdChannel.id}/agents`, {
      headers: { cookie, origin: "http://127.0.0.1:5174" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { agents: Array<{ identityId: string; state: string }> };
    assert.deepEqual(body.agents, [{
      workspaceId: workspace.id,
      channelId: createdChannel.id,
      identityId: agent.id,
      state: "idle",
      wakePolicy: "mentions",
      capabilities: { steer: false, interrupt: false, reconnect: false },
    }]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /private-runtime-session|private-persona-reference|private\/workspace|test-runtime|private-binding/,
    );
  } finally {
    await daemon?.close().catch(() => undefined);
    await channelServer.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
