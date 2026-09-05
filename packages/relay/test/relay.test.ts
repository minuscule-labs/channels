import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelClient,
  ChannelService,
  createChannelHttpServer,
  InMemoryChannelStorage,
  type CreateResponseInput,
  type ResponseResult,
} from "@minu/channels-core";
import {
  InMemoryRelayBindingStore,
  LocalRelayDirectory,
  restoreChannelBindings,
} from "../src/binding-store.ts";
import {
  ChannelRuntimeRelay,
  type AgentRuntimePort,
  type RuntimePortMessage,
  type RuntimePortTurn,
} from "../src/relay.ts";

class FakeRuntime implements AgentRuntimePort {
  readonly prompts = new Map<string, string[]>();
  readonly steering = new Map<string, string[]>();
  readonly interruptions = new Map<string, number>();
  private readonly statuses = new Map<string, "idle" | "working" | "offline">();
  private readonly transcripts = new Map<string, RuntimePortMessage[]>();

  constructor(
    private readonly respond: (sessionId: string, input: string) => string = (sessionId) =>
      `Response from ${sessionId}`,
  ) {}

  async send(sessionId: string, input: string): Promise<void> {
    const prompts = this.prompts.get(sessionId) ?? [];
    prompts.push(input);
    this.prompts.set(sessionId, prompts);
    const messages = this.transcripts.get(sessionId) ?? [];
    messages.push({ role: "user", content: input });
    messages.push({ role: "assistant", content: this.respond(sessionId, input) });
    this.transcripts.set(sessionId, messages);
  }

  async steer(sessionId: string, input: string): Promise<void> {
    const messages = this.steering.get(sessionId) ?? [];
    messages.push(input);
    this.steering.set(sessionId, messages);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interruptions.set(sessionId, (this.interruptions.get(sessionId) ?? 0) + 1);
    this.statuses.set(sessionId, "idle");
  }

  setStatus(sessionId: string, status: "idle" | "working" | "offline"): void {
    this.statuses.set(sessionId, status);
  }

  async status(sessionId: string): Promise<"idle" | "working" | "offline"> {
    return this.statuses.get(sessionId) ?? "idle";
  }

  async messages(sessionId: string): Promise<RuntimePortMessage[]> {
    return [...(this.transcripts.get(sessionId) ?? [])];
  }
}

class RecoverableRuntime implements AgentRuntimePort {
  private readonly turns = new Map<string, RuntimePortTurn>();
  startCount = 0;

  async send(): Promise<void> {
    throw new Error("legacy send must not be used when recoverable turns are available");
  }

  async startTurn(_sessionId: string, turnId: string, input: string): Promise<RuntimePortTurn> {
    const existing = this.turns.get(turnId);
    if (existing) return { ...existing, response: existing.response && { ...existing.response } };
    this.startCount += 1;
    const timestamp = new Date().toISOString();
    const turn: RuntimePortTurn = {
      id: turnId,
      status: "running",
      input,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.turns.set(turnId, turn);
    return { ...turn };
  }

  async turn(_sessionId: string, turnId: string): Promise<RuntimePortTurn | undefined> {
    const turn = this.turns.get(turnId);
    return turn ? { ...turn, response: turn.response && { ...turn.response } } : undefined;
  }

  complete(content: string): void {
    const turn = [...this.turns.values()].find((candidate) => candidate.status === "running");
    if (!turn) throw new Error("No running turn");
    turn.status = "completed";
    turn.response = { role: "assistant", content };
    turn.updatedAt = new Date().toISOString();
  }

  async status(): Promise<"idle" | "working"> {
    return [...this.turns.values()].some((turn) => turn.status === "running") ? "working" : "idle";
  }

  async messages(): Promise<RuntimePortMessage[]> {
    return [];
  }
}

class InterruptibleRuntime implements AgentRuntimePort {
  private statusValue: "idle" | "working" = "idle";
  private readonly transcript: RuntimePortMessage[] = [];
  private resolveActive: (() => void) | undefined;
  sendCount = 0;
  interruptCount = 0;

