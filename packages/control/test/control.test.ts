import assert from "node:assert/strict";
import { createServer as createNodeServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ChannelClient } from "@minu/channels-core/client";
import { createChannelHttpServer } from "@minu/channels-core";
import type { ChannelMetadata } from "@minu/channels-core/types";
import { InMemoryRelayBindingStore } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHost, type ManagedRuntimeStartConfig } from "../src/agent-host.ts";
import { LocalControlClient, LocalControlClientError } from "../src/client.ts";
import { LocalAgentHostConfiguration, LocalConfigurationRequestError } from "../src/configuration.ts";
import { createLocalControlDaemon } from "../src/daemon.ts";
import { createLocalProductApp } from "../src/local.ts";
import {
  acquireChannelsDataDirectoryLock,
  prepareChannelsDataDirectory,
  resolveChannelsDataDirectory,
} from "../src/local-paths.ts";
import { createLocalWebServer } from "../src/local-web-server.ts";
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
  private readonly statuses = new Map<string, "idle" | "working">();

  async capabilities() {
    return {
      models: [{ provider: "openai", id: "gpt-managed", name: "Managed GPT", reasoning: true }],
      reasoningLevels: ["off", "medium", "high"] as Array<"off" | "medium" | "high">,
      skills: [{ id: "skill:review", name: "review", description: "Review changes" }],
    };
  }

  async start(config: ManagedRuntimeStartConfig): Promise<{ id: string }> {
    const sessionId = `managed-session-${this.starts.length + 1}`;
    this.starts.push({ sessionId, config: { ...config } });
    this.transcripts.set(sessionId, []);
    this.statuses.set(sessionId, "idle");
    return { id: sessionId };
  }

  async status(sessionId: string): Promise<"idle" | "working" | "offline"> {
    return this.transcripts.has(sessionId) ? this.statuses.get(sessionId) ?? "idle" : "offline";
  }

  setStatus(sessionId: string, status: "idle" | "working"): void {
    if (!this.transcripts.has(sessionId)) throw new Error("Unknown managed session");
    this.statuses.set(sessionId, status);
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
    this.statuses.delete(sessionId);
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
  assert.deepEqual(result.agents[0]?.capabilities, { start: false, replace: false, stop: false, steer: false, interrupt: false, reconnect: false });
  assert.deepEqual(result.agents[1]?.capabilities, { start: false, replace: false, stop: false, steer: false, interrupt: false, reconnect: false });

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

  assert.deepEqual(await client.health(), { status: "ok", protocolVersion: 8 });
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
    await requestStatus(`${server.endpoint}/local/health`, { host: "minu-channels.localhost:47411" }),
    200,
  );
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
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/;/);
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
  assert.deepEqual(await currentSession.json(), { protocolVersion: 8, identityId: "human-1" });

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

test("advertises the product-specific localhost name across control and browser ports", () => {
  const sessions = new LocalControlBrowserSessions({
    browserUrl: "http://minu-channels.localhost:47412/",
    currentHumanIdentityId: "human-product-host",
  });
  const launchUrl = new URL(sessions.issueLaunchUrl("http://127.0.0.1:47411"));
  assert.equal(launchUrl.origin, "http://minu-channels.localhost:47411");
  const exchange = sessions.exchangeLaunchCode(launchUrl.searchParams.get("code")!);
  assert.equal(exchange?.redirectUrl, "http://minu-channels.localhost:47412/");
  assert.match(exchange?.cookie ?? "", /minu_local_session=/);
});

test("authenticated folder selection supports root paths and cancellation", async () => {
  const sessions = new LocalControlBrowserSessions({
    browserUrl: "http://127.0.0.1:5174/",
    currentHumanIdentityId: "human-folder-test",
  });
  const service = new LocalControlService({
    channels: { async getChannel() { return channel; } },
    bindings: { async listChannelBindings() { return []; } },
    runtimes: {},
  });
  let selected: string | undefined = "/";
  const server = await createLocalControlHttpServer({
    service,
    port: 0,
    allowedOrigins: [sessions.browserOrigin],
    browserSessions: sessions,
    selectLocalFolder: async () => selected,
  });
  try {
    const bootstrap = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const headers = { cookie, origin: sessions.browserOrigin };
    const root = await fetch(`${server.endpoint}/local/folders/select`, { method: "POST", headers });
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { path: "/" });
    selected = undefined;
    assert.equal((await fetch(`${server.endpoint}/local/folders/select`, { method: "POST", headers })).status, 204);
    assert.equal((await fetch(`${server.endpoint}/local/folders/select`, { method: "POST" })).status, 401);
  } finally { await server.close(); }
});

