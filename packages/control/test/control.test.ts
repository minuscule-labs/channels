import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient } from "@minu/channels-core/client";
import { createChannelHttpServer } from "@minu/channels-core";
import type { ChannelMetadata } from "@minu/channels-core/types";
import { InMemoryRelayBindingStore } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHost, type ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { LocalControlClient, LocalControlClientError } from "../src/client.ts";
import { LocalAgentHostConfiguration, LocalConfigurationRequestError } from "../src/configuration.ts";
import { createLocalControlDaemon } from "../src/daemon.ts";
import { createLocalReviewApp } from "../src/review.ts";
import {
  createLocalControlHttpServer,
  LocalControlBrowserSessions,
  LocalControlService,
  type LocalControlAuditEvent,
  type LocalControlBindingRecord,
} from "../src/server.ts";

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

class ManagedFakeRuntime {
  readonly starts: Array<{ sessionId: string; config: ManagedRuntimeStartConfig }> = [];
  readonly prompts = new Map<string, string[]>();
  private readonly transcripts = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

  async start(config: ManagedRuntimeStartConfig): Promise<{ id: string }> {
    const sessionId = `managed-session-${this.starts.length + 1}`;
    this.starts.push({ sessionId, config: { ...config } });
    this.transcripts.set(sessionId, []);
    return { id: sessionId };
  }

  async status(sessionId: string): Promise<"idle" | "offline"> {
    return this.transcripts.has(sessionId) ? "idle" : "offline";
  }

  async send(sessionId: string, input: string): Promise<void> {
    const transcript = this.transcripts.get(sessionId);
    if (!transcript) throw new Error("Unknown managed session");
    const prompts = this.prompts.get(sessionId) ?? [];
    prompts.push(input);
    this.prompts.set(sessionId, prompts);
    transcript.push(
      { role: "user", content: input },
      { role: "assistant", content: `Genuine managed response from ${sessionId}` },
    );
  }

  async messages(sessionId: string) {
    return (this.transcripts.get(sessionId) ?? []).map((message) => ({ ...message }));
  }

  async stop(sessionId: string): Promise<void> {
    this.transcripts.delete(sessionId);
  }
}

