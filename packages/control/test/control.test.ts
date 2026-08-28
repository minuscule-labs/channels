import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import type { ChannelMetadata } from "@minu/channels-core/types";
import { LocalControlClient, LocalControlClientError } from "../src/client.js";
import {
  createLocalControlHttpServer,
  LocalControlService,
  type LocalControlBindingRecord,
} from "../src/server.js";

const channel: ChannelMetadata = {
  id: "channel-1",
  workspaceId: "workspace-1",
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
