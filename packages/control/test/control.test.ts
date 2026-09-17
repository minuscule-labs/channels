import assert from "node:assert/strict";
import { createServer as createNodeServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ConversationClient } from "@minu/channels-core/client";
import { createConversationHttpServer } from "@minu/channels-core";
import type { ConversationMetadata } from "@minu/channels-core/types";
import { InMemoryRelayBindingStore } from "@minu/channels-relay";
import { DrizzleLibSqlRelayStorage, localRelayLibSqlUrl } from "@minu/channels-relay-storage-drizzle";
import {
  LocalAgentHost,
  type LocalAgentHostDiagnosticEvent,
  type ManagedRuntimeStartConfig,
} from "../src/agent-host.ts";
import { LocalControlClient, LocalControlClientError } from "../src/client.ts";
import { LocalAgentHostConfiguration, LocalConfigurationRequestError } from "../src/configuration.ts";
import { createLocalControlDaemon } from "../src/daemon.ts";
import { developmentDataDirectory, resetDevelopmentData } from "../src/dev-data.ts";
import { createLocalProductApp } from "../src/local.ts";
import {
  acquireConversationsDataDirectoryLock,
  prepareConversationsDataDirectory,
  resolveConversationsDataDirectory,
} from "../src/local-paths.ts";
import { createLocalWebServer } from "../src/local-web-server.ts";
import { createLocalReviewApp } from "../src/review.ts";
import {
  createLocalControlHttpServer,
  LocalControlBrowserSessions,
  LocalControlService,
  type LocalControlAuditEvent,
  type LocalControlBindingRecord,
  type LocalControlRuntimePort,
} from "../src/server.ts";