async function waitUntil(assertion: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("Condition was not met before timeout");
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
  assert.deepEqual(result.agents[0]?.capabilities, { start: false, steer: false, interrupt: false, reconnect: false });
  assert.deepEqual(result.agents[1]?.capabilities, { start: false, steer: false, interrupt: false, reconnect: false });

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

test("validates browser identity and bounded client and Runtime status options", () => {
  assert.throws(() => new LocalControlBrowserSessions({
    browserUrl: "http://127.0.0.1:5174/",
    currentHumanIdentityId: "   ",
  }), /currentHumanIdentityId/);
  assert.throws(() => new LocalControlClient("", { timeoutMs: 0 }), /positive integer/);
  assert.throws(() => new LocalControlClient("", { lifecycleTimeoutMs: 0 }), /positive integer/);
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

  assert.deepEqual(await client.health(), { status: "ok", protocolVersion: 3 });
  assert.equal((await client.capabilities()).features.currentSession, true);
  assert.equal((await client.capabilities()).features.agentStart, false);
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
    currentHumanIdentityId: "human-1",
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
  const currentSession = await fetch(`${server.endpoint}/local/session`, {
    headers: { cookie, origin: sessions.browserOrigin },
  });
  assert.deepEqual(await currentSession.json(), { protocolVersion: 3, identityId: "human-1" });

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
    const headers = {
      cookie: setCookie.split(";", 1)[0]!,
      origin: "http://127.0.0.1:5174",
    };
    const sessionResponse = await fetch(`${app.controlEndpoint}/local/session`, { headers });
    assert.deepEqual(await sessionResponse.json(), {
      protocolVersion: 3,
      identityId: app.humanIdentityId,
    });
    const response = await fetch(`${app.controlEndpoint}/local/channels/${app.channelId}/agents`, {
      headers,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { agents: Array<{ state: string }> };
    assert.deepEqual(body.agents.map(({ state }) => state), ["idle", "unbound"]);
    assert.doesNotMatch(JSON.stringify(body), /review-builder-session|review-mode:builder|rootUri/);
  } finally {
    await app.close();
  }
});

test("private configuration authorizes current humans and returns only redacted state", async () => {
  const channelServer = await createChannelHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const audit: LocalControlAuditEvent[] = [];
  try {
    const client = new ChannelClient(channelServer.endpoint);
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const member = await client.createIdentity({ type: "human", displayName: "Member" });
    const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
    const workspace = await client.createWorkspace({ slug: "private-config", name: "Private Config" });
    await client.addWorkspaceMember(workspace.id, {
      identityId: owner.id,
      mentionHandle: "owner",
      accessRole: "owner",
    });
    await client.addWorkspaceMember(workspace.id, {
      identityId: member.id,
      mentionHandle: "member",
    });
    await client.addWorkspaceMember(workspace.id, {
      identityId: agent.id,
      mentionHandle: "builder",
    });
    const configuration = new LocalAgentHostConfiguration({
      client,
      store,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      onAudit: (event) => audit.push(event),
    });

    await assert.rejects(
      configuration.updateWorkspaceConfiguration(workspace.id, member.id, {
        rootUri: "file:///must-not-be-written",
      }),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403,
    );
    await configuration.updateWorkspaceConfiguration(workspace.id, owner.id, {
      rootUri: "file:///private/source/root",
      notesFolderId: "private-notes-folder",
    });
    await assert.rejects(
      configuration.updateWorkspaceAgentConfiguration(workspace.id, agent.id, owner.id, {
        unknownSecretField: "must-not-be-accepted",
      }),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 400,
    );
    const summary = await configuration.updateWorkspaceAgentConfiguration(
      workspace.id,
      agent.id,
      owner.id,
      {
        personaPrompt: "PRIVATE PERSONA: build and verify carefully",
        runtimeAdapter: "pi-owned",
      },
    );

    assert.equal(summary.rootConfigured, true);
    assert.deepEqual(summary.agents, [{
      identityId: agent.id,
      configured: true,
      personaConfigured: true,
      runtimeConfigured: true,
      status: "active",
      boundChannelCount: 0,
      changesApplyToNewSessions: true,
    }]);
    assert.equal((await store.getWorkspaceConfig(workspace.id))?.rootUri, "file:///private/source/root");
    const storedAgent = await store.getWorkspaceAgentConfig(workspace.id, agent.id);
    assert.equal(storedAgent?.personaPrompt, "PRIVATE PERSONA: build and verify carefully");
    assert.equal(storedAgent?.runtimeAdapter, "pi-owned");
    const presented = JSON.stringify(summary);
    assert.doesNotMatch(
      presented,
      /private\/source|private-notes-folder|PRIVATE PERSONA|pi-owned|personaPrompt|runtimeAdapter|rootUri/,
    );
    assert.doesNotMatch(
      JSON.stringify(audit),
      /must-not-be-written|must-not-be-accepted|private\/source|private-notes-folder|PRIVATE PERSONA|pi-owned/,
    );
    assert.deepEqual(audit.map(({ action, outcome, reason }) => ({ action, outcome, reason })), [
      { action: "workspace.config.updated", outcome: "rejected", reason: "forbidden" },
      { action: "workspace.config.updated", outcome: "accepted", reason: undefined },
      { action: "agent.config.updated", outcome: "rejected", reason: "invalid" },
      { action: "agent.config.updated", outcome: "accepted", reason: undefined },
    ]);
  } finally {
    await store.close();
    await channelServer.close();
  }
});

test("agent host starts isolated Channel sessions with private roots and personas", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "minu-agent-host-source-"));
  const channelServer = await createChannelHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const runtime = new ManagedFakeRuntime();
  const audit: LocalControlAuditEvent[] = [];
  let host: LocalAgentHost | undefined;
  let restoredHost: LocalAgentHost | undefined;
  try {
    const client = new ChannelClient(channelServer.endpoint);
    const [owner, agent] = await Promise.all([
      client.createIdentity({ type: "human", displayName: "Owner" }),
      client.createIdentity({ type: "agent", displayName: "Builder" }),
    ]);
    const workspace = await client.createWorkspace({ slug: "managed-runtime", name: "Managed Runtime" });
    await Promise.all([
      client.addWorkspaceMember(workspace.id, {
        identityId: owner.id,
        mentionHandle: "owner",
        accessRole: "owner",
      }),
      client.addWorkspaceMember(workspace.id, {
        identityId: agent.id,
        mentionHandle: "builder",
      }),
    ]);
    const [channelA, channelB] = await Promise.all([
      client.createChannel({
        workspaceId: workspace.id,
        name: "channel-a",
        participantIds: [owner.id, agent.id],
      }),
      client.createChannel({
        workspaceId: workspace.id,
        name: "channel-b",
        participantIds: [owner.id, agent.id],
      }),
    ]);
    const configuration = new LocalAgentHostConfiguration({ client, store });
    await configuration.updateWorkspaceConfiguration(workspace.id, owner.id, {
      rootUri: sourceDirectory,
    });
    await configuration.updateWorkspaceAgentConfiguration(workspace.id, agent.id, owner.id, {
      personaPrompt: "PRIVATE MANAGED PERSONA",
      runtimeAdapter: "managed-test",
    });
    await client.postMessage(channelA.id, {
      participantId: owner.id,
      body: "@builder historical work must not auto-run",
    });
    host = new LocalAgentHost({
      client,
      store,
      runtimes: { "managed-test": runtime },
      onAudit: (event) => audit.push(event),
    });
    assert.equal(host.available, true);
    await assert.rejects(
      host.startChannelAgent(channelA.id, agent.id, agent.id),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403,
    );
    await host.startChannelAgent(channelA.id, agent.id, owner.id);
    await host.startChannelAgent(channelB.id, agent.id, owner.id);
    assert.deepEqual(runtime.starts.map(({ config }) => config), [
      { cwd: sourceDirectory, appendSystemPrompt: "PRIVATE MANAGED PERSONA" },
      { cwd: sourceDirectory, appendSystemPrompt: "PRIVATE MANAGED PERSONA" },
    ]);
    assert.notEqual(runtime.starts[0]?.sessionId, runtime.starts[1]?.sessionId);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.equal((await client.listMessages(channelA.id)).length, 1);

    await Promise.all([
      client.postMessage(channelA.id, { participantId: owner.id, body: "@builder work only in A" }),
      client.postMessage(channelB.id, { participantId: owner.id, body: "@builder work only in B" }),
    ]);
    await waitUntil(async () => (await client.listMessages(channelA.id)).length === 3
      && (await client.listMessages(channelB.id)).length === 2);
    assert.match((await client.listMessages(channelA.id))[2]?.body ?? "", /managed-session-1/);
    assert.match((await client.listMessages(channelB.id))[1]?.body ?? "", /managed-session-2/);
    assert.doesNotMatch(runtime.prompts.get("managed-session-1")?.[0] ?? "", /work only in B/);
    assert.doesNotMatch(runtime.prompts.get("managed-session-2")?.[0] ?? "", /work only in A/);
    assert.equal((await configuration.getWorkspaceConfiguration(workspace.id, owner.id))
      .agents[0]?.boundChannelCount, 2);

    await host.close();
    host = undefined;
    restoredHost = new LocalAgentHost({
      client,
      store,
      runtimes: { "managed-test": runtime },
    });
    await restoredHost.restore();
    await client.postMessage(channelA.id, {
      participantId: owner.id,
      body: "@builder resume only A",
    });
    await waitUntil(async () => (await client.listMessages(channelA.id)).length === 5);
    assert.equal(await store.getCursor(channelA.id, agent.id), 4);
    assert.doesNotMatch(
      JSON.stringify(audit),
      /PRIVATE MANAGED PERSONA|managed-session|agent-host-source/,
    );
    assert.deepEqual(audit.map(({ action, outcome }) => ({ action, outcome })), [
      { action: "agent.session.started", outcome: "rejected" },
      { action: "agent.session.started", outcome: "accepted" },
      { action: "agent.session.started", outcome: "accepted" },
    ]);
  } finally {
    await host?.close().catch(() => undefined);
    await restoredHost?.close().catch(() => undefined);
    await store.close();
    await channelServer.close();
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("daemon composes public Channels, private Relay storage, Runtime status, and browser auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-control-daemon-"));
  const databasePath = join(directory, "relay.db");
  const channelServer = await createChannelHttpServer({ port: 0 });
  const audit: LocalControlAuditEvent[] = [];
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
      currentHumanIdentityId: human.id,
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
      onAudit: (event) => audit.push(event),
    });
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await fetch(`${daemon.endpoint}/local/health`)).status, 401);
    const bootstrap = await fetch(daemon.issueBrowserLaunchUrl(), { redirect: "manual" });
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = setCookie.split(";", 1)[0]!;
    const requestHeaders = {
      cookie,
      origin: "http://127.0.0.1:5174",
      "content-type": "application/json",
    };
    const workspaceUpdate = await fetch(`${daemon.endpoint}/local/workspaces/${workspace.id}/config`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ rootUri: "file:///new/private/root" }),
    });
    assert.equal(workspaceUpdate.status, 200);
    const agentUpdate = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/config`,
      {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({
          personaPrompt: "DAEMON PRIVATE PERSONA",
          runtimeAdapter: "pi-owned-private",
        }),
      },
    );
    assert.equal(agentUpdate.status, 200);
    const configurationResponse = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/config`,
      { headers: { cookie, origin: "http://127.0.0.1:5174" } },
    );
    assert.equal(configurationResponse.status, 200);
    const configurationBody = await configurationResponse.json() as {
      rootConfigured: boolean;
      agents: Array<{ personaConfigured: boolean; runtimeConfigured: boolean; boundChannelCount: number }>;
    };
    assert.equal(configurationBody.rootConfigured, true);
    assert.deepEqual(configurationBody.agents, [{
      identityId: agent.id,
      configured: true,
      personaConfigured: true,
      runtimeConfigured: true,
      status: "active",
      boundChannelCount: 1,
      changesApplyToNewSessions: true,
    }]);
    assert.doesNotMatch(
      JSON.stringify(configurationBody),
      /new\/private|DAEMON PRIVATE PERSONA|pi-owned-private|rootUri|personaPrompt|runtimeAdapter/,
    );
    assert.doesNotMatch(
      JSON.stringify(audit),
      /new\/private|DAEMON PRIVATE PERSONA|pi-owned-private/,
    );

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
      capabilities: { start: false, steer: false, interrupt: false, reconnect: false },
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