  async send(_sessionId: string, input: string): Promise<void> {
    this.sendCount += 1;
    this.transcript.push({ role: "user", content: input });
    this.statusValue = "working";
    if (this.sendCount === 1) {
      await new Promise<void>((resolve) => (this.resolveActive = resolve));
      return;
    }
    this.transcript.push({ role: "assistant", content: "Replacement completed" });
    this.statusValue = "idle";
  }

  async interrupt(_sessionId: string): Promise<void> {
    this.interruptCount += 1;
    this.statusValue = "idle";
    this.resolveActive?.();
  }

  async status(): Promise<"idle" | "working"> {
    return this.statusValue;
  }

  async messages(): Promise<RuntimePortMessage[]> {
    return [...this.transcript];
  }
}

async function waitUntil(assertion: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition was not met before timeout");
}

test("relay routes Workspace-local handles to stable agent identity ids", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const human = await client.createIdentity({ type: "human", displayName: "David" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
  const workspace = await client.createWorkspace({ slug: "workspace-routing", name: "Routing" });
  await client.addWorkspaceMember(workspace.id, {
    identityId: human.id,
    mentionHandle: "david",
    accessRole: "owner",
  });
  await client.addWorkspaceMember(workspace.id, {
    identityId: agent.id,
    mentionHandle: "builder",
    roleLabel: "implementation",
  });
  const channel = await client.createChannel({
    workspaceId: workspace.id,
    participantIds: [human.id, agent.id],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: agent.id, sessionId: "session-builder", runtime }],
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, {
      participantId: human.id,
      body: "Background context. @builder implement this",
    });
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    const prompt = runtime.prompts.get("session-builder")?.[0] ?? "";
    assert.match(prompt, new RegExp(`You are @builder \\(identity ${agent.id}\\)`));
    assert.match(prompt, /@david → @builder: Background context\. @builder implement this/);
    assert.equal((await client.listMessages(channel.id))[1]?.participantId, agent.id);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("relay caches revisioned rosters and stops waking disabled or removed members", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const cursors = new InMemoryChannelStorage();
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
  const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
  const workspace = await client.createWorkspace({ slug: "roster-cache", name: "Roster Cache" });
  await client.addWorkspaceMember(workspace.id, {
    identityId: owner.id,
    mentionHandle: "owner",
    accessRole: "owner",
  });
  await client.addWorkspaceMember(workspace.id, {
    identityId: agent.id,
    mentionHandle: "builder",
  });
  const channel = await client.createChannel({
    workspaceId: workspace.id,
    participantIds: [owner.id, agent.id],
  });
  const originalGetChannel = client.getChannel.bind(client);
  let metadataReads = 0;
  client.getChannel = async (channelId: string) => {
    metadataReads += 1;
    return originalGetChannel(channelId);
  };
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: agent.id, sessionId: "cached-session", runtime }],
    cursorStore: cursors,
  });
  try {
    await relay.start();
    assert.equal(metadataReads, 1);
    await client.updateWorkspaceMember(workspace.id, agent.id, {
      actorIdentityId: owner.id,
      mentionHandle: "implementer",
      roleLabel: "builder",
    });
    await waitUntil(async () => metadataReads === 2);
    await client.postMessage(channel.id, {
      participantId: owner.id,
      body: "@implementer use the revised roster",
    });
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    assert.match(runtime.prompts.get("cached-session")?.[0] ?? "", /@implementer/);
    assert.equal(metadataReads, 2);

    await client.updateWorkspaceMember(workspace.id, agent.id, {
      actorIdentityId: owner.id,
      status: "disabled",
    });
    await waitUntil(async () => metadataReads === 3);
    await client.postMessage(channel.id, {
      participantId: owner.id,
      body: "@channel disabled agents stay asleep",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.prompts.get("cached-session")?.length, 1);

    await client.updateChannelParticipants(channel.id, {
      actorIdentityId: owner.id,
      participantIds: [owner.id],
      expectedRosterRevision: 3,
    });
    await waitUntil(async () => metadataReads === 4);
    await client.postMessage(channel.id, {
      participantId: owner.id,
      body: "@channel removed agents also stay asleep",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(runtime.prompts.get("cached-session")?.length, 1);
    assert.equal(await cursors.getCursor(channel.id, agent.id), 3);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("removing an agent fences an active turn result and advances recovery", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new RecoverableRuntime();
  const cursors = new InMemoryChannelStorage();
  const [owner, agent] = await Promise.all([
    client.createIdentity({ type: "human", displayName: "Owner" }),
    client.createIdentity({ type: "agent", displayName: "Builder" }),
  ]);
  const workspace = await client.createWorkspace({ slug: "active-removal", name: "Active removal" });
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
  const channel = await client.createChannel({
    workspaceId: workspace.id,
    participantIds: [owner.id, agent.id],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: agent.id, sessionId: "removed-active", runtime }],
    cursorStore: cursors,
    turnPollIntervalMs: 5,
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, {
      participantId: owner.id,
      body: "@builder start work",
    });
    await waitUntil(async () => runtime.startCount === 1);
    await client.updateChannelParticipants(channel.id, {
      actorIdentityId: owner.id,
      participantIds: [owner.id],
      expectedRosterRevision: 1,
    });
    await waitUntil(async () => (await cursors.getCursor(channel.id, agent.id)) === 1);
    runtime.complete("This stale result must not be posted");
    await relay.waitForIdle();
    assert.equal((await client.listMessages(channel.id)).length, 1);
    assert.equal(relay.cursor(agent.id), 1);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("private bindings isolate Channel sessions and restore them under generation-safe leases", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const store = new InMemoryRelayBindingStore();
  const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
  const reviewer = await client.createIdentity({ type: "agent", displayName: "Reviewer" });
  const human = await client.createIdentity({ type: "human", displayName: "David" });
  const workspace = await client.createWorkspace({ slug: "private-bindings", name: "Bindings" });
  await client.addWorkspaceMember(workspace.id, {
    identityId: human.id,
    mentionHandle: "david",
    accessRole: "owner",
  });
  await client.addWorkspaceMember(workspace.id, {
    identityId: agent.id,
    mentionHandle: "builder",
  });
  await client.addWorkspaceMember(workspace.id, {
    identityId: reviewer.id,
    mentionHandle: "reviewer",
  });
  const channelParticipants = [human.id, agent.id, reviewer.id];
  const [channelA, channelB] = await Promise.all([
    client.createChannel({ workspaceId: workspace.id, participantIds: channelParticipants }),
    client.createChannel({ workspaceId: workspace.id, participantIds: channelParticipants }),
  ]);
  const directory = new LocalRelayDirectory(client, store);
  await directory.configureWorkspace({
    workspaceId: workspace.id,
    rootUri: "file:///workspace",
  });
  await Promise.all([
    directory.configureAgent({
      workspaceId: workspace.id,
      agentIdentityId: agent.id,
    }),
    directory.configureAgent({
      workspaceId: workspace.id,
      agentIdentityId: reviewer.id,
    }),
  ]);
  const bindingA = await directory.bindAgent({
    channelId: channelA.id,
    agentIdentityId: agent.id,
    runtimeAdapter: "fake",
    runtimeSessionId: "session-channel-a",
  });
  await Promise.all([
    directory.bindAgent({
      channelId: channelB.id,
      agentIdentityId: agent.id,
      runtimeAdapter: "fake",
      runtimeSessionId: "session-channel-b",
    }),
    directory.bindAgent({
      channelId: channelA.id,
      agentIdentityId: reviewer.id,
      runtimeAdapter: "fake",
      runtimeSessionId: "reviewer-channel-a",
    }),
    directory.bindAgent({
      channelId: channelB.id,
      agentIdentityId: reviewer.id,
      runtimeAdapter: "fake",
      runtimeSessionId: "reviewer-channel-b",
    }),
  ]);
  const publicMetadata = JSON.stringify(await client.getChannel(channelA.id));
  assert.doesNotMatch(publicMetadata, /session-channel-a|file:\/\/\/workspace/);

  const first = await restoreChannelBindings({
    client,
    store,
    channelId: channelA.id,
    leaseOwner: "relay-one",
    runtimes: { fake: runtime },
    leaseDurationMs: 300,
  });
  const competitor = await restoreChannelBindings({
    client,
    store,
    channelId: channelA.id,
    leaseOwner: "relay-two",
    runtimes: { fake: runtime },
  });
  const otherChannel = await restoreChannelBindings({
    client,
    store,
    channelId: channelB.id,
    leaseOwner: "relay-two",
    runtimes: { fake: runtime },
  });
  try {
    assert.deepEqual(
      first.bindings.map(({ sessionId }) => sessionId).sort(),
      ["reviewer-channel-a", "session-channel-a"],
    );
    assert.equal(competitor.bindings.length, 0);
    assert.deepEqual(
      otherChannel.bindings.map(({ sessionId }) => sessionId).sort(),
      ["reviewer-channel-b", "session-channel-b"],
    );
    assert.equal(await first.renew(), true);
    let leaseLost = false;
    first.startAutoRenew(() => {
      leaseLost = true;
    });
    const replaced = await directory.replaceSession({
      bindingId: bindingA.id,
      expectedGeneration: 1,
      runtimeAdapter: "fake",
      runtimeSessionId: "replacement-channel-a",
    });
    assert.equal(replaced.generation, 2);
    const staleBinding = first.bindings.find(({ sessionId }) => sessionId === "session-channel-a");
    assert.equal(await staleBinding?.verifyLease?.(), false);
    await waitUntil(async () => leaseLost);
  } finally {
    await Promise.all([first.close(), competitor.close(), otherChannel.close()]);
  }
  assert.equal(
    await store.replaceBindingSession(
      bindingA.id,
      1,
      "fake",
      "stale-overwrite",
      new Date().toISOString(),
    ),
    undefined,
  );
  const restarted = await restoreChannelBindings({
    client,
    store,
    channelId: channelA.id,
    leaseOwner: "relay-after-restart",
    runtimes: { fake: runtime },
  });
  assert.deepEqual(
    restarted.bindings.map(({ sessionId }) => sessionId).sort(),
    ["replacement-channel-a", "reviewer-channel-a"],
  );
  await restarted.close();

  runtime.setStatus("replacement-channel-a", "offline");
  const offline = await restoreChannelBindings({
    client,
    store,
    channelId: channelA.id,
    leaseOwner: "relay-offline",
    runtimes: { fake: runtime },
  });
  assert.deepEqual(
    offline.bindings.map(({ sessionId }) => sessionId),
    ["reviewer-channel-a"],
  );
  assert.equal((await store.getBinding(bindingA.id))?.state, "offline");
  await offline.close();
  await server.close();
});

test("relay catches up on addressed messages using a persisted cursor", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const cursors = new InMemoryChannelStorage();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  const createRelay = () =>
    new ChannelRuntimeRelay({
      client,
      channelId: channel.id,
      bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
      cursorStore: cursors,
    });

  let relay = createRelay();
  try {
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a first" });
    await relay.start();
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    await relay.stop();
    assert.equal(await cursors.getCursor(channel.id, "agent-a"), 1);

    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a second" });
    relay = createRelay();
    await relay.start();
    await waitUntil(async () =>
      (await client.listMessages(channel.id)).length === 4 &&
      (await cursors.getCursor(channel.id, "agent-a")) === 3,
    );
    assert.equal(runtime.prompts.get("session-a")?.length, 2);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("two-participant Channels implicitly wake the sole agent for human messages", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  });

  try {
    await relay.start();
    await client.postMessage(channel.id, {
      participantId: "user",
      body: "Create the query without requiring a mention",
    });
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    assert.equal(runtime.prompts.get("session-a")?.length, 1);
    assert.match(
      runtime.prompts.get("session-a")![0]!,
      /implicitly addressed you in this two-participant Channel/,
    );
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("an addressed turn includes bounded Channel history from before the binding cursor", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const cursors = new InMemoryChannelStorage();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
      { id: "observer", type: "human" },
    ],
  });
  await client.postMessage(channel.id, {
    participantId: "user",
    body: "Historical record needed by the next request",
  });
  await cursors.setCursor(channel.id, "agent-a", 1);
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore: cursors,
  });

  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a see above" });
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 3);
    assert.match(runtime.prompts.get("session-a")![0]!, /Historical record needed by the next request/);
    assert.match(runtime.prompts.get("session-a")![0]!, /@agent-a see above/);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("relay suppresses an active result after its private binding lease is lost", async () => {
  const storage = new InMemoryChannelStorage();
  const server = await createChannelHttpServer({ service: new ChannelService(storage) });
  const client = new ChannelClient(server.endpoint);
  const runtime = new RecoverableRuntime();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  let leaseHeld = true;
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{
      participantId: "agent-a",
      sessionId: "leased-session",
      runtime,
      verifyLease: async () => leaseHeld,
    }],
    cursorStore: storage,
    turnPollIntervalMs: 5,
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a do not publish after fencing",
    });
    await waitUntil(async () => runtime.startCount === 1);
    leaseHeld = false;
    runtime.complete("STALE_RESPONSE");
    await relay.waitForIdle();
    assert.equal((await client.listMessages(channel.id)).length, 1);
    assert.equal(await storage.getCursor(channel.id, "agent-a"), 0);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("overlapping relay recovery reuses active turns and preserves queued messages", async () => {
  const storage = new InMemoryChannelStorage();
  const server = await createChannelHttpServer({ service: new ChannelService(storage) });
  const client = new ChannelClient(server.endpoint);
  const runtime = new RecoverableRuntime();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  const createRelay = () => new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore: storage,
  });
  const firstRelay = createRelay();
  const recoveredRelay = createRelay();
  try {
    await firstRelay.start();
    await client.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a perform side effects once",
    });
    await waitUntil(async () => runtime.startCount === 1);
    await client.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a queued follow-up",
    });
    await recoveredRelay.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runtime.startCount, 1);

    runtime.complete("Completed first exactly once");
    await waitUntil(async () => runtime.startCount === 2);
    runtime.complete("Completed follow-up exactly once");
    await waitUntil(async () =>
      (await client.listMessages(channel.id)).length === 4
      && (await storage.getCursor(channel.id, "agent-a")) === 2,
    );
    assert.equal(runtime.startCount, 2);
    assert.deepEqual(
      (await client.listMessages(channel.id)).map((message) => message.body),
      [
        "@agent-a perform side effects once",
        "@agent-a queued follow-up",
        "Completed first exactly once",
        "Completed follow-up exactly once",
      ],
    );
  } finally {
    await Promise.all([firstRelay.stop(), recoveredRelay.stop()]);
    await server.close();
  }
});