const conversation: ConversationMetadata = {
  id: "conversation-1",
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
  readonly stops: string[] = [];
  readonly interruptions: string[] = [];
  private readonly transcripts = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
  private readonly statuses = new Map<string, "idle" | "working" | "offline">();
  private readonly statusFailures = new Map<string, Error[]>();
  private readonly heldSends = new Map<string, { entered: Promise<void>; enter(): void; release: Promise<void>; complete(): void }>();
  private readonly heldStatuses = new Map<string, { entered: Promise<void>; enter(): void; release: Promise<void>; complete(): void }>();

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
    const failures = this.statusFailures.get(sessionId);
    const failure = failures?.shift();
    if (failures?.length === 0) this.statusFailures.delete(sessionId);
    if (failure) throw failure;
    const held = this.heldStatuses.get(sessionId);
    if (held) {
      held.enter();
      await held.release;
      this.heldStatuses.delete(sessionId);
    }
    return this.transcripts.has(sessionId) ? this.statuses.get(sessionId) ?? "idle" : "offline";
  }

  failNextStatus(sessionId: string, error: Error): void {
    this.statusFailures.set(sessionId, [...(this.statusFailures.get(sessionId) ?? []), error]);
  }

  holdStatus(sessionId: string) {
    const held = this.hold();
    this.heldStatuses.set(sessionId, held);
    return { entered: held.entered, release: held.complete };
  }

  holdSend(sessionId: string) {
    const held = this.hold();
    this.heldSends.set(sessionId, held);
    return { entered: held.entered, release: held.complete };
  }

  setStatus(sessionId: string, status: "idle" | "working" | "offline"): void {
    if (!this.transcripts.has(sessionId)) throw new Error("Unknown managed session");
    this.statuses.set(sessionId, status);
  }

  async send(sessionId: string, input: string): Promise<void> {
    const transcript = this.transcripts.get(sessionId);
    if (!transcript) throw new Error("Unknown managed session");
    const prompts = this.prompts.get(sessionId) ?? [];
    prompts.push(input);
    this.prompts.set(sessionId, prompts);
    transcript.push({ role: "user", content: input });
    this.statuses.set(sessionId, "working");
    const held = this.heldSends.get(sessionId);
    if (held) {
      held.enter();
      await held.release;
      this.heldSends.delete(sessionId);
    }
    transcript.push({ role: "assistant", content: `Genuine managed response from ${sessionId}` });
    this.statuses.set(sessionId, "idle");
  }

  async messages(sessionId: string) {
    return (this.transcripts.get(sessionId) ?? []).map((message) => ({ ...message }));
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interruptions.push(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    this.stops.push(sessionId);
    this.transcripts.delete(sessionId);
    this.statuses.delete(sessionId);
  }

  private hold() {
    let enter!: () => void;
    let complete!: () => void;
    return {
      entered: new Promise<void>((resolve) => { enter = resolve; }),
      enter: () => enter(),
      release: new Promise<void>((resolve) => { complete = resolve; }),
      complete: () => complete(),
    };
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
    conversations: {
      async getConversation(conversationId) {
        assert.equal(conversationId, conversation.id);
        return conversation;
      },
    },
    bindings: { async listConversationBindings() { return records; } },
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

test("projects private bindings into presentation-safe Conversation agent status", async () => {
  const { control, statusCalls } = service();
  const result = await control.listConversationAgents(conversation.id);

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

test("Conversation snooze and settle fence admission and require managed agents to be idle", async () => {
  const managedConversation: ConversationMetadata = {
    ...conversation,
    participants: [conversation.participants[0]!, conversation.participants[1]!],
  };
  const binding: LocalControlBindingRecord = { ...records[0]! };
  let runtimeStatus: "idle" | "working" = "idle";
  let stopped = 0;
  let fenced = 0;
  let cleared = 0;
  const updates: Array<{ state: string; snoozedUntil?: string }> = [];
  const control = new LocalControlService({
    conversations: {
      async getConversation() { return managedConversation; },
      async getConversationLifecycle() { return { state: "active" }; },
      async updateConversationLifecycle(_conversationId, input) {
        updates.push({ state: input.state, snoozedUntil: input.snoozedUntil });
        return input.state === "snoozed"
          ? { state: "snoozed", snoozedUntil: input.snoozedUntil }
          : { state: input.state };
      },
    },
    bindings: { async listConversationBindings() { return [binding]; } },
    runtimes: { "pi-private-adapter": { async status() { return runtimeStatus; } } },
    lifecycle: {
      available: true,
      fenceConversationAdmission() { fenced += 1; return () => { fenced -= 1; }; },
      clearConversationAdmissionFence() { cleared += 1; },
      async startConversationAgent() {},
      async replaceConversationAgent() {},
      async stopConversationAgent() { stopped += 1; binding.state = "disabled"; },
      async cancelCurrentConversationAgent() {},
    },
  });
  const snoozedUntil = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(await control.updateConversationLifecycle(managedConversation.id, "human-1", {
    state: "snoozed", snoozedUntil,
  }), { state: "snoozed", snoozedUntil });
  assert.equal(stopped, 1);
  assert.equal(fenced, 1);
  assert.deepEqual(updates, [{ state: "snoozed", snoozedUntil }]);

  assert.deepEqual(await control.updateConversationLifecycle(managedConversation.id, "human-1", {
    state: "active",
  }), { state: "active" });
  assert.equal(cleared, 1);
  binding.state = "connected";
  runtimeStatus = "working";
  await assert.rejects(control.updateConversationLifecycle(managedConversation.id, "human-1", {
    state: "settled",
  }), /must be idle or stopped/);
  assert.equal(fenced, 1);
  assert.equal(updates.length, 2);
});

test("projects Relay activity and accepts cancellation without exposing Runtime details", async () => {
  let cancelCalls = 0;
  const control = new LocalControlService({
    conversations: { async getConversation() { return { ...conversation, participants: [conversation.participants[1]!] }; } },
    bindings: { async listConversationBindings() { return records; } },
    runtimes: {
      "pi-private-adapter": {
        async status() { return "working" as const; },
        async sessionCapabilities() {
          return {
            version: 1 as const,
            safeActivityEvents: true,
            interrupt: true,
            reconnectExisting: true,
            interactiveAttach: false,
            openDiagnostic: false,
            liveSkillVerification: false,
          };
        },
        async interrupt() {},
      },
    },
    lifecycle: {
      available: true,
      async startConversationAgent() {},
      async replaceConversationAgent() {},
      async stopConversationAgent() {},
      async cancelCurrentConversationAgent() { cancelCalls += 1; },
      activity() {
        return {
          phase: "running",
          triggerMessageId: "message-public-id",
          triggerSequence: 37,
          startedAt: "2026-08-28T00:00:00.000Z",
          queuedTurns: 2,
          queuedTurnsExact: false,
          privateToolName: "SECRET_TOOL_NAME",
          prompt: "SECRET_PROMPT",
          providerPayload: "SECRET_PROVIDER_PAYLOAD",
        };
      },
    },
  });
  const result = await control.listConversationAgents(conversation.id);
  assert.deepEqual(result.agents[0]?.activity, {
    phase: "running",
    triggerMessageId: "message-public-id",
    triggerSequence: 37,
    startedAt: "2026-08-28T00:00:00.000Z",
    queuedTurns: 2,
    queuedTurnsExact: false,
  });
  assert.equal(result.agents[0]?.capabilities.interrupt, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /runtime-session-secret|pi-private-adapter|SECRET_TOOL_NAME|SECRET_PROMPT|SECRET_PROVIDER_PAYLOAD/,
  );
  await control.cancelCurrentConversationAgent(conversation.id, "agent-running", "human-1");
  assert.equal(cancelCalls, 1);
});

test("projects verified live capabilities and treats missing or failed queries as not verified", async () => {
  const verified = {
    version: 1 as const,
    safeActivityEvents: true,
    interrupt: true,
    reconnectExisting: true,
    interactiveAttach: false,
    openDiagnostic: false,
    liveSkillVerification: false,
  };
  const lifecycle = {
    available: true,
    async startConversationAgent() {}, async replaceConversationAgent() {}, async stopConversationAgent() {},
    async reconnectConversationAgent() {}, async cancelCurrentConversationAgent() {},
    isAttached() { return false; },
  };
  const createControl = (runtime: LocalControlRuntimePort) => new LocalControlService({
    conversations: { async getConversation() { return { ...conversation, participants: [conversation.participants[1]!] }; } },
    bindings: { async listConversationBindings() { return records; } },
    runtimes: { "pi-private-adapter": runtime },
    lifecycle,
    statusTimeoutMs: 10,
  });

  const available = await createControl({
    async status() { return "idle"; },
    async sessionCapabilities() {
      return { ...verified, privateProvider: "SECRET_PROVIDER" };
    },
  }).listConversationAgents(conversation.id);
  assert.equal(available.agents[0]?.state, "disconnected");
  assert.equal(available.agents[0]?.capabilities.reconnect, true);
  assert.deepEqual(available.agents[0]?.diagnostics?.capabilities, {
    safeActivityEvents: "available",
    interrupt: "available",
    reconnectExisting: "available",
    interactiveAttach: "unavailable",
    openDiagnostic: "unavailable",
    liveSkillVerification: "unavailable",
  });
  assert.doesNotMatch(JSON.stringify(available), /SECRET_PROVIDER|privateProvider/);

  const absent = await createControl({ async status() { return "idle"; } })
    .listConversationAgents(conversation.id);
  assert.equal(absent.agents[0]?.capabilities.reconnect, false);
  assert.deepEqual(
    new Set(Object.values(absent.agents[0]!.diagnostics!.capabilities)),
    new Set(["not_verified"]),
  );

  const failed = await createControl({
    async status() { return "idle"; },
    async sessionCapabilities() { throw new Error("SECRET_CAPABILITY_TRANSPORT"); },
  }).listConversationAgents(conversation.id);
  assert.deepEqual(
    new Set(Object.values(failed.agents[0]!.diagnostics!.capabilities)),
    new Set(["not_verified"]),
  );
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_CAPABILITY_TRANSPORT/);

  const malformed = await createControl({
    async status() { return "idle"; },
    async sessionCapabilities() { return { ...verified, version: 2 as 1 }; },
  }).listConversationAgents(conversation.id);
  assert.deepEqual(
    new Set(Object.values(malformed.agents[0]!.diagnostics!.capabilities)),
    new Set(["not_verified"]),
  );

  const timeoutStartedAt = Date.now();
  const timedOut = await createControl({
    async status() { return "idle"; },
    async sessionCapabilities() { return await new Promise<never>(() => {}); },
  }).listConversationAgents(conversation.id);
  assert.ok(Date.now() - timeoutStartedAt < 500);
  assert.deepEqual(
    new Set(Object.values(timedOut.agents[0]!.diagnostics!.capabilities)),
    new Set(["not_verified"]),
  );
});

test("distinguishes failed and stalled Runtime verification from confirmed offline without leaking errors", async () => {
  const control = new LocalControlService({
    conversations: { async getConversation() { return { ...conversation, participants: [conversation.participants[1]!] }; } },
    bindings: { async listConversationBindings() { return records; } },
    runtimes: {
      "pi-private-adapter": { async status() { throw new Error("credential: secret-token"); } },
    },
  });
  const result = await control.listConversationAgents(conversation.id);
  assert.equal(result.agents[0]?.state, "uncertain");
  assert.equal(result.agents[0]?.diagnostics?.connection, "uncertain");
  assert.equal(result.agents[0]?.capabilities.replace, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|credential/);

  const stalled = new LocalControlService({
    conversations: { async getConversation() { return { ...conversation, participants: [conversation.participants[1]!] }; } },
    bindings: { async listConversationBindings() { return records; } },
    runtimes: { "pi-private-adapter": { async status() { return new Promise<"idle">(() => {}); } } },
    statusTimeoutMs: 1,
  });
  assert.equal((await stalled.listConversationAgents(conversation.id)).agents[0]?.state, "uncertain");

  const offline = new LocalControlService({
    conversations: { async getConversation() { return { ...conversation, participants: [conversation.participants[1]!] }; } },
    bindings: { async listConversationBindings() { return records; } },
    runtimes: { "pi-private-adapter": { async status() { return "offline" as const; } } },
  });
  const offlineAgent = (await offline.listConversationAgents(conversation.id)).agents[0]!;
  assert.equal(offlineAgent.state, "offline");
  assert.deepEqual(
    new Set(Object.values(offlineAgent.diagnostics!.capabilities)),
    new Set(["unavailable"]),
  );
});

test("validates browser identity and bounded client and Runtime status options", () => {
  assert.throws(() => new LocalControlBrowserSessions({
    browserUrl: "http://127.0.0.1:5174/",
    currentHumanIdentityId: "   ",
  }), /currentHumanIdentityId/);
  assert.throws(() => new LocalControlClient("", { timeoutMs: 0 }), /positive integer/);
  assert.throws(() => new LocalControlClient("", { lifecycleTimeoutMs: 0 }), /positive integer/);
  assert.throws(() => new LocalControlService({
    conversations: { async getConversation() { return conversation; } },
    bindings: { async listConversationBindings() { return []; } },
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

  assert.deepEqual(await client.health(), { status: "ok", protocolVersion: 17 });
  assert.equal((await client.capabilities()).features.currentSession, true);
  assert.equal((await client.capabilities()).features.agentStart, false);
  assert.equal((await client.capabilities()).features.steer, false);
  const agents = await client.listConversationAgents(conversation.id);
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
    () => new LocalControlClient(server.endpoint).listConversationAgents("missing"),
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
  const launchUrl = sessions.issueLaunchUrl(server.endpoint, "/app/workspaces/workspace-1/conversations/conversation-1");
  const bootstrap = await fetch(launchUrl, { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  assert.equal(
    bootstrap.headers.get("location"),
    "http://127.0.0.1:5174/app/workspaces/workspace-1/conversations/conversation-1",
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
  assert.deepEqual(await currentSession.json(), { protocolVersion: 17, identityId: "human-1" });

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

test("accepts authenticated local session actions with opaque diagnostic responses", async (context) => {
  let cancelCalls = 0;
  let diagnosticCalls = 0;
  const reconnectActors: string[] = [];
  const sessions = new LocalControlBrowserSessions({
    browserUrl: "http://127.0.0.1:5174/",
    currentHumanIdentityId: "human-1",
  });
  const control = new LocalControlService({
    conversations: { async getConversation() { return { ...conversation, participants: [conversation.participants[1]!] }; } },
    bindings: { async listConversationBindings() { return records; } },
    runtimes: { "pi-private-adapter": { async status() { return "working" as const; }, async interrupt() {} } },
    lifecycle: {
      available: true,
      async startConversationAgent() {}, async replaceConversationAgent() {}, async stopConversationAgent() {},
      async reconnectConversationAgent(_conversationId, _identityId, actorIdentityId) { reconnectActors.push(actorIdentityId); },
      async cancelCurrentConversationAgent() { cancelCalls += 1; },
      async openConversationAgentDiagnostic() { diagnosticCalls += 1; },
      activity() {
        return {
          phase: "canceling", triggerMessageId: "message-37", triggerSequence: 37,
          startedAt: "2026-08-28T00:00:00.000Z", queuedTurns: 0, queuedTurnsExact: true,
        };
      },
    },
  });
  const server = await createLocalControlHttpServer({
    service: control,
    port: 0,
    allowedOrigins: [sessions.browserOrigin],
    browserSessions: sessions,
  });
  context.after(() => server.close());
  const endpoint = `/local/conversations/${conversation.id}/agents/agent-running/cancel-current`;
  assert.equal((await fetch(`${server.endpoint}${endpoint}`, { method: "POST" })).status, 401);
  const launch = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = launch.headers.get("set-cookie")!.split(";", 1)[0]!;
  const response = await fetch(`${server.endpoint}${endpoint}`, {
    method: "POST",
    headers: { cookie, origin: sessions.browserOrigin },
  });
  assert.equal(response.status, 202);
  assert.equal(cancelCalls, 1);
  const body = await response.json() as { agent: { activity?: { phase: string } } };
  assert.equal(body.agent.activity?.phase, "canceling");

  const reconnectEndpoint = `/local/conversations/${conversation.id}/agents/agent-running/reconnect`;
  assert.equal((await fetch(`${server.endpoint}${reconnectEndpoint}`, { method: "POST" })).status, 401);
  const reconnected = await fetch(`${server.endpoint}${reconnectEndpoint}`, {
    method: "POST",
    headers: { cookie, origin: sessions.browserOrigin },
  });
  assert.equal(reconnected.status, 200);
  assert.deepEqual(reconnectActors, ["human-1"]);

  const diagnosticEndpoint = `/local/conversations/${conversation.id}/agents/agent-running/open-diagnostic`;
  assert.equal((await fetch(`${server.endpoint}${diagnosticEndpoint}`, { method: "POST" })).status, 401);
  const opened = await fetch(`${server.endpoint}${diagnosticEndpoint}`, {
    method: "POST",
    headers: { cookie, origin: sessions.browserOrigin },
  });
  assert.equal(opened.status, 202);
  assert.deepEqual(await opened.json(), { protocolVersion: 17, status: "opened" });
  assert.equal(diagnosticCalls, 1);
});

test("authenticated control responses allowlist activity and sanitize lifecycle and status failures", async (context) => {
  const secret = "SECRET_RUNTIME_ID_ENDPOINT_TOKEN_PROMPT_TOOL_PROVIDER_PATH";
  let exposeActivity = true;
  const sessions = new LocalControlBrowserSessions({
    browserUrl: "http://127.0.0.1:5174/",
    currentHumanIdentityId: "human-1",
  });
  const fail = async (): Promise<void> => { throw new Error(secret); };
  const control = new LocalControlService({
    conversations: { async getConversation() { return { ...conversation, participants: [conversation.participants[1]!] }; } },
    bindings: { async listConversationBindings() { return records; } },
    runtimes: { "pi-private-adapter": { async status() { throw new Error(secret); } } },
    lifecycle: {
      available: true,
      startConversationAgent: fail,
      replaceConversationAgent: fail,
      stopConversationAgent: fail,
      reconnectConversationAgent: fail,
      cancelCurrentConversationAgent: fail,
      openConversationAgentDiagnostic: fail,
      activity() {
        if (!exposeActivity) return undefined;
        return {
          phase: "using_tools" as const,
          triggerMessageId: "message-public",
          triggerSequence: 9,
          startedAt: "2026-08-28T00:00:00.000Z",
          queuedTurns: 1,
          queuedTurnsExact: false,
          runtimeSessionId: secret,
          toolName: secret,
          providerPayload: secret,
          rawError: secret,
        };
      },
    },
  });
  const server = await createLocalControlHttpServer({
    service: control,
    port: 0,
    allowedOrigins: [sessions.browserOrigin],
    browserSessions: sessions,
  });
  context.after(() => server.close());
  const launch = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = launch.headers.get("set-cookie")!.split(";", 1)[0]!;
  const headers = { cookie, origin: sessions.browserOrigin };
  const agentsPath = `/local/conversations/${conversation.id}/agents`;

  const activeResponse = await fetch(`${server.endpoint}${agentsPath}`, { headers });
  assert.equal(activeResponse.status, 200);
  const activeBody = await activeResponse.json() as { agents: Array<{ activity: Record<string, unknown> }> };
  assert.deepEqual(activeBody.agents[0]?.activity, {
    phase: "using_tools",
    triggerMessageId: "message-public",
    triggerSequence: 9,
    startedAt: "2026-08-28T00:00:00.000Z",
    queuedTurns: 1,
    queuedTurnsExact: false,
  });
  assert.doesNotMatch(JSON.stringify(activeBody), new RegExp(secret));

  exposeActivity = false;
  const uncertainResponse = await fetch(`${server.endpoint}${agentsPath}`, { headers });
  assert.equal(uncertainResponse.status, 200);
  const uncertainBody = await uncertainResponse.json();
  assert.doesNotMatch(JSON.stringify(uncertainBody), new RegExp(secret));
  assert.equal((uncertainBody as { agents: Array<{ state: string }> }).agents[0]?.state, "uncertain");

  for (const action of ["start", "reconnect", "replace", "stop", "cancel-current", "open-diagnostic"]) {
    const response = await fetch(
      `${server.endpoint}${agentsPath}/agent-running/${action}`,
      { method: "POST", headers },
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Local control status unavailable" });
  }
});

test("serves authenticated bulk lifecycle partial results", async (context) => {
  const sessions = new LocalControlBrowserSessions({
    browserUrl: "http://127.0.0.1:5174/",
    currentHumanIdentityId: "human-bulk",
  });
  const calls: string[] = [];
  const control = new LocalControlService({
    conversations: { async getConversation() { return conversation; } },
    bindings: { async listConversationBindings() { return []; } },
    runtimes: {},
    lifecycle: {
      available: true,
      async startConversationAgent() {}, async replaceConversationAgent() {}, async stopConversationAgent() {},
      async cancelCurrentConversationAgent() {},
      async startAllConversationAgents(conversationId, actorIdentityId) {
        calls.push(`start:${conversationId}:${actorIdentityId}`);
        return [
          { identityId: "agent-a", outcome: "started" },
          { identityId: "agent-b", outcome: "skipped", reason: "unconfigured" },
        ];
      },
      async stopAllConversationAgents(conversationId, actorIdentityId) {
        calls.push(`stop:${conversationId}:${actorIdentityId}`);
        return [{ identityId: "agent-a", outcome: "stopped" }];
      },
    },
  });
  const server = await createLocalControlHttpServer({
    service: control,
    port: 0,
    allowedOrigins: [sessions.browserOrigin],
    browserSessions: sessions,
  });
  context.after(() => server.close());
  const launch = await fetch(sessions.issueLaunchUrl(server.endpoint), { redirect: "manual" });
  const cookie = launch.headers.get("set-cookie")!.split(";", 1)[0]!;
  const request = (action: "start" | "stop") => fetch(
    `${server.endpoint}/local/conversations/${conversation.id}/agents/${action}-all`,
    { method: "POST", headers: { cookie, origin: sessions.browserOrigin } },
  );
  assert.equal((await request("start")).status, 200);
  const stopped = await request("stop");
  assert.equal(stopped.status, 200);
  assert.deepEqual((await stopped.json() as { results: unknown[] }).results, [
    { identityId: "agent-a", outcome: "stopped" },
  ]);
  assert.deepEqual(calls, [
    `start:${conversation.id}:human-bulk`,
    `stop:${conversation.id}:human-bulk`,
  ]);
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
    conversations: { async getConversation() { return conversation; } },
    bindings: { async listConversationBindings() { return []; } },
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
    conversationsPort: 0,
    controlPort: 0,
    webUrl: "http://127.0.0.1:5174/",
  });
  try {
    const client = new ConversationClient(app.conversationsEndpoint, { serviceToken: app.conversationsServiceToken });
    const workspaces = await client.listWorkspaces();
    assert.deepEqual(workspaces.map(({ id, name }) => ({ id, name })), [{
      id: app.workspaceId,
      name: "MinuChannels Review",
    }]);
    assert.equal((await client.listWorkspaceConversations(app.workspaceId))[0]?.name, "product-review");
    const messages = await client.listMessages(app.conversationId);
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

    await client.postMessage(app.conversationId, {
      participantId: app.humanIdentityId,
      body: "@builder Confirm this review message.",
    });
    let updatedMessages = await client.listMessages(app.conversationId);
    for (let attempt = 0; attempt < 20 && updatedMessages.length < 6; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      updatedMessages = await client.listMessages(app.conversationId);
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
      protocolVersion: 17,
      identityId: app.humanIdentityId,
    });
    const response = await fetch(`${app.controlEndpoint}/local/conversations/${app.conversationId}/agents`, {
      headers,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { agents: Array<{ state: string }> };
    assert.deepEqual(body.agents.map(({ state }) => state), ["disconnected", "unbound"]);
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
  const conversationsBackend = createNodeServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ source: "conversations", path: request.url }));
  });
  const controlBackend = createNodeServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      source: "control",
      origin: request.headers.origin,
      cookie: request.headers.cookie,
    }));
  });
  const listen = async (server: ReturnType<typeof createNodeServer>): Promise<string> => {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    return `http://127.0.0.1:${address.port}`;
  };
  const [conversationsEndpoint, controlEndpoint] = await Promise.all([
    listen(conversationsBackend),
    listen(controlBackend),
  ]);
  let browserAuthenticated = true;
  let quiescing = false;
  const web = await createLocalWebServer({
    conversationsEndpoint,
    controlEndpoint,
    webDirectory,
    port: 0,
    conversationsServiceToken: "web-test-token",
    authenticateBrowser: () => browserAuthenticated ? { identityId: "human-web-test" } : undefined,
    isQuiescing: () => quiescing,
  });
  try {
    assert.equal(await requestStatus(`${web.endpoint}/`, {
      host: "minu-channels.localhost:47412",
    }), 200);
    const spa = await fetch(`${web.endpoint}/app/workspaces/workspace/conversations/conversation`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /MinuChannels production/);
    const asset = await fetch(`${web.endpoint}/assets/app.js`);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(await asset.text(), /console\.log/);
    const conversationsResponse = await (await fetch(`${web.endpoint}/identities`)).json() as { source: string };
    assert.equal(conversationsResponse.source, "conversations");
    browserAuthenticated = false;
    assert.equal((await fetch(`${web.endpoint}/identities`)).status, 401);
    browserAuthenticated = true;
    assert.equal((await fetch(`${web.endpoint}/identities`, { headers: { origin: "https://hostile.example" } })).status, 403);
    const controlResponse = await (await fetch(`${web.endpoint}/local/health`, {
      headers: { origin: web.endpoint, cookie: "minu_local_session=browser-session" },
    })).json() as { source: string; origin?: string; cookie?: string };
    assert.deepEqual(controlResponse, {
      source: "control",
      cookie: "minu_local_session=browser-session",
    });
    quiescing = true;
    const blocked = await fetch(`${web.endpoint}/identities`, { method: "POST" });
    assert.equal(blocked.status, 503);
    assert.deepEqual(await blocked.json(), { error: "MinuChannels is restarting" });
    assert.equal((await fetch(`${web.endpoint}/local/workspaces/workspace/config`, { method: "PATCH" })).status, 503);
    assert.equal((await fetch(`${web.endpoint}/conversations/conversation/messages`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${web.endpoint}/identities`)).status, 200);
  } finally {
    await web.close();
    await Promise.all([
      new Promise<void>((resolveClose) => conversationsBackend.close(() => resolveClose())),
      new Promise<void>((resolveClose) => controlBackend.close(() => resolveClose())),
      rm(webDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("resolves isolated Conversations data paths and arbitrates product-directory locks", async () => {
  assert.equal(resolveConversationsDataDirectory({
    explicit: "~/explicit-conversations",
    env: { MINU_CHANNELS_HOME: "/ignored-product", MINU_HOME: "/ignored-minu" },
    homeDirectory: "/home/tester",
  }), "/home/tester/explicit-conversations");
  assert.equal(resolveConversationsDataDirectory({
    env: { MINU_CHANNELS_HOME: "/product-home", MINU_HOME: "/ignored-minu" },
    homeDirectory: "/home/tester",
  }), "/product-home");
  assert.equal(resolveConversationsDataDirectory({
    env: { MINU_HOME: "/shared-minu" },
    homeDirectory: "/home/tester",
  }), "/shared-minu/channels");
  assert.equal(resolveConversationsDataDirectory({ env: {}, homeDirectory: "/home/tester" }), "/home/tester/.minu/channels");

  const dataDirectory = await mkdtemp(join(tmpdir(), "minu-local-paths-"));
  try {
    await prepareConversationsDataDirectory(dataDirectory);
    const lock = await acquireConversationsDataDirectoryLock(dataDirectory);
    assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dataDirectory, "run"))).mode & 0o777, 0o700);
    assert.equal((await stat(lock.path)).mode & 0o777, 0o700);
    await assert.rejects(acquireConversationsDataDirectoryLock(dataDirectory), /already using data directory/);
    await lock.release();
    await writeFile(join(dataDirectory, "run", "instance.lock"), '{"pid":999999,"token":"stale"}\n');
    const replacement = await acquireConversationsDataDirectoryLock(dataDirectory);
    await replacement.release();

    const initializingPath = join(dataDirectory, "run", "instance.lock");
    await mkdir(initializingPath);
    await assert.rejects(acquireConversationsDataDirectoryLock(dataDirectory), /already using data directory/);
    assert.equal((await stat(initializingPath)).isDirectory(), true);
    await rm(initializingPath, { recursive: true });

    await mkdir(initializingPath);
    await writeFile(join(initializingPath, "owner.json"), '{"pid":999999,"token":"stale"}\n');
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
      acquireConversationsDataDirectoryLock(dataDirectory)));
    const winners = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    assert.equal(winners.length, 1);
    await winners[0]!.release();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("development data reset is fixed-scope, active-instance-aware, and symlink-safe", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "minu-dev-reset-home-"));
  const outside = await mkdtemp(join(tmpdir(), "minu-dev-reset-outside-"));
  const dataDirectory = developmentDataDirectory(homeDirectory);
  try {
    assert.equal(await resetDevelopmentData({ homeDirectory }), "absent");
    await prepareConversationsDataDirectory(dataDirectory);
    await writeFile(join(dataDirectory, "marker"), "development-only");
    const lock = await acquireConversationsDataDirectoryLock(dataDirectory);
    await assert.rejects(
      resetDevelopmentData({ homeDirectory }),
      /already using data directory/,
    );
    assert.equal(await readFile(join(dataDirectory, "marker"), "utf8"), "development-only");
    await lock.release();
    assert.equal(await resetDevelopmentData({ homeDirectory }), "removed");
    await assert.rejects(stat(dataDirectory), { code: "ENOENT" });

    await mkdir(join(homeDirectory, ".minu"), { recursive: true });
    await symlink(outside, dataDirectory);
    await assert.rejects(
      resetDevelopmentData({ homeDirectory }),
      /unsafe data directory/,
    );
    assert.equal((await stat(outside)).isDirectory(), true);
  } finally {
    await Promise.all([
      rm(homeDirectory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
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
      conversationsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime,
    });
    assert.equal(first.initialized, true);
    const firstClient = new ConversationClient(first.conversationsEndpoint, { serviceToken: first.conversationsServiceToken });
    assert.equal((await firstClient.listIdentities()).length, 2);
    assert.deepEqual((await firstClient.listWorkspaces()).map(({ name }) => name), ["Chosen Workspace"]);
    assert.equal((await firstClient.listWorkspaceConversations(first.workspaceId!)).length, 1);
    assert.deepEqual(await firstClient.listMessages(first.conversationId!), []);
    assert.equal((await stat(join(dataDirectory, "run", "instance.lock"))).mode & 0o777, 0o700);
    await assert.rejects(createLocalProductApp({
      dataDirectory,
      workspaceRoot,
      conversationsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime,
    }), /already using data directory/);
    const original = {
      humanIdentityId: first.humanIdentityId,
      workspaceId: first.workspaceId,
      conversationId: first.conversationId,
    };
    await first.close();
    first = undefined;

    reopened = await createLocalProductApp({
      dataDirectory,
      workspaceRoot,
      selectWorkspaceRoot: true,
      conversationsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime,
    });
    assert.equal(reopened.initialized, false);
    assert.deepEqual({
      humanIdentityId: reopened.humanIdentityId,
      workspaceId: reopened.workspaceId,
      conversationId: reopened.conversationId,
    }, original);
    const reopenedClient = new ConversationClient(reopened.conversationsEndpoint, { serviceToken: reopened.conversationsServiceToken });
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

test("local product snapshots both databases before applying an update migration", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "minu-local-migration-backup-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "minu-local-migration-workspace-"));
  const migrationsFolder = join(dataDirectory, "test-migrations");
  let app: Awaited<ReturnType<typeof createLocalProductApp>> | undefined;
  try {
    app = await createLocalProductApp({
      dataDirectory,
      workspaceRoot,
      conversationsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime: new ManagedFakeRuntime(),
    });
    await app.close();
    app = undefined;

    await mkdir(join(migrationsFolder, "meta"), { recursive: true });
    await writeFile(join(migrationsFolder, "meta", "_journal.json"), JSON.stringify({
      entries: [{ idx: 0, version: "6", when: 4_102_444_800_000, tag: "0000_update", breakpoints: true }],
    }));
    await writeFile(join(migrationsFolder, "0000_update.sql"), "SELECT 1;");

    app = await createLocalProductApp({
      dataDirectory,
      conversationsMigrationsFolder: migrationsFolder,
      conversationsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime: new ManagedFakeRuntime(),
    });
    const backups = await readdir(join(dataDirectory, "backups"));
    assert.equal(backups.length, 1);
    await Promise.all([
      stat(join(dataDirectory, "backups", backups[0]!, "channels.db")),
      stat(join(dataDirectory, "backups", backups[0]!, "relay.db")),
    ]);
  } finally {
    await app?.close().catch(() => undefined);
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
      conversationsPort: 0,
      controlPort: 0,
      webUrl: "http://127.0.0.1:5199/",
      runtimeAdapter: "managed-test",
      runtime: new ManagedFakeRuntime(),
    });
    assert.equal(app.initialized, true);
    assert.equal(app.workspaceId, undefined);
    assert.equal(app.conversationId, undefined);
    const client = new ConversationClient(app.conversationsEndpoint, { serviceToken: app.conversationsServiceToken });
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
    const provisioned = await provisionedResponse.json() as { workspaceId: string; conversationId: string };
    assert.deepEqual((await client.listWorkspaces()).map(({ id, name }) => ({ id, name })), [{
      id: provisioned.workspaceId,
      name: "Browser First",
    }]);
    assert.equal((await client.listWorkspaceConversations(provisioned.workspaceId))[0]?.id, provisioned.conversationId);
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
    conversationsPort: 0,
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
      const client = new ConversationClient(recovered.conversationsEndpoint, { serviceToken: recovered.conversationsServiceToken });
      assert.equal((await client.listIdentities()).length, 2);
      assert.equal((await client.listWorkspaces()).length, 1);
      assert.equal((await client.listWorkspaceConversations(recovered.workspaceId!)).length, 1);
    } finally { await recovered.close(); }
    await assert.rejects(stat(join(dataDirectory, "local-profile.json.initializing")), /ENOENT/);
  } finally {
    await Promise.all([rm(dataDirectory, { recursive: true, force: true }), rm(workspaceRoot, { recursive: true, force: true })]);
  }
});

test("Workspace provisioning validates first and resumes idempotently", async () => {
  const server = await createConversationHttpServer();
  const root = await mkdtemp(join(tmpdir(), "minu-provision-root-"));
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
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
    assert.equal((await client.listWorkspaceConversations(first.workspaceId)).length, 1);
    assert.equal((await client.listWorkspaceMembers(first.workspaceId)).length, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("Runtime discovery is scoped by canonical Workspace source root", async () => {
  const server = await createConversationHttpServer();
  const firstRoot = await mkdtemp(join(tmpdir(), "minu-runtime-root-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "minu-runtime-root-b-"));
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
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

test("private configuration keeps lists redacted and returns agent details only to authorized local owners", async () => {
  const conversationServer = await createConversationHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const audit: LocalControlAuditEvent[] = [];
  try {
    const client = new ConversationClient(conversationServer.endpoint, { serviceToken: conversationServer.serviceToken });
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
      runtimeAdapter: "pi-owned",
      modelConfigured: true,
      reasoningConfigured: true,
      skillsConfigured: false,
      selectedSkillCount: 0,
      status: "active",
      boundConversationCount: 0,
      changesApplyToNewSessions: true,
    }]);
    const detail = await configuration.getWorkspaceAgentConfiguration(workspace.id, agent.id, owner.id);
    assert.deepEqual(detail, {
      protocolVersion: 17,
      workspaceId: workspace.id,
      identityId: agent.id,
      instructions: { source: "inline", text: "PRIVATE PERSONA: build and verify carefully" },
      runtimeAdapter: "pi-owned",
      modelProvider: "openai-private",
      modelId: "gpt-private",
      reasoningLevel: "high",
      status: "active",
      changesApplyToNewSessions: true,
    });
    await assert.rejects(
      configuration.getWorkspaceAgentConfiguration(workspace.id, agent.id, member.id),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403,
    );
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
      /private\/source|private-notes-folder|PRIVATE PERSONA|openai-private|gpt-private|personaPrompt|modelProvider|modelId|reasoningLevel|rootUri/,
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
    await conversationServer.close();
  }
});

test("Conversation working folders are private, canonical, and owner-controlled", async () => {
  const conversationServer = await createConversationHttpServer({ port: 0 });
  const root = await mkdtemp(join(tmpdir(), "minu-working-folders-root-"));
  const outside = await mkdtemp(join(tmpdir(), "minu-working-folders-outside-"));
  const store = new InMemoryRelayBindingStore();
  const audit: LocalControlAuditEvent[] = [];
  try {
    await Promise.all([
      mkdir(join(root, "apps", "web"), { recursive: true }),
      mkdir(join(root, "packages", "shared"), { recursive: true }),
    ]);
    await symlink(outside, join(root, "outside-link"));
    const client = new ConversationClient(conversationServer.endpoint, { serviceToken: conversationServer.serviceToken });
    const [owner, member] = await Promise.all([
      client.createIdentity({ type: "human", displayName: "Owner" }),
      client.createIdentity({ type: "human", displayName: "Member" }),
    ]);
    const workspace = await client.createWorkspace({ slug: "working-folders", name: "Working folders" });
    await Promise.all([
      client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" }),
      client.addWorkspaceMember(workspace.id, { identityId: member.id, mentionHandle: "member" }),
    ]);
    const conversation = await client.createConversation({
      workspaceId: workspace.id,
      participantIds: [owner.id, member.id],
    });
    const configuration = new LocalAgentHostConfiguration({
      client,
      store,
      onAudit: (event) => audit.push(event),
    });
    await configuration.updateWorkspaceConfiguration(workspace.id, owner.id, { rootUri: root });
    assert.deepEqual(await configuration.getConversationWorkingFolders(conversation.id, owner.id), {
      protocolVersion: 17,
      workspaceId: workspace.id,
      conversationId: conversation.id,
      inheritedFromWorkspace: true,
      folders: [],
      changesApplyToNewSessions: true,
      enforcement: "advisory",
    });
    assert.deepEqual(await configuration.previewConversationWorkingFolder(conversation.id, owner.id, {
      path: join(root, "apps", "web"), primary: false,
    }), { relativePath: "apps/web" });
    await assert.rejects(configuration.previewConversationWorkingFolder(conversation.id, member.id, {
      path: join(root, "apps", "web"), primary: false,
    }), (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403);
    await assert.rejects(configuration.previewConversationWorkingFolder(conversation.id, owner.id, {
      path: join(root, "outside-link"), primary: false,
    }), (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 400);
    const updated = await configuration.updateConversationWorkingFolders(conversation.id, owner.id, {
      folders: [
        { path: join(root, "apps", "web"), primary: true },
        { relativePath: "packages/shared", primary: false },
      ],
    });
    assert.deepEqual(updated.folders, [
      { relativePath: "apps/web", position: 0, primary: true },
      { relativePath: "packages/shared", position: 1, primary: false },
    ]);
    assert.equal(updated.inheritedFromWorkspace, false);
    assert.deepEqual(await store.getConversationWorkingFolders(workspace.id, conversation.id), [
      { workspaceId: workspace.id, conversationId: conversation.id, relativePath: "apps/web", position: 0, primary: true },
      { workspaceId: workspace.id, conversationId: conversation.id, relativePath: "packages/shared", position: 1, primary: false },
    ]);
    await assert.rejects(configuration.updateConversationWorkingFolders(conversation.id, member.id, {
      folders: [],
    }), (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403);
    await assert.rejects(configuration.updateConversationWorkingFolders(conversation.id, owner.id, {
      folders: [{ path: join(root, "outside-link"), primary: true }],
    }), (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 400);
    await assert.rejects(configuration.updateConversationWorkingFolders(conversation.id, owner.id, {
      folders: [{ relativePath: "../escape", primary: true }],
    }), (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 400);
    await configuration.updateConversationWorkingFolders(conversation.id, owner.id, {
      folders: [{ relativePath: ".", primary: true }],
    });
    assert.deepEqual(await store.getConversationWorkingFolders(workspace.id, conversation.id), []);
    const auditJson = JSON.stringify(audit);
    assert.doesNotMatch(auditJson, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(auditJson, /outside-link|packages\/shared|apps\/web/);
  } finally {
    await Promise.all([
      store.close(),
      conversationServer.close(),
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("agent host quiescing drains accepted lifecycle work before freezing Relay admission", async () => {
  let releasePending!: () => void;
  const pending = new Promise<void>((resolve) => { releasePending = resolve; });
  let quiesceCalls = 0;
  let waitCalls = 0;
  const relay = {
    workSnapshot: () => ({
      activeTurns: waitCalls === 0 ? 1 : 0,
      queuedTurns: 2,
      queuedTurnsExact: false,
      quiescing: quiesceCalls > 0,
    }),
    quiesce: () => {
      quiesceCalls += 1;
      return relay.workSnapshot();
    },
    waitForQuiesced: async () => {
      waitCalls += 1;
      return relay.workSnapshot();
    },
  };
  const host = new LocalAgentHost({
    client: {} as ConversationClient,
    store: {} as InMemoryRelayBindingStore,
    runtimes: {
      managed: {
        async start() { return { id: "private-session" }; },
        async status() { return "idle"; },
        async send() {},
        async messages() { return []; },
      },
    },
  });
  const internals = host as unknown as {
    pending: Map<string, Promise<unknown>>;
    runners: Map<string, { relay: typeof relay }>;
  };
  internals.pending.set("accepted-operation", pending);
  internals.runners.set("private-conversation", { relay });

  assert.deepEqual(host.workSnapshot(), {
    state: "running",
    activeTurns: 1,
    queuedTurns: 2,
    queuedTurnsExact: false,
    pendingLifecycle: 1,
  });
  const beginning = host.beginQuiesce();
  assert.equal(host.available, false);
  assert.equal(quiesceCalls, 1);
  releasePending();
  internals.pending.delete("accepted-operation");
  assert.deepEqual(await beginning, {
    state: "quiescing",
    activeTurns: 1,
    queuedTurns: 2,
    queuedTurnsExact: false,
    pendingLifecycle: 0,
  });
  assert.equal(quiesceCalls, 1);
  assert.deepEqual(await host.waitForQuiesced(), {
    state: "quiesced",
    activeTurns: 0,
    queuedTurns: 2,
    queuedTurnsExact: false,
    pendingLifecycle: 0,
  });
  assert.equal(waitCalls, 1);
  await assert.rejects(
    host.cancelCurrentConversationAgent("private-conversation", "private-agent", "private-owner"),
    (error: unknown) => error instanceof LocalConfigurationRequestError
      && error.message === "Agent host is unavailable",
  );
});

test("agent host sanitizes unexpected cancellation failures and audit output", async () => {
  const audit: LocalControlAuditEvent[] = [];
  const host = new LocalAgentHost({
    client: {} as ConversationClient,
    store: {} as InMemoryRelayBindingStore,
    runtimes: {},
    onAudit: (event) => audit.push(event),
  });
  const internals = host as unknown as {
    baseContext: () => Promise<{ conversation: { workspaceId: string } }>;
    runners: Map<string, { relay: { cancelCurrent(): Promise<void> } }>;
  };
  internals.baseContext = async () => ({ conversation: { workspaceId: "workspace-safe" } });
  internals.runners.set("conversation-safe", {
    relay: { async cancelCurrent() { throw new Error("SECRET_DATABASE_URL=/private/path"); } },
  });
  await assert.rejects(
    host.cancelCurrentConversationAgent("conversation-safe", "agent-safe", "owner-safe"),
    (error: unknown) => error instanceof LocalConfigurationRequestError
      && error.message === "Agent turn could not be canceled",
  );
  assert.doesNotMatch(JSON.stringify(audit), /SECRET_DATABASE_URL|private\/path/);
  assert.equal(audit.length, 1);
  const [{ timestamp: auditAt, ...auditFields }] = audit;
  assert.match(auditAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(auditFields, {
    action: "agent.turn.cancel.requested",
    outcome: "rejected",
    reason: "unavailable",
    actorIdentityId: "owner-safe",
    workspaceId: "workspace-safe",
    conversationId: "conversation-safe",
    targetIdentityId: "agent-safe",
  });
});

test("agent host scopes, verifies, bounds, and sanitizes opaque diagnostic opening", async () => {
  const audit: LocalControlAuditEvent[] = [];
  let openCalls = 0;
  let capabilityAvailable = true;
  let failOpening = false;
  const runtime: LocalControlRuntimePort = {
    async status() { return "idle"; },
    async sessionCapabilities() {
      return {
        version: 1,
        safeActivityEvents: true,
        interrupt: true,
        reconnectExisting: true,
        interactiveAttach: false,
        openDiagnostic: capabilityAvailable,
        liveSkillVerification: false,
      };
    },
    async openDiagnostic() {
      openCalls += 1;
      if (failOpening) throw new Error("SECRET_DIAGNOSTIC_PATH=/private/runtime.log");
    },
  };
  const host = new LocalAgentHost({
    client: {} as ConversationClient,
    store: {} as InMemoryRelayBindingStore,
    runtimes: { "private-adapter": runtime },
    onAudit: (event) => audit.push(event),
  });
  const internals = host as unknown as {
    baseContext(): Promise<{
      conversation: { workspaceId: string };
      bindings: Array<{
        id: string;
        agentIdentityId: string;
        runtimeAdapter: string;
        runtimeSessionId: string;
        state: "connected";
      }>;
    }>;
  };
  internals.baseContext = async () => ({
    conversation: { workspaceId: "workspace-safe" },
    bindings: [{
      id: "binding-private",
      agentIdentityId: "agent-safe",
      runtimeAdapter: "private-adapter",
      runtimeSessionId: "SECRET_RUNTIME_SESSION",
      state: "connected",
    }],
  });

  await host.openConversationAgentDiagnostic("conversation-safe", "agent-safe", "owner-safe");
  assert.equal(openCalls, 1);

  capabilityAvailable = false;
  await assert.rejects(
    host.openConversationAgentDiagnostic("conversation-safe", "agent-safe", "owner-safe"),
    (error: unknown) => error instanceof LocalConfigurationRequestError
      && error.message === "Agent diagnostic unavailable",
  );
  assert.equal(openCalls, 1);

  capabilityAvailable = true;
  failOpening = true;
  await assert.rejects(
    host.openConversationAgentDiagnostic("conversation-safe", "agent-safe", "owner-safe"),
    (error: unknown) => error instanceof LocalConfigurationRequestError
      && error.message === "Agent diagnostic could not be opened",
  );
  assert.equal(openCalls, 2);

  internals.baseContext = async () => {
    throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
  };
  await assert.rejects(
    host.openConversationAgentDiagnostic("conversation-safe", "agent-safe", "member-safe"),
    (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403,
  );
  assert.equal(openCalls, 2);
  assert.doesNotMatch(JSON.stringify(audit), /SECRET_|private-adapter|runtime\.log|binding-private/);
  assert.deepEqual(audit.map(({ action, outcome, reason }) => ({ action, outcome, reason })), [
    { action: "agent.diagnostic.opened", outcome: "accepted", reason: undefined },
    { action: "agent.diagnostic.opened", outcome: "rejected", reason: "unavailable" },
    { action: "agent.diagnostic.opened", outcome: "rejected", reason: "unavailable" },
    { action: "agent.diagnostic.opened", outcome: "rejected", reason: "forbidden" },
  ]);
});

test("one binding queue drain does not hold the shared Relay ownership lock", async () => {
  const host = new LocalAgentHost({
    client: {} as ConversationClient,
    store: {} as InMemoryRelayBindingStore,
    runtimes: {},
  });
  let releaseA!: () => void;
  const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
  let enteredA!: () => void;
  const aStarted = new Promise<void>((resolve) => { enteredA = resolve; });
  const retired: string[] = [];
  const internals = host as unknown as {
    runners: Map<string, unknown>;
    retireBinding(conversationId: string, participantId: string): Promise<void>;
  };
  internals.runners.set("conversation-shared", {
    relay: {
      async retire(participantId: string) {
        retired.push(participantId);
        if (participantId === "agent-a") {
          enteredA();
          await blockedA;
        }
      },
      async stop() {},
    },
    readiness: "ready",
    ready: Promise.resolve(),
    resolveReady() {},
    pendingAttaches: new Set(),
    restored: new Map([
      ["agent-a", { async close() {} }],
      ["agent-b", { async close() {} }],
    ]),
  });
  const retiringA = internals.retireBinding("conversation-shared", "agent-a");
  await aStarted;
  await internals.retireBinding("conversation-shared", "agent-b");
  assert.deepEqual(retired, ["agent-a", "agent-b"]);
  releaseA();
  await retiringA;
});

test("bulk lifecycle bounds concurrency and preserves participant order", async () => {
  const host = new LocalAgentHost({
    client: {} as ConversationClient,
    store: {} as InMemoryRelayBindingStore,
    runtimes: {},
  });
  const identityIds = ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"];
  let active = 0;
  let maximum = 0;
  const targets = identityIds.map((identityId) => ({ identityId, duplicate: false }));
  const internals = host as unknown as {
    bulkTargets(): Promise<{ workspaceId: string; targets: typeof targets }>;
    bulkStartOne(
      _conversationId: string,
      _workspaceId: string,
      target: typeof targets[number],
    ): Promise<{ identityId: string; outcome: "started" }>;
  };
  internals.bulkTargets = async () => ({ workspaceId: "workspace-bulk", targets });
  internals.bulkStartOne = async (_conversationId, _workspaceId, { identityId }) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, identityId === "agent-1" ? 20 : 5));
    active -= 1;
    if (identityId === "agent-2") throw new Error("target-local preflight failed");
    return { identityId, outcome: "started" };
  };
  const results = await host.startAllConversationAgents("conversation-bulk", "owner-bulk");
  assert.equal(maximum, 3);
  assert.deepEqual(results, identityIds.map((identityId) => identityId === "agent-2"
    ? { identityId, outcome: "failed", reason: "unavailable" }
    : { identityId, outcome: "started" }));
});

test("bulk stop does not reverse a real individual start accepted after its snapshot", async () => {
  const sourceDirectory = await realpath(await mkdtemp(join(tmpdir(), "minu-bulk-race-")));
  const conversationServer = await createConversationHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const runtime = new ManagedFakeRuntime();
  let host: LocalAgentHost | undefined;
  try {
    const client = new ConversationClient(conversationServer.endpoint, { serviceToken: conversationServer.serviceToken });
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const agents = await Promise.all(["A", "B", "C", "D"].map((name) =>
      client.createIdentity({ type: "agent", displayName: `Agent ${name}` })));
    const workspace = await client.createWorkspace({ slug: "bulk-race", name: "Bulk Race" });
    await client.addWorkspaceMember(workspace.id, {
      identityId: owner.id,
      mentionHandle: "owner",
      accessRole: "owner",
    });
    for (const [index, agent] of agents.entries()) {
      await client.addWorkspaceMember(workspace.id, {
        identityId: agent.id,
        mentionHandle: `agent-${String.fromCharCode(97 + index)}`,
      });
    }
    const conversation = await client.createConversation({
      workspaceId: workspace.id,
      name: "bulk-race",
      participantIds: [owner.id, ...agents.map(({ id }) => id)],
    });
    const configuration = new LocalAgentHostConfiguration({
      client,
      store,
      runtimes: { "managed-test": runtime },
    });
    await configuration.updateWorkspaceConfiguration(workspace.id, owner.id, {
      rootUri: sourceDirectory,
    });
    for (const agent of agents) {
      await configuration.updateWorkspaceAgentConfiguration(workspace.id, agent.id, owner.id, {
        runtimeAdapter: "managed-test",
        modelProvider: "openai",
        modelId: "gpt-managed",
      });
    }
    host = new LocalAgentHost({ client, store, runtimes: { "managed-test": runtime } });
    await Promise.all(agents.slice(0, 3).map((agent) =>
      host!.startConversationAgent(conversation.id, agent.id, owner.id)));
    const initialBindings = await store.listConversationBindings(conversation.id);
    const heldStatuses = initialBindings.map(({ runtimeSessionId }) => runtime.holdStatus(runtimeSessionId));

    const stopping = host.stopAllConversationAgents(conversation.id, owner.id);
    await Promise.all(heldStatuses.map(({ entered }) => entered));
    const agentD = agents[3]!;
    await host.startConversationAgent(conversation.id, agentD.id, owner.id);
    const startedD = (await store.listConversationBindings(conversation.id))
      .find(({ agentIdentityId }) => agentIdentityId === agentD.id)!;
    assert.equal(startedD.state, "connected");
    assert.equal(startedD.generation, 1);
    assert.ok(startedD.leaseOwner);
    assert.equal(await runtime.status(startedD.runtimeSessionId), "idle");

    for (const held of heldStatuses) held.release();
    const results = await stopping;
    assert.deepEqual(results.at(-1), {
      identityId: agentD.id,
      outcome: "skipped",
      reason: "already_idle",
    });
    const afterD = await store.getBinding(startedD.id);
    assert.equal(afterD?.state, "connected");
    assert.equal(afterD?.generation, 1);
    assert.equal(afterD?.runtimeSessionId, startedD.runtimeSessionId);
    assert.equal(afterD?.leaseOwner, startedD.leaseOwner);
    assert.equal(runtime.stops.includes(startedD.runtimeSessionId), false);
    assert.equal(runtime.interruptions.includes(startedD.runtimeSessionId), false);

    const nextSessionNumber = runtime.starts.length + 1;
    const heldStarts = [0, 1, 2].map((offset) =>
      runtime.holdStatus(`managed-session-${nextSessionNumber + offset}`));
    const starting = host.startAllConversationAgents(conversation.id, owner.id);
    await Promise.all(heldStarts.map(({ entered }) => entered));
    await host.stopConversationAgent(conversation.id, agentD.id, owner.id);
    for (const held of heldStarts) held.release();
    const startResults = await starting;
    assert.deepEqual(startResults.at(-1), {
      identityId: agentD.id,
      outcome: "skipped",
      reason: "offline",
    });
    const stoppedD = await store.getBinding(startedD.id);
    assert.equal(stoppedD?.state, "disabled");
    assert.equal(stoppedD?.generation, 2);
    assert.equal(runtime.stops.filter((sessionId) => sessionId === startedD.runtimeSessionId).length, 1);
  } finally {
    await host?.close().catch(() => undefined);
    await store.close();
    await conversationServer.close();
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("new Conversation sessions use a validated primary working folder and advisory guidance", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "minu-working-folder-launch-"));
  const primaryDirectory = join(sourceDirectory, "apps", "web");
  const additionalDirectory = join(sourceDirectory, "packages", "shared");
  const conversationServer = await createConversationHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const runtime = new ManagedFakeRuntime();
  let host: LocalAgentHost | undefined;
  try {
    await Promise.all([
      mkdir(primaryDirectory, { recursive: true }),
      mkdir(additionalDirectory, { recursive: true }),
    ]);
    const client = new ConversationClient(conversationServer.endpoint, { serviceToken: conversationServer.serviceToken });
    const [owner, agent] = await Promise.all([
      client.createIdentity({ type: "human", displayName: "Owner" }),
      client.createIdentity({ type: "agent", displayName: "Builder" }),
    ]);
    const workspace = await client.createWorkspace({ slug: "working-folder-launch", name: "Working folder launch" });
    await Promise.all([
      client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" }),
      client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "builder" }),
    ]);
    const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
    const configuration = new LocalAgentHostConfiguration({ client, store });
    await configuration.updateWorkspaceConfiguration(workspace.id, owner.id, { rootUri: sourceDirectory });
    await configuration.updateWorkspaceAgentConfiguration(workspace.id, agent.id, owner.id, {
      personaPrompt: "Use the saved persona.",
      runtimeAdapter: "managed-test",
    });
    await configuration.updateConversationWorkingFolders(conversation.id, owner.id, {
      folders: [
        { relativePath: "apps/web", primary: true },
        { relativePath: "packages/shared", primary: false },
      ],
    });
    host = new LocalAgentHost({ client, store, runtimes: { "managed-test": runtime } });
    await host.startConversationAgent(conversation.id, agent.id, owner.id);
    assert.deepEqual(runtime.starts[0]?.config, {
      cwd: await realpath(primaryDirectory),
      appendSystemPrompt: [
        "Use the saved persona.",
        "Conversation working folders (paths below are relative to the current working directory):\n- Primary folder: .\n- Additional folder: ../../packages/shared\nWorking folders guide where you should work. They are not a filesystem sandbox.",
      ].join("\n\n"),
    });
    const additionalPath = runtime.starts[0]?.config.appendSystemPrompt?.match(/Additional folder: ([^\n]+)/)?.[1];
    assert.equal(resolve(runtime.starts[0]!.config.cwd, additionalPath!), await realpath(additionalDirectory));
    await host.replaceConversationAgent(conversation.id, agent.id, owner.id);
    assert.equal(runtime.starts[1]?.config.cwd, await realpath(primaryDirectory));
    await rm(primaryDirectory, { recursive: true, force: true });
    await assert.rejects(
      host.replaceConversationAgent(conversation.id, agent.id, owner.id),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 409,
    );
  } finally {
    await host?.close();
    await Promise.all([
      store.close(),
      conversationServer.close(),
      rm(sourceDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("agent host starts isolated Conversation sessions with private roots and personas", async () => {
  const sourceDirectory = await realpath(await mkdtemp(join(tmpdir(), "minu-agent-host-source-")));
  const conversationServer = await createConversationHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const runtime = new ManagedFakeRuntime();
  const audit: LocalControlAuditEvent[] = [];
  let host: LocalAgentHost | undefined;
  let restoredHost: LocalAgentHost | undefined;
  try {
    const client = new ConversationClient(conversationServer.endpoint, { serviceToken: conversationServer.serviceToken });
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
    const [conversationA, conversationB] = await Promise.all([
      client.createConversation({
        workspaceId: workspace.id,
        name: "conversation-a",
        participantIds: [owner.id, agent.id],
      }),
      client.createConversation({
        workspaceId: workspace.id,
        name: "conversation-b",
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
    await client.postMessage(conversationA.id, {
      participantId: owner.id,
      body: "@builder historical work must not auto-run",
    });
    host = new LocalAgentHost({
      client,
      store,
      runtimes: { "managed-test": runtime },
      bindingLeaseDurationMs: 30,
      runtimeStatusTimeoutMs: 100,
      onAudit: (event) => audit.push(event),
    });
    assert.equal(host.available, true);
    await assert.rejects(
      host.startConversationAgent(conversationA.id, agent.id, agent.id),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403,
    );
    await host.startConversationAgent(conversationA.id, agent.id, owner.id);
    await host.startConversationAgent(conversationB.id, agent.id, owner.id);
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
    assert.equal((await client.listMessages(conversationA.id)).length, 1);

    await Promise.all([
      client.postMessage(conversationA.id, { participantId: owner.id, body: "@builder work only in A" }),
      client.postMessage(conversationB.id, { participantId: owner.id, body: "@builder work only in B" }),
    ]);
    await waitUntil(async () => (await client.listMessages(conversationA.id)).length === 3
      && (await client.listMessages(conversationB.id)).length === 2);
    assert.match((await client.listMessages(conversationA.id))[2]?.body ?? "", /managed-session-1/);
    assert.match((await client.listMessages(conversationB.id))[1]?.body ?? "", /managed-session-2/);
    assert.doesNotMatch(runtime.prompts.get("managed-session-1")?.[0] ?? "", /work only in B/);
    assert.doesNotMatch(runtime.prompts.get("managed-session-2")?.[0] ?? "", /work only in A/);
    assert.equal((await configuration.getWorkspaceConfiguration(workspace.id, owner.id))
      .agents[0]?.boundConversationCount, 2);

    const originalBinding = (await store.listConversationBindings(conversationA.id))[0]!;
    await (host as unknown as { retireBinding(conversationId: string, identityId: string): Promise<void> })
      .retireBinding(conversationA.id, agent.id);
    assert.equal(host.isAttached(conversationA.id, agent.id), false);
    await client.postMessage(conversationA.id, { participantId: owner.id, body: "@builder queued while disconnected" });
    await assert.rejects(host.reconnectConversationAgent(conversationA.id, agent.id, agent.id),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403);
    let releaseCatchUp!: () => void;
    let signalCatchUp!: () => void;
    const catchUpReleased = new Promise<void>((resolve) => { releaseCatchUp = resolve; });
    const catchUpEntered = new Promise<void>((resolve) => { signalCatchUp = resolve; });
    const originalListMessages = client.listMessages.bind(client);
    let delayCatchUp = true;
    client.listMessages = async (...args) => {
      if (delayCatchUp && args[0] === conversationA.id) {
        delayCatchUp = false;
        signalCatchUp();
        await catchUpReleased;
      }
      return originalListMessages(...args);
    };
    const heldReconnectStatus = runtime.holdStatus(originalBinding.runtimeSessionId);
    const reconnecting = host.reconnectConversationAgent(conversationA.id, agent.id, owner.id);
    await heldReconnectStatus.entered;
    await host.stopConversationAgent(conversationB.id, agent.id, owner.id);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 45));
    heldReconnectStatus.release();
    await catchUpEntered;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 45));
    const renewedDuringCatchUp = await store.getBinding(originalBinding.id);
    assert.equal(renewedDuringCatchUp?.leaseOwner !== undefined, true);
    assert.equal(Date.parse(renewedDuringCatchUp!.leaseExpiresAt!) > Date.now(), true);
    releaseCatchUp();
    await reconnecting;
    client.listMessages = originalListMessages;
    await waitUntil(async () => (await client.listMessages(conversationA.id)).length === 5);
    const reconnectedBinding = (await store.listConversationBindings(conversationA.id))[0]!;
    assert.equal(reconnectedBinding.id, originalBinding.id);
    assert.equal(reconnectedBinding.generation, originalBinding.generation);
    assert.equal(reconnectedBinding.runtimeSessionId, originalBinding.runtimeSessionId);
    assert.equal(runtime.starts.length, 2);
    assert.equal(host.isAttached(conversationA.id, agent.id), true);

    await host.close();
    host = undefined;
    let restoredNow = Date.now();
    const diagnostics: LocalAgentHostDiagnosticEvent[] = [];
    runtime.failNextStatus(originalBinding.runtimeSessionId, new Error(
      "SECRET startup failure with runtime id, endpoint, token, and transcript path",
    ));
    restoredHost = new LocalAgentHost({
      client,
      store,
      runtimes: { "managed-test": runtime },
      now: () => new Date(restoredNow),
      bindingLeaseDurationMs: 30,
      runtimeStatusTimeoutMs: 100,
      recoveryBackoffMs: [5],
      onAudit: (event) => audit.push(event),
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await restoredHost.restore();
    assert.equal(restoredHost.isAttached(conversationA.id, agent.id), false);
    assert.equal((await store.getBinding(originalBinding.id))?.leaseOwner, undefined);
    await waitUntil(async () => restoredHost!.isAttached(conversationA.id, agent.id));
    assert.deepEqual(diagnostics.slice(0, 2).map(({ category, outcome }) => ({ category, outcome })), [
      { category: "binding_restore", outcome: "retrying" },
      { category: "binding_restore", outcome: "attached" },
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET|runtime id|endpoint|token|transcript path/i);

    const startsBeforeSleep = runtime.starts.length;
    const stopsBeforeSleep = runtime.stops.length;
    const beforeSleep = await store.getBinding(originalBinding.id);
    const cursorBeforeSleep = await store.getCursor(conversationA.id, agent.id);
    restoredNow += 31;
    await waitUntil(async () => diagnostics.some(
      ({ category, outcome }) => category === "binding_lease" && outcome === "reattached",
    ));
    const afterSleep = await store.getBinding(originalBinding.id);
    assert.equal(restoredHost.isAttached(conversationA.id, agent.id), true);
    assert.equal(afterSleep?.generation, beforeSleep?.generation);
    assert.equal(afterSleep?.runtimeSessionId, beforeSleep?.runtimeSessionId);
    assert.equal(await store.getCursor(conversationA.id, agent.id), cursorBeforeSleep);
    assert.equal(runtime.starts.length, startsBeforeSleep);
    assert.equal(runtime.stops.length, stopsBeforeSleep);

    await client.postMessage(conversationA.id, {
      participantId: owner.id,
      body: "@builder resume only A",
    });
    await waitUntil(async () => (await client.listMessages(conversationA.id)).length === 7);
    assert.equal(await store.getCursor(conversationA.id, agent.id), 6);

    runtime.setStatus("managed-session-1", "working");
    await assert.rejects(
      restoredHost.replaceConversationAgent(conversationA.id, agent.id, owner.id),
      /active agent work/,
    );
    assert.equal(runtime.starts.length, 2);
    runtime.setStatus("managed-session-1", "idle");
    await restoredHost.replaceConversationAgent(conversationA.id, agent.id, owner.id);
    let binding = (await store.listConversationBindings(conversationA.id))[0]!;
    assert.equal(binding.generation, 2);
    assert.equal(binding.runtimeSessionId, "managed-session-3");
    assert.equal(await runtime.status("managed-session-1"), "offline");
    await client.postMessage(conversationA.id, {
      participantId: owner.id,
      body: "@builder replaced session work",
    });
    await waitUntil(async () => (await client.listMessages(conversationA.id)).length === 9);
    assert.match((await client.listMessages(conversationA.id))[8]?.body ?? "", /managed-session-3/);

    runtime.setStatus("managed-session-3", "working");
    await restoredHost.stopConversationAgent(conversationA.id, agent.id, owner.id);
    binding = (await store.listConversationBindings(conversationA.id))[0]!;
    assert.equal(binding.state, "disabled");
    assert.equal(binding.generation, 3);
    assert.equal(await runtime.status("managed-session-3"), "offline");
    await client.postMessage(conversationA.id, {
      participantId: owner.id,
      body: "@builder stopped work must not run",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.equal((await client.listMessages(conversationA.id)).length, 10);

    await restoredHost.replaceConversationAgent(conversationA.id, agent.id, owner.id);
    binding = (await store.listConversationBindings(conversationA.id))[0]!;
    assert.equal(binding.state, "connected");
    assert.equal(binding.generation, 4);
    assert.equal(binding.runtimeSessionId, "managed-session-4");
    await client.postMessage(conversationA.id, {
      participantId: owner.id,
      body: "@builder restarted work only",
    });
    await waitUntil(async () => (await client.listMessages(conversationA.id)).length === 12);
    assert.match((await client.listMessages(conversationA.id))[11]?.body ?? "", /managed-session-4/);
    assert.equal(await store.getCursor(conversationA.id, agent.id), 11);

    await (restoredHost as unknown as { retireBinding(conversationId: string, identityId: string): Promise<void> })
      .retireBinding(conversationA.id, agent.id);
    const neverResolvingStatus = runtime.holdStatus("managed-session-4");
    const timeoutStartedAt = Date.now();
    await assert.rejects(
      restoredHost.reconnectConversationAgent(conversationA.id, agent.id, owner.id),
      /could not be reconnected/,
    );
    assert.equal(Date.now() - timeoutStartedAt < 500, true);
    neverResolvingStatus.release();
    const unreachableBinding = (await store.listConversationBindings(conversationA.id))[0]!;
    assert.equal(unreachableBinding.state, "connected");
    assert.equal(unreachableBinding.generation, 4);
    assert.equal(unreachableBinding.runtimeSessionId, "managed-session-4");
    assert.equal(runtime.starts.length, 4);
    assert.equal(restoredHost.isAttached(conversationA.id, agent.id), false);

    runtime.setStatus("managed-session-4", "offline");
    await assert.rejects(
      restoredHost.reconnectConversationAgent(conversationA.id, agent.id, owner.id),
      /use New session instead/,
    );
    assert.equal((await store.listConversationBindings(conversationA.id))[0]!.state, "offline");

    assert.doesNotMatch(
      JSON.stringify(audit),
      /PRIVATE MANAGED PERSONA|managed-session|agent-host-source/,
    );
    assert.deepEqual(audit.map(({ action, outcome }) => ({ action, outcome })), [
      { action: "agent.session.started", outcome: "rejected" },
      { action: "agent.session.started", outcome: "accepted" },
      { action: "agent.session.started", outcome: "accepted" },
      { action: "agent.session.reconnected", outcome: "rejected" },
      { action: "agent.session.stopped", outcome: "accepted" },
      { action: "agent.session.reconnected", outcome: "accepted" },
      { action: "agent.session.replaced", outcome: "rejected" },
      { action: "agent.session.replaced", outcome: "accepted" },
      { action: "agent.session.stopped", outcome: "accepted" },
      { action: "agent.session.replaced", outcome: "accepted" },
      { action: "agent.session.reconnected", outcome: "rejected" },
      { action: "agent.session.reconnected", outcome: "rejected" },
    ]);

    runtime.setStatus("managed-session-4", "idle");
    const heldShutdownReconnect = runtime.holdStatus("managed-session-4");
    const reconnectDuringShutdown = restoredHost.reconnectConversationAgent(conversationA.id, agent.id, owner.id);
    await heldShutdownReconnect.entered;
    let shutdownFinished = false;
    const shutdown = restoredHost.close().then(() => { shutdownFinished = true; });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(shutdownFinished, false);
    heldShutdownReconnect.release();
    await reconnectDuringShutdown;
    await shutdown;
    assert.equal(restoredHost.isAttached(conversationA.id, agent.id), false);
    await assert.rejects(
      restoredHost.reconnectConversationAgent(conversationA.id, agent.id, owner.id),
      /Agent host is unavailable/,
    );
    restoredHost = undefined;

    const startsBeforeRecoveryFences = runtime.starts.length;
    const stopsBeforeRecoveryFences = runtime.stops.length;
    runtime.failNextStatus("managed-session-4", new Error("transient shutdown recovery failure"));
    const shutdownRecoveryHost = new LocalAgentHost({
      client,
      store,
      runtimes: { "managed-test": runtime },
      recoveryBackoffMs: [30],
    });
    await shutdownRecoveryHost.restore();
    await shutdownRecoveryHost.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.equal(shutdownRecoveryHost.isAttached(conversationA.id, agent.id), false);

    runtime.failNextStatus("managed-session-4", new Error("transient generation recovery failure"));
    const generationRecoveryHost = new LocalAgentHost({
      client,
      store,
      runtimes: { "managed-test": runtime },
      recoveryBackoffMs: [30],
    });
    await generationRecoveryHost.restore();
    const beforeGenerationFence = (await store.listConversationBindings(conversationA.id))[0]!;
    await store.disableBinding(
      beforeGenerationFence.id,
      beforeGenerationFence.generation,
      new Date().toISOString(),
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.equal(generationRecoveryHost.isAttached(conversationA.id, agent.id), false);
    assert.equal(runtime.starts.length, startsBeforeRecoveryFences);
    assert.equal(runtime.stops.length, stopsBeforeRecoveryFences);
    await generationRecoveryHost.close();
  } finally {
    await host?.close().catch(() => undefined);
    await restoredHost?.close().catch(() => undefined);
    await store.close();
    await conversationServer.close();
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("agent lifecycle changes remain isolated within one shared Conversation Relay", async () => {
  const sourceDirectory = await realpath(await mkdtemp(join(tmpdir(), "minu-agent-isolation-")));
  const conversationServer = await createConversationHttpServer({ port: 0 });
  const store = new InMemoryRelayBindingStore();
  const runtime = new ManagedFakeRuntime();
  const audit: LocalControlAuditEvent[] = [];
  let host: LocalAgentHost | undefined;
  try {
    const client = new ConversationClient(conversationServer.endpoint, { serviceToken: conversationServer.serviceToken });
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const agentA = await client.createIdentity({ type: "agent", displayName: "Agent A" });
    const agentB = await client.createIdentity({ type: "agent", displayName: "Agent B" });
    const agentC = await client.createIdentity({ type: "service", displayName: "Agent C" });
    const workspace = await client.createWorkspace({ slug: "runner-isolation", name: "Runner Isolation" });
    await client.addWorkspaceMember(workspace.id, {
      identityId: owner.id, mentionHandle: "owner", accessRole: "owner",
    });
    await client.addWorkspaceMember(workspace.id, { identityId: agentA.id, mentionHandle: "agent-a" });
    await client.addWorkspaceMember(workspace.id, { identityId: agentB.id, mentionHandle: "agent-b" });
    await client.addWorkspaceMember(workspace.id, { identityId: agentC.id, mentionHandle: "agent-c" });
    const conversation = await client.createConversation({
      workspaceId: workspace.id,
      name: "shared-relay",
      participantIds: [owner.id, agentA.id, agentB.id, agentC.id],
    });
    const configuration = new LocalAgentHostConfiguration({
      client, store, runtimes: { "managed-test": runtime },
    });
    await configuration.updateWorkspaceConfiguration(workspace.id, owner.id, { rootUri: sourceDirectory });
    for (const agent of [agentA, agentB]) {
      await configuration.updateWorkspaceAgentConfiguration(workspace.id, agent.id, owner.id, {
        runtimeAdapter: "managed-test",
        modelProvider: "openai",
        modelId: "gpt-managed",
      });
    }
    host = new LocalAgentHost({
      client,
      store,
      runtimes: { "managed-test": runtime },
      onAudit: (event) => audit.push(event),
    });
    await Promise.all([
      host.startConversationAgent(conversation.id, agentA.id, owner.id),
      host.startConversationAgent(conversation.id, agentB.id, owner.id),
    ]);
    const bindings = await store.listConversationBindings(conversation.id);
    const bindingA = bindings.find(({ agentIdentityId }) => agentIdentityId === agentA.id)!;
    const bindingB = bindings.find(({ agentIdentityId }) => agentIdentityId === agentB.id)!;
    assert.equal(bindings.length, 2);
    await assert.rejects(
      host.startAllConversationAgents(conversation.id, agentA.id),
      (error: unknown) => error instanceof LocalConfigurationRequestError && error.status === 403,
    );

    const heldB = runtime.holdSend(bindingB.runtimeSessionId);
    const triggerB = await client.postMessage(conversation.id, {
      participantId: owner.id,
      to: [agentB.id],
      body: "Agent B in-flight work must survive Agent A lifecycle changes",
    });
    await heldB.entered;
    const beforeB = await store.getBinding(bindingB.id);

    await host.replaceConversationAgent(conversation.id, agentA.id, owner.id);
    const replacedA = (await store.listConversationBindings(conversation.id))
      .find(({ agentIdentityId }) => agentIdentityId === agentA.id)!;
    assert.equal(replacedA.generation, 2);
    await host.stopConversationAgent(conversation.id, agentA.id, owner.id);
    assert.equal((await client.listMessages(conversation.id)).filter(
      ({ participantId }) => participantId === agentB.id,
    ).length, 0);

    heldB.release();
    await waitUntil(async () => (await client.listMessages(conversation.id)).filter(
      ({ participantId }) => participantId === agentB.id,
    ).length === 1);
    const afterB = await store.getBinding(bindingB.id);
    assert.equal(await store.getCursor(conversation.id, agentB.id), triggerB.sequence);
    assert.equal(afterB?.generation, beforeB?.generation);
    assert.equal(afterB?.runtimeSessionId, beforeB?.runtimeSessionId);
    assert.equal(afterB?.leaseOwner, beforeB?.leaseOwner);
    assert.ok(afterB?.leaseExpiresAt);
    assert.ok(beforeB?.leaseExpiresAt);
    assert.ok(afterB.leaseExpiresAt >= beforeB.leaseExpiresAt);
    assert.equal(afterB.state, "connected");
    assert.equal(runtime.stops.includes(bindingB.runtimeSessionId), false);
    assert.equal(runtime.interruptions.includes(bindingB.runtimeSessionId), false);

    const acquireBindingLease = store.acquireBindingLease.bind(store);
    store.acquireBindingLease = async (bindingId, ...args) =>
      bindingId === bindingB.id ? undefined : acquireBindingLease(bindingId, ...args);
    await assert.rejects(
      host.replaceConversationAgent(conversation.id, agentB.id, owner.id),
      /requires reconciliation/,
    );
    assert.equal((await store.getBinding(bindingB.id))?.state, "replacing");
    assert.equal(await runtime.status(bindingB.runtimeSessionId), "offline");
    assert.equal(await runtime.status(runtime.starts.at(-1)!.sessionId), "idle");
    store.acquireBindingLease = acquireBindingLease;

    const nextAgentASession = `managed-session-${runtime.starts.length + 1}`;
    const heldAStatus = runtime.holdStatus(nextAgentASession);
    const attachingA = host.replaceConversationAgent(conversation.id, agentA.id, owner.id);
    await heldAStatus.entered;
    await Promise.race([
      host.stopConversationAgent(conversation.id, agentB.id, owner.id),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("Agent B lifecycle was blocked by Agent A attachment status")),
        500,
      )),
    ]);
    heldAStatus.release();
    await attachingA;

    assert.deepEqual(await host.startAllConversationAgents(conversation.id, owner.id), [
      { identityId: agentA.id, outcome: "skipped", reason: "already_idle" },
      { identityId: agentB.id, outcome: "started" },
      { identityId: agentC.id, outcome: "skipped", reason: "unconfigured" },
    ]);
    assert.deepEqual(await host.stopAllConversationAgents(conversation.id, owner.id), [
      { identityId: agentA.id, outcome: "stopped" },
      { identityId: agentB.id, outcome: "stopped" },
      { identityId: agentC.id, outcome: "skipped", reason: "already_idle" },
    ]);
    assert.equal(audit.filter(({ action }) => action === "agent.session.bulk-started").length, 3);
    assert.equal(audit.filter(({ action }) => action === "agent.session.bulk-stopped").length, 3);
    assert.equal(audit.filter(({ action, outcome }) =>
      action === "agents.bulk-started" && outcome === "accepted").length, 1);
    assert.equal(audit.filter(({ action, outcome }) =>
      action === "agents.bulk-started" && outcome === "rejected").length, 1);
    assert.equal(audit.filter(({ action }) => action === "agents.bulk-stopped").length, 1);
  } finally {
    await host?.close().catch(() => undefined);
    await store.close();
    await conversationServer.close();
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("daemon composes public Conversations, private Relay storage, Runtime status, and browser auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-control-daemon-"));
  const databasePath = join(directory, "relay.db");
  const conversationServer = await createConversationHttpServer({ port: 0 });
  const audit: LocalControlAuditEvent[] = [];
  let daemon: Awaited<ReturnType<typeof createLocalControlDaemon>> | undefined;
  try {
    const client = new ConversationClient(conversationServer.endpoint, { serviceToken: conversationServer.serviceToken });
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
    const createdConversation = await client.createConversation({
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
      conversationId: createdConversation.id,
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
      conversationsEndpoint: conversationServer.endpoint,
      conversationsServiceToken: conversationServer.serviceToken,
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
              defaultModel: { provider: "openai", id: "gpt-private" },
              defaultReasoningLevel: "medium" as const,
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
    const agentConfigurationUrl = `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/config`;
    const agentConfigurationResponse = await fetch(agentConfigurationUrl, { headers: requestHeaders });
    assert.equal(agentConfigurationResponse.status, 200);
    assert.equal(agentConfigurationResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await agentConfigurationResponse.json(), {
      protocolVersion: 17,
      workspaceId: workspace.id,
      identityId: agent.id,
      instructions: { source: "inline", text: "DAEMON PRIVATE PERSONA" },
      runtimeAdapter: "pi-owned-private",
      status: "active",
      changesApplyToNewSessions: true,
    });
    assert.equal((await fetch(agentConfigurationUrl)).status, 401);
    const workspaceRuntimeOptionsResponse = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/runtime-options?adapter=pi-owned-private`,
      { headers: requestHeaders },
    );
    assert.equal(workspaceRuntimeOptionsResponse.status, 200);
    assert.deepEqual(await workspaceRuntimeOptionsResponse.json(), {
      protocolVersion: 17,
      workspaceId: workspace.id,
      models: [{ provider: "openai", id: "gpt-private", name: "Private GPT", reasoning: true, enabled: true }],
      reasoningLevels: ["off", "medium", "high"],
      modelPolicyConfigured: false,
      skills: [{ id: "skill:review", name: "review", description: "Review changes" }],
      defaultModel: { provider: "openai", id: "gpt-private" },
      defaultReasoningLevel: "medium",
    });
    const runtimeOptionsResponse = await fetch(
      `${daemon.endpoint}/local/workspaces/${workspace.id}/agents/${agent.id}/runtime-options`,
      { headers: requestHeaders },
    );
    assert.equal(runtimeOptionsResponse.status, 200);
    assert.deepEqual(await runtimeOptionsResponse.json(), {
      protocolVersion: 17,
      workspaceId: workspace.id,
      identityId: agent.id,
      models: [{ provider: "openai", id: "gpt-private", name: "Private GPT", reasoning: true, enabled: true }],
      reasoningLevels: ["off", "medium", "high"],
      modelPolicyConfigured: false,
      skills: [{ id: "skill:review", name: "review", description: "Review changes" }],
      skillSelectionConfigured: false,
      selectedSkillIds: [],
      defaultModel: { provider: "openai", id: "gpt-private" },
      defaultReasoningLevel: "medium",
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
      agents: Array<{ personaConfigured: boolean; runtimeConfigured: boolean; boundConversationCount: number }>;
    };
    assert.equal(configurationBody.rootConfigured, true);
    assert.deepEqual(configurationBody.agents, [{
      identityId: agent.id,
      configured: true,
      personaConfigured: true,
      runtimeConfigured: true,
      runtimeAdapter: "pi-owned-private",
      modelConfigured: false,
      reasoningConfigured: false,
      skillsConfigured: false,
      selectedSkillCount: 0,
      status: "active",
      boundConversationCount: 1,
      changesApplyToNewSessions: true,
    }]);
    assert.doesNotMatch(
      JSON.stringify(configurationBody),
      /new\/private|DAEMON PRIVATE PERSONA|rootUri|personaPrompt/,
    );
    assert.doesNotMatch(
      JSON.stringify(audit),
      /new\/private|DAEMON PRIVATE PERSONA|pi-owned-private/,
    );

    const response = await fetch(`${daemon.endpoint}/local/conversations/${createdConversation.id}/agents`, {
      headers: { cookie, origin: "http://127.0.0.1:5174" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { agents: Array<{ identityId: string; state: string }> };
    assert.deepEqual(body.agents, [{
      workspaceId: workspace.id,
      conversationId: createdConversation.id,
      identityId: agent.id,
      state: "disconnected",
      wakePolicy: "mentions",
      diagnostics: {
        connection: "disconnected",
        queuedTurns: 0,
        queuedTurnsExact: true,
        capabilities: {
          safeActivityEvents: "not_verified",
          interrupt: "not_verified",
          reconnectExisting: "not_verified",
          interactiveAttach: "not_verified",
          openDiagnostic: "not_verified",
          liveSkillVerification: "not_verified",
        },
      },
      capabilities: { start: false, replace: false, stop: false, steer: false, interrupt: false, reconnect: false },
    }]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /private-runtime-session|private-persona-reference|private\/workspace|test-runtime|private-binding/,
    );
  } finally {
    await daemon?.close().catch(() => undefined);
    await conversationServer.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