test("review app seeds a disposable Workspace and authenticated presentation states", async () => {
  const app = await createLocalReviewApp({
    channelsPort: 0,
    controlPort: 0,
    webUrl: "http://127.0.0.1:5174/",
  });
  try {
    const client = new ChannelClient(app.channelsEndpoint, { serviceToken: app.channelsServiceToken });
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
      protocolVersion: 8,
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

test("local production web server serves the SPA and proxies product APIs", async () => {
  const webDirectory = await mkdtemp(join(tmpdir(), "minu-local-web-"));
  await mkdir(join(webDirectory, "assets"));
  await Promise.all([
    writeFile(join(webDirectory, "index.html"), "<main>MinuChannels production</main>"),
    writeFile(join(webDirectory, "assets", "app.js"), "console.log('minu')"),
  ]);
  const channelsBackend = createNodeServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ source: "channels", path: request.url }));
  });
  const controlBackend = createNodeServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ source: "control", origin: request.headers.origin }));
  });
  const listen = async (server: ReturnType<typeof createNodeServer>): Promise<string> => {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    return `http://127.0.0.1:${address.port}`;
  };
  const [channelsEndpoint, controlEndpoint] = await Promise.all([
    listen(channelsBackend),
    listen(controlBackend),
  ]);
  let browserAuthenticated = true;
  const web = await createLocalWebServer({
    channelsEndpoint,
    controlEndpoint,
    webDirectory,
    port: 0,
    channelsServiceToken: "web-test-token",
    authenticateBrowser: () => browserAuthenticated ? { identityId: "human-web-test" } : undefined,
  });
  try {
    assert.equal(await requestStatus(`${web.endpoint}/`, {
      host: "minu-channels.localhost:47412",
    }), 200);
    const spa = await fetch(`${web.endpoint}/app/workspaces/workspace/channels/channel`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /MinuChannels production/);
    const asset = await fetch(`${web.endpoint}/assets/app.js`);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(await asset.text(), /console\.log/);
    const channelsResponse = await (await fetch(`${web.endpoint}/identities`)).json() as { source: string };
    assert.equal(channelsResponse.source, "channels");
    browserAuthenticated = false;
    assert.equal((await fetch(`${web.endpoint}/identities`)).status, 401);
    browserAuthenticated = true;
    assert.equal((await fetch(`${web.endpoint}/identities`, { headers: { origin: "https://hostile.example" } })).status, 403);
    const controlResponse = await (await fetch(`${web.endpoint}/local/health`, {
      headers: { origin: web.endpoint },
    })).json() as { source: string; origin: string };
    assert.deepEqual(controlResponse, { source: "control" });
  } finally {
    await web.close();
    await Promise.all([
      new Promise<void>((resolveClose) => channelsBackend.close(() => resolveClose())),
      new Promise<void>((resolveClose) => controlBackend.close(() => resolveClose())),
      rm(webDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("resolves isolated Channels data paths and arbitrates product-directory locks", async () => {
  assert.equal(resolveChannelsDataDirectory({
    explicit: "~/explicit-channels",
    env: { MINU_CHANNELS_HOME: "/ignored-product", MINU_HOME: "/ignored-minu" },
    homeDirectory: "/home/tester",
  }), "/home/tester/explicit-channels");
  assert.equal(resolveChannelsDataDirectory({
    env: { MINU_CHANNELS_HOME: "/product-home", MINU_HOME: "/ignored-minu" },
    homeDirectory: "/home/tester",
  }), "/product-home");
  assert.equal(resolveChannelsDataDirectory({
    env: { MINU_HOME: "/shared-minu" },
    homeDirectory: "/home/tester",
  }), "/shared-minu/channels");
  assert.equal(resolveChannelsDataDirectory({ env: {}, homeDirectory: "/home/tester" }), "/home/tester/.minu/channels");

  const dataDirectory = await mkdtemp(join(tmpdir(), "minu-local-paths-"));
  try {
    await prepareChannelsDataDirectory(dataDirectory);
    const lock = await acquireChannelsDataDirectoryLock(dataDirectory);
    assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dataDirectory, "run"))).mode & 0o777, 0o700);
    assert.equal((await stat(lock.path)).mode & 0o777, 0o700);
    await assert.rejects(acquireChannelsDataDirectoryLock(dataDirectory), /already using data directory/);
    await lock.release();
    await writeFile(join(dataDirectory, "run", "instance.lock"), '{"pid":999999,"token":"stale"}\n');
    const replacement = await acquireChannelsDataDirectoryLock(dataDirectory);
    await replacement.release();

    const initializingPath = join(dataDirectory, "run", "instance.lock");
    await mkdir(initializingPath);
    await assert.rejects(acquireChannelsDataDirectoryLock(dataDirectory), /already using data directory/);
    assert.equal((await stat(initializingPath)).isDirectory(), true);
    await rm(initializingPath, { recursive: true });

    await mkdir(initializingPath);
    await writeFile(join(initializingPath, "owner.json"), '{"pid":999999,"token":"stale"}\n');
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
      acquireChannelsDataDirectoryLock(dataDirectory)));
    const winners = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    assert.equal(winners.length, 1);
    await winners[0]!.release();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("local product initializes once and reopens persistent collaboration data", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "minu-local-product-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "minu-local-workspace-"));
  const runtime = new ManagedFakeRuntime();
  let first: Awaited<ReturnType<typeof createLocalProductApp>> | undefined;
  let reopened: Awaited<ReturnType<typeof createLocalProductApp>> | undefined;
  try {
    first = await createLocalProductApp({
      dataDirectory,
      workspaceRoot,
      workspaceName: "Chosen Workspace",
      channelsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime,
    });
    assert.equal(first.initialized, true);
    const firstClient = new ChannelClient(first.channelsEndpoint, { serviceToken: first.channelsServiceToken });
    assert.equal((await firstClient.listIdentities()).length, 2);
    assert.deepEqual((await firstClient.listWorkspaces()).map(({ name }) => name), ["Chosen Workspace"]);
    assert.equal((await firstClient.listWorkspaceChannels(first.workspaceId!)).length, 1);
    assert.deepEqual(await firstClient.listMessages(first.channelId!), []);
    assert.equal((await stat(join(dataDirectory, "run", "instance.lock"))).mode & 0o777, 0o700);
    await assert.rejects(createLocalProductApp({
      dataDirectory,
      workspaceRoot,
      channelsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime,
    }), /already using data directory/);
    const original = {
      humanIdentityId: first.humanIdentityId,
      workspaceId: first.workspaceId,
      channelId: first.channelId,
    };
    await first.close();
    first = undefined;

    reopened = await createLocalProductApp({
      dataDirectory,
      workspaceRoot,
      selectWorkspaceRoot: true,
      channelsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime,
    });
    assert.equal(reopened.initialized, false);
    assert.deepEqual({
      humanIdentityId: reopened.humanIdentityId,
      workspaceId: reopened.workspaceId,
      channelId: reopened.channelId,
    }, original);
    const reopenedClient = new ChannelClient(reopened.channelsEndpoint, { serviceToken: reopened.channelsServiceToken });
    assert.equal((await reopenedClient.listIdentities()).length, 2);
    assert.equal((await reopenedClient.listWorkspaces()).length, 1);
    assert.equal((await stat(join(dataDirectory, "local-profile.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
  } finally {
    await first?.close().catch(() => undefined);
    await reopened?.close().catch(() => undefined);
    await Promise.all([
      rm(dataDirectory, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("fresh local product starts without a terminal Workspace and provisions it through browser control", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "minu-browser-first-product-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "minu-browser-first-workspace-"));
  let app: Awaited<ReturnType<typeof createLocalProductApp>> | undefined;
  try {
    app = await createLocalProductApp({
      dataDirectory,
      channelsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime: new ManagedFakeRuntime(),
    });
    assert.equal(app.initialized, true);
    assert.equal(app.workspaceId, undefined);
    assert.equal(app.channelId, undefined);
    const client = new ChannelClient(app.channelsEndpoint, { serviceToken: app.channelsServiceToken });
    assert.equal((await client.listIdentities()).length, 1);
    assert.deepEqual(await client.listWorkspaces(), []);

    const bootstrap = await fetch(app.issueBrowserLaunchUrl(), { redirect: "manual" });
    assert.equal(bootstrap.headers.get("location"), "http://127.0.0.1:5199/");
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const provisionedResponse = await fetch(`${app.controlEndpoint}/local/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "browser-first", name: "Browser First", rootUri: workspaceRoot }),
    });
    assert.equal(provisionedResponse.status, 201);
    const provisioned = await provisionedResponse.json() as { workspaceId: string; channelId: string };
    assert.deepEqual((await client.listWorkspaces()).map(({ id, name }) => ({ id, name })), [{
      id: provisioned.workspaceId,
      name: "Browser First",
    }]);
    assert.equal((await client.listWorkspaceChannels(provisioned.workspaceId))[0]?.id, provisioned.channelId);
  } finally {
    await app?.close().catch(() => undefined);
    await Promise.all([
      rm(dataDirectory, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("first-run initialization resumes after private-store setup fails", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "minu-local-recovery-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "minu-local-recovery-root-"));
  const options = {
    dataDirectory,
    workspaceRoot,
    workspaceName: "Recoverable Workspace",
    channelsPort: 0,
    controlPort: 0,
    runtimeAdapter: "managed-test",
    runtime: new ManagedFakeRuntime(),
  };
  try {
    await assert.rejects(createLocalProductApp({
      ...options,
      relayMigrationsFolder: join(dataDirectory, "missing-migrations"),
    }), /journal|migration/i);
    assert.equal((await stat(join(dataDirectory, "local-profile.json.initializing"))).isFile(), true);
    const recovered = await createLocalProductApp(options);
    try {
      const client = new ChannelClient(recovered.channelsEndpoint, { serviceToken: recovered.channelsServiceToken });
      assert.equal((await client.listIdentities()).length, 2);
      assert.equal((await client.listWorkspaces()).length, 1);
      assert.equal((await client.listWorkspaceChannels(recovered.workspaceId!)).length, 1);
    } finally { await recovered.close(); }
    await assert.rejects(stat(join(dataDirectory, "local-profile.json.initializing")), /ENOENT/);
  } finally {
    await Promise.all([rm(dataDirectory, { recursive: true, force: true }), rm(workspaceRoot, { recursive: true, force: true })]);
  }
});

test("Workspace provisioning validates first and resumes idempotently", async () => {
  const server = await createChannelHttpServer();
  const root = await mkdtemp(join(tmpdir(), "minu-provision-root-"));
  try {
    const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
    const owner = await client.createIdentity({ type: "human" });
    const store = new InMemoryRelayBindingStore();
    const configuration = new LocalAgentHostConfiguration({ client, store });
    await assert.rejects(configuration.provisionWorkspace(owner.id, {
      slug: "recoverable-provision", name: "Provisioned", rootUri: join(root, "missing"),
    }), /unavailable/);
    assert.equal((await client.listWorkspaces()).length, 0);
    const first = await configuration.provisionWorkspace(owner.id, {
      slug: "recoverable-provision", name: "Provisioned", rootUri: root,
    });
    const replay = await configuration.provisionWorkspace(owner.id, {
      slug: "recoverable-provision", name: "Provisioned", rootUri: root,
    });
    assert.deepEqual(replay, first);
    assert.equal((await client.listWorkspaces()).length, 1);
    assert.equal((await client.listWorkspaceChannels(first.workspaceId)).length, 1);
    assert.equal((await client.listWorkspaceMembers(first.workspaceId)).length, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("Runtime discovery is scoped by canonical Workspace source root", async () => {
  const server = await createChannelHttpServer();
  const firstRoot = await mkdtemp(join(tmpdir(), "minu-runtime-root-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "minu-runtime-root-b-"));
  try {
    const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
    const owner = await client.createIdentity({ type: "human" });
    const first = await client.createWorkspace({ slug: "runtime-root-a", name: "A" });
    const second = await client.createWorkspace({ slug: "runtime-root-b", name: "B" });
    for (const workspace of [first, second]) {
      await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
    }
    const store = new InMemoryRelayBindingStore();
    const seen: string[] = [];
    const configuration = new LocalAgentHostConfiguration({
      client,
      store,
      runtimeOptionsCacheTtlMs: 50,
      runtimes: { test: { async capabilities({ cwd } = {}) { seen.push(cwd!); return { models: [], reasoningLevels: [], skills: [] }; } } },
    });
    await configuration.updateWorkspaceConfiguration(first.id, owner.id, { rootUri: firstRoot });
    await configuration.updateWorkspaceConfiguration(second.id, owner.id, { rootUri: secondRoot });
    await configuration.getWorkspaceRuntimeOptions(first.id, "test", owner.id);
    await configuration.getWorkspaceRuntimeOptions(second.id, "test", owner.id);
    assert.deepEqual(seen, [await realpath(firstRoot), await realpath(secondRoot)]);
    await configuration.getWorkspaceRuntimeOptions(first.id, "test", owner.id);
    assert.equal(seen.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await configuration.getWorkspaceRuntimeOptions(first.id, "test", owner.id);
    assert.equal(seen.length, 3);
    await configuration.updateWorkspaceConfiguration(first.id, owner.id, { rootUri: secondRoot });
    await configuration.getWorkspaceRuntimeOptions(first.id, "test", owner.id);
    assert.deepEqual(seen.at(-1), await realpath(secondRoot));
  } finally {
    await server.close();
    await Promise.all([rm(firstRoot, { recursive: true, force: true }), rm(secondRoot, { recursive: true, force: true })]);
  }
});

test("private configuration authorizes current humans and returns only redacted state", async () => {
  const channelServer = await createChannelHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const audit: LocalControlAuditEvent[] = [];
  try {
    const client = new ChannelClient(channelServer.endpoint, { serviceToken: channelServer.serviceToken });
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
      rootUri: process.cwd(),
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
        modelProvider: "openai-private",
        modelId: "gpt-private",
        reasoningLevel: "high",
      },
    );

    assert.equal(summary.rootConfigured, true);
    assert.deepEqual(summary.agents, [{
      identityId: agent.id,
      configured: true,
      personaConfigured: true,
      runtimeConfigured: true,
      modelConfigured: true,
      reasoningConfigured: true,
      skillsConfigured: false,
      selectedSkillCount: 0,
      status: "active",
      boundChannelCount: 0,
      changesApplyToNewSessions: true,
    }]);
    assert.equal((await store.getWorkspaceConfig(workspace.id))?.rootUri, pathToFileURL(await realpath(process.cwd())).href);
    const storedAgent = await store.getWorkspaceAgentConfig(workspace.id, agent.id);
    assert.equal(storedAgent?.personaPrompt, "PRIVATE PERSONA: build and verify carefully");
    assert.equal(storedAgent?.runtimeAdapter, "pi-owned");
    assert.equal(storedAgent?.modelProvider, "openai-private");
    assert.equal(storedAgent?.modelId, "gpt-private");
    assert.equal(storedAgent?.reasoningLevel, "high");
    const presented = JSON.stringify(summary);
    assert.doesNotMatch(
      presented,
      /private\/source|private-notes-folder|PRIVATE PERSONA|pi-owned|openai-private|gpt-private|personaPrompt|runtimeAdapter|modelProvider|modelId|reasoningLevel|rootUri/,
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
  const sourceDirectory = await realpath(await mkdtemp(join(tmpdir(), "minu-agent-host-source-")));
  const channelServer = await createChannelHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const runtime = new ManagedFakeRuntime();
  const audit: LocalControlAuditEvent[] = [];
  let host: LocalAgentHost | undefined;
  let restoredHost: LocalAgentHost | undefined;
  try {
    const client = new ChannelClient(channelServer.endpoint, { serviceToken: channelServer.serviceToken });
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
    const configuration = new LocalAgentHostConfiguration({ client, store, runtimes: { "managed-test": runtime } });
    await configuration.updateWorkspaceConfiguration(workspace.id, owner.id, {
      rootUri: sourceDirectory,
    });
    await configuration.updateWorkspaceAgentConfiguration(workspace.id, agent.id, owner.id, {
      personaPrompt: "PRIVATE MANAGED PERSONA",
      runtimeAdapter: "managed-test",
      modelProvider: "openai",
      modelId: "gpt-managed",
      reasoningLevel: "high",
      skillIds: ["skill:review"],
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
      {
        cwd: sourceDirectory,
        appendSystemPrompt: "PRIVATE MANAGED PERSONA",
        model: { provider: "openai", id: "gpt-managed" },
        reasoningLevel: "high",
        skillIds: ["skill:review"],
      },
      {
        cwd: sourceDirectory,
        appendSystemPrompt: "PRIVATE MANAGED PERSONA",
        model: { provider: "openai", id: "gpt-managed" },
        reasoningLevel: "high",
        skillIds: ["skill:review"],
      },
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
      onAudit: (event) => audit.push(event),
    });
    await restoredHost.restore();
    await client.postMessage(channelA.id, {
      participantId: owner.id,
      body: "@builder resume only A",
    });
    await waitUntil(async () => (await client.listMessages(channelA.id)).length === 5);
    assert.equal(await store.getCursor(channelA.id, agent.id), 4);

    runtime.setStatus("managed-session-1", "working");
    await assert.rejects(
      restoredHost.replaceChannelAgent(channelA.id, agent.id, owner.id),
      /active agent work/,
    );
    assert.equal(runtime.starts.length, 2);
    runtime.setStatus("managed-session-1", "idle");
    await restoredHost.replaceChannelAgent(channelA.id, agent.id, owner.id);
    let binding = (await store.listChannelBindings(channelA.id))[0]!;
    assert.equal(binding.generation, 2);
    assert.equal(binding.runtimeSessionId, "managed-session-3");
    assert.equal(await runtime.status("managed-session-1"), "offline");
    await client.postMessage(channelA.id, {
      participantId: owner.id,
      body: "@builder replaced session work",
    });
    await waitUntil(async () => (await client.listMessages(channelA.id)).length === 7);
    assert.match((await client.listMessages(channelA.id))[6]?.body ?? "", /managed-session-3/);

    runtime.setStatus("managed-session-3", "working");
    await restoredHost.stopChannelAgent(channelA.id, agent.id, owner.id);
    binding = (await store.listChannelBindings(channelA.id))[0]!;
    assert.equal(binding.state, "disabled");
    assert.equal(binding.generation, 3);
    assert.equal(await runtime.status("managed-session-3"), "offline");
    await client.postMessage(channelA.id, {
      participantId: owner.id,
      body: "@builder stopped work must not run",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.equal((await client.listMessages(channelA.id)).length, 8);

    await restoredHost.replaceChannelAgent(channelA.id, agent.id, owner.id);
    binding = (await store.listChannelBindings(channelA.id))[0]!;
    assert.equal(binding.state, "connected");
    assert.equal(binding.generation, 4);
    assert.equal(binding.runtimeSessionId, "managed-session-4");
    await client.postMessage(channelA.id, {
      participantId: owner.id,
      body: "@builder restarted work only",
    });
    await waitUntil(async () => (await client.listMessages(channelA.id)).length === 10);
    assert.match((await client.listMessages(channelA.id))[9]?.body ?? "", /managed-session-4/);
    assert.equal(await store.getCursor(channelA.id, agent.id), 9);
    assert.doesNotMatch(
      JSON.stringify(audit),
      /PRIVATE MANAGED PERSONA|managed-session|agent-host-source/,
    );
    assert.deepEqual(audit.map(({ action, outcome }) => ({ action, outcome })), [
      { action: "agent.session.started", outcome: "rejected" },
      { action: "agent.session.started", outcome: "accepted" },
      { action: "agent.session.started", outcome: "accepted" },
      { action: "agent.session.replaced", outcome: "rejected" },
      { action: "agent.session.replaced", outcome: "accepted" },
      { action: "agent.session.stopped", outcome: "accepted" },
      { action: "agent.session.replaced", outcome: "accepted" },
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
    const client = new ChannelClient(channelServer.endpoint, { serviceToken: channelServer.serviceToken });
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
      channelsServiceToken: channelServer.serviceToken,
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
        "pi-owned-private": {
          async status() {
            return "offline";
          },
          async capabilities() {
            return {
              models: [{ provider: "openai", id: "gpt-private", name: "Private GPT", reasoning: true }],
              reasoningLevels: ["off", "medium", "high"] as Array<"off" | "medium" | "high">,
              skills: [{ id: "skill:review", name: "review", description: "Review changes" }],
            };
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
      body: JSON.stringify({ rootUri: directory }),
    });
    assert.equal(workspaceUpdate.status, 200);
    const unavailableWorkspaceUpdate = await fetch(`${daemon.endpoint}/local/workspaces/${workspace.id}/config`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ rootUri: join(directory, "missing") }),
    });
    assert.equal(unavailableWorkspaceUpdate.status, 409);
    assert.match((await unavailableWorkspaceUpdate.json() as { error: string }).error, /Source folder is unavailable/);
    const relativeWorkspaceUpdate = await fetch(`${daemon.endpoint}/local/workspaces/${workspace.id}/config`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ rootUri: "relative/source" }),
    });
    assert.equal(relativeWorkspaceUpdate.status, 400);
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
    const workspaceRuntimeOptionsResponse = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/runtime-options?adapter=pi-owned-private`,
      { headers: requestHeaders },
    );
    assert.equal(workspaceRuntimeOptionsResponse.status, 200);
    assert.deepEqual(await workspaceRuntimeOptionsResponse.json(), {
      protocolVersion: 8,
      workspaceId: workspace.id,
      models: [{ provider: "openai", id: "gpt-private", name: "Private GPT", reasoning: true, enabled: true }],
      reasoningLevels: ["off", "medium", "high"],
      modelPolicyConfigured: false,
      skills: [{ id: "skill:review", name: "review", description: "Review changes" }],
    });
    const runtimeOptionsResponse = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/runtime-options`,
      { headers: requestHeaders },
    );
    assert.equal(runtimeOptionsResponse.status, 200);
    assert.deepEqual(await runtimeOptionsResponse.json(), {
      protocolVersion: 8,
      workspaceId: workspace.id,
      identityId: agent.id,
      models: [{ provider: "openai", id: "gpt-private", name: "Private GPT", reasoning: true, enabled: true }],
      reasoningLevels: ["off", "medium", "high"],
      modelPolicyConfigured: false,
      skills: [{ id: "skill:review", name: "review", description: "Review changes" }],
      skillSelectionConfigured: false,
      selectedSkillIds: [],
    });
    const policyResponse = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/runtime-options`,
      {
        method: "PUT",
        headers: requestHeaders,
        body: JSON.stringify({ enabledModels: [] }),
      },
    );
    assert.equal(policyResponse.status, 200);
    const policy = await policyResponse.json() as {
      modelPolicyConfigured: boolean;
      models: Array<{ enabled: boolean }>;
    };
    assert.equal(policy.modelPolicyConfigured, true);
    assert.deepEqual(policy.models.map((model) => model.enabled), [false]);
    const unavailablePolicyResponse = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/runtime-options`,
      {
        method: "PUT",
        headers: requestHeaders,
        body: JSON.stringify({ enabledModels: [{ provider: "unknown", id: "missing" }] }),
      },
    );
    assert.equal(unavailablePolicyResponse.status, 400);
    const disabledModelUpdate = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/config`,
      {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({ modelProvider: "openai", modelId: "gpt-private" }),
      },
    );
    assert.equal(disabledModelUpdate.status, 409);
    const workspaceUpdateAfterPolicy = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/config`,
      {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({ rootUri: directory }),
      },
    );
    assert.equal(workspaceUpdateAfterPolicy.status, 200);
    const policyAfterWorkspaceUpdate = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/runtime-options`,
      { headers: requestHeaders },
    );
    const preservedPolicy = await policyAfterWorkspaceUpdate.json() as {
      modelPolicyConfigured: boolean;
      models: Array<{ enabled: boolean }>;
    };
    assert.equal(preservedPolicy.modelPolicyConfigured, true);
    assert.deepEqual(preservedPolicy.models.map((model) => model.enabled), [false]);
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
      modelConfigured: false,
      reasoningConfigured: false,
      skillsConfigured: false,
      selectedSkillCount: 0,
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
      capabilities: { start: false, replace: false, stop: false, steer: false, interrupt: false, reconnect: false },
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