test("relay validates and enforces configurable turn polling timeouts", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new RecoverableRuntime();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  const baseOptions = {
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  };
  assert.throws(
    () => new ChannelRuntimeRelay({ ...baseOptions, turnPollIntervalMs: 0 }),
    /turnPollIntervalMs must be a positive integer/,
  );
  assert.throws(
    () => new ChannelRuntimeRelay({ ...baseOptions, turnTimeoutMs: 1.5 }),
    /turnTimeoutMs must be a positive integer/,
  );
  const errors: Error[] = [];
  const relay = new ChannelRuntimeRelay({
    ...baseOptions,
    turnPollIntervalMs: 5,
    turnTimeoutMs: 30,
    onError(_binding, error) {
      errors.push(error);
    },
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a deliberately never complete",
    });
    await waitUntil(async () => errors.length === 1);
    assert.match(errors[0]!.message, /Timed out waiting for agent turn/);
    assert.equal(runtime.startCount, 1);
    assert.equal((await client.listMessages(channel.id)).length, 1);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("relay restart does not duplicate a committed response after its acknowledgement is lost", async () => {
  const storage = new InMemoryChannelStorage();
  const server = await createChannelHttpServer({ service: new ChannelService(storage) });
  const reliableClient = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const channel = await reliableClient.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  class LostAcknowledgementClient extends ChannelClient {
    private loseNextAcknowledgement = true;

    override async postResponse(
      channelId: string,
      input: CreateResponseInput,
    ): Promise<ResponseResult> {
      const committed = await super.postResponse(channelId, input);
      if (this.loseNextAcknowledgement) {
        this.loseNextAcknowledgement = false;
        throw new Error("connection dropped after commit");
      }
      return committed;
    }
  }
  const firstRelay = new ChannelRuntimeRelay({
    client: new LostAcknowledgementClient(server.endpoint),
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore: storage,
  });
  try {
    await firstRelay.start();
    await reliableClient.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a implement once",
    });
    await waitUntil(async () =>
      (await storage.getCursor(channel.id, "agent-a")) === 1
      && (await reliableClient.listMessages(channel.id)).length === 2,
    );
    await firstRelay.stop();
    assert.equal(runtime.prompts.get("session-a")?.length, 1);

    const restartedRelay = new ChannelRuntimeRelay({
      client: reliableClient,
      channelId: channel.id,
      bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
      cursorStore: storage,
    });
    await restartedRelay.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runtime.prompts.get("session-a")?.length, 1);
    assert.equal((await reliableClient.listMessages(channel.id)).length, 2);
    await restartedRelay.stop();
  } finally {
    await firstRelay.stop();
    await server.close();
  }
});

test("relay supports an explicit agent-to-agent mention handoff", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime((sessionId) =>
    sessionId === "session-a" ? "@agent-b Please review Agent A's work" : "Review complete",
  );
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
      { id: "agent-b", type: "agent" },
    ],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [
      { participantId: "agent-a", sessionId: "session-a", runtime },
      { participantId: "agent-b", sessionId: "session-b", runtime },
    ],
  });

  try {
    await relay.start();
    await client.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a Implement the change, then hand off review",
    });
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 3);
    const messages = await client.listMessages(channel.id);
    assert.deepEqual(messages.map((message) => message.participantId), ["user", "agent-a", "agent-b"]);
    assert.deepEqual(messages[1]!.to, ["agent-b"]);
    assert.deepEqual(messages[2]!.to, []);
    assert.equal(runtime.prompts.get("session-a")?.length, 1);
    assert.equal(runtime.prompts.get("session-b")?.length, 1);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("explicit steering reaches a working agent without creating another wake-up", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  });
  try {
    await relay.start();
    runtime.setStatus("session-a", "working");
    await relay.steer("agent-a", "user", "Include persistence in the MVP");
    assert.deepEqual(runtime.steering.get("session-a"), ["Include persistence in the MVP"]);
    const messages = await client.listMessages(channel.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.body, "[steer → agent-a] Include persistence in the MVP");
    assert.deepEqual(messages[0]!.to, []);
    assert.equal(runtime.prompts.size, 0);
  } finally {
    runtime.setStatus("session-a", "idle");
    await relay.stop();
    await server.close();
  }
});

test("explicit interruption aborts work and queues a normal replacement turn", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  });
  try {
    await relay.start();
    runtime.setStatus("session-a", "working");
    await relay.interrupt("agent-a", "user", "Use Drizzle instead");
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    assert.equal(runtime.interruptions.get("session-a"), 1);
    const messages = await client.listMessages(channel.id);
    assert.equal(messages[0]!.body, "@agent-a [replacement after interrupt] Use Drizzle instead");
    assert.deepEqual(messages[0]!.to, ["agent-a"]);
    assert.equal(messages[1]!.participantId, "agent-a");
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("interrupting an active relay turn suppresses its response and runs the replacement", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new InterruptibleRuntime();
  const cursorStore = new InMemoryChannelStorage();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human" },
      { id: "agent-a", type: "agent" },
    ],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore,
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a Start the original task",
    });
    await waitUntil(async () => (await runtime.status()) === "working");
    await relay.interrupt("agent-a", "user", "Do the replacement task");
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 3);
    const messages = await client.listMessages(channel.id);
    assert.equal(runtime.interruptCount, 1);
    assert.equal(runtime.sendCount, 2);
    assert.equal(messages[1]!.body, "@agent-a [replacement after interrupt] Do the replacement task");
    assert.equal(messages[2]!.body, "Replacement completed");
    assert.equal(messages.some((message) => message.body.includes("original response")), false);
    assert.equal(relay.cursor("agent-a"), 2);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("relay wakes only addressed agents and posts responses without reply loops", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint);
  const runtime = new FakeRuntime();
  const channel = await client.createChannel({
    participants: [
      { id: "user", type: "human", displayName: "David", role: "coordinator" },
      {
        id: "agent-a",
        type: "agent",
        displayName: "Builder",
        role: "implementation",
        profile: "Builds requested changes and prepares them for review.",
      },
      {
        id: "agent-b",
        type: "agent",
        displayName: "Reviewer",
        role: "review",
        profile: "Reviews correctness and regressions.",
      },
    ],
  });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [
      { participantId: "agent-a", sessionId: "session-a", runtime },
      { participantId: "agent-b", sessionId: "session-b", runtime },
    ],
  });

  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "Background context" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runtime.prompts.size, 0);

    await client.postMessage(channel.id, {
      participantId: "user",
      body: "@agent-a Please inspect this",
    });
    await waitUntil(async () =>
      (await client.listMessages(channel.id)).length === 3 && relay.cursor("agent-a") === 2,
    );
    assert.equal(runtime.prompts.get("session-a")?.length, 1);
    assert.equal(runtime.prompts.get("session-b"), undefined);
    assert.match(runtime.prompts.get("session-a")![0]!, /Background context/);
    assert.match(
      runtime.prompts.get("session-a")![0]!,
      /@user — human — identity: user — name: David — role: coordinator/,
    );
    assert.match(
      runtime.prompts.get("session-a")![0]!,
      /@agent-b — agent — identity: agent-b — name: Reviewer — role: review — runtime-connected/,
    );
    assert.match(
      runtime.prompts.get("session-a")![0]!,
      /Role: Reviews correctness and regressions\./,
    );
    assert.match(runtime.prompts.get("session-a")![0]!, /Mentions wake agents and consume compute/);
    assert.match(runtime.prompts.get("session-a")![0]!, /TRIGGER/);
    assert.equal(relay.cursor("agent-a"), 2);

    await client.postMessage(channel.id, { participantId: "user", body: "@channel status" });
    await waitUntil(async () => {
      const messages = await client.listMessages(channel.id);
      return messages.filter((message) => message.participantId.startsWith("agent-")).length === 3;
    });
    assert.equal(runtime.prompts.get("session-a")?.length, 2);
    assert.equal(runtime.prompts.get("session-b")?.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await client.listMessages(channel.id)).length, 6);
  } finally {
    await relay.stop();
    await server.close();
  }
});
