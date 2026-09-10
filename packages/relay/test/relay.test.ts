import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelClient,
  ChannelClientError,
  ChannelService,
  createChannelHttpServer,
  InMemoryChannelStorage,
  isResourceId,
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const [agentConfig] = await Promise.all([
    directory.configureAgent({
      workspaceId: workspace.id,
      agentIdentityId: agent.id,
    }),
    directory.configureAgent({
      workspaceId: workspace.id,
      agentIdentityId: reviewer.id,
    }),
  ]);
  assert.equal(isResourceId(agentConfig.id, "config"), true);
  const bindingA = await directory.bindAgent({
    channelId: channelA.id,
    agentIdentityId: agent.id,
    runtimeAdapter: "fake",
    runtimeSessionId: "session-channel-a",
  });
  assert.equal(isResourceId(bindingA.id, "binding"), true);
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

  const originalGetAgentConfig = store.getAgentConfig.bind(store);
  store.getAgentConfig = async () => { throw new Error("forced configuration lookup failure"); };
  await assert.rejects(restoreChannelBindings({
    client,
    store,
    channelId: channelA.id,
    bindingIds: [bindingA.id],
    leaseOwner: "single-failure",
    runtimes: { fake: runtime },
    leaseDurationMs: 15,
  }), /forced configuration lookup failure/);
  store.getAgentConfig = originalGetAgentConfig;
  assert.equal((await store.getBinding(bindingA.id))?.leaseOwner, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await store.getBinding(bindingA.id))?.leaseOwner, undefined);

  let configurationLookups = 0;
  store.getAgentConfig = async (configId) => {
    configurationLookups += 1;
    if (configurationLookups === 2) throw new Error("forced later candidate failure");
    return originalGetAgentConfig(configId);
  };
  await assert.rejects(restoreChannelBindings({
    client,
    store,
    channelId: channelA.id,
    leaseOwner: "multi-failure",
    runtimes: { fake: runtime },
    leaseDurationMs: 15,
  }), /forced later candidate failure/);
  store.getAgentConfig = originalGetAgentConfig;
  assert.equal((await store.listChannelBindings(channelA.id)).every(({ leaseOwner }) => leaseOwner === undefined), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await store.listChannelBindings(channelA.id)).every(({ leaseOwner }) => leaseOwner === undefined), true);

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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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

test("relay catch-up paginates beyond one bounded message page", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  const runtime = new FakeRuntime();
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  try {
    for (let index = 0; index < 501; index += 1) {
      await server.service.createMessage(channel.id, { participantId: "agent-a", body: `self-${index}` });
    }
    const trigger = await server.service.createMessage(channel.id, { participantId: "user", body: "@agent-a paginated" });
    const relay = new ChannelRuntimeRelay({
      client, channelId: channel.id,
      bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
      cursorStore: server.service.storage,
    });
    try {
      await relay.start();
      await waitUntil(async () => (await server.service.storage.getCursor(channel.id, "agent-a")) === trigger.sequence);
      assert.equal(runtime.prompts.get("session-a")?.length, 1);
    } finally { await relay.stop(); }
  } finally { await server.close(); }
});

test("dynamic attach orders buffered live events behind catch-up", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  const runtime = new FakeRuntime();
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" },
    { id: "agent-a", type: "agent" },
    { id: "agent-b", type: "agent" },
  ] });
  const historical = await client.postMessage(channel.id, {
    participantId: "user",
    to: ["agent-b"],
    body: "historical trigger",
  });
  const originalListMessages = client.listMessages.bind(client);
  const originalEvents = client.events.bind(client);
  let releaseCatchUp!: () => void;
  const catchUpReleased = new Promise<void>((resolve) => { releaseCatchUp = resolve; });
  let catchUpCaptured!: () => void;
  const captured = new Promise<void>((resolve) => { catchUpCaptured = resolve; });
  let liveObserved!: () => void;
  const observed = new Promise<void>((resolve) => { liveObserved = resolve; });
  let intercept = false;
  client.listMessages = (async (channelId, options) => {
    const messages = await originalListMessages(channelId, options);
    if (intercept && options?.afterSequence === 0) {
      intercept = false;
      catchUpCaptured();
      await catchUpReleased;
    }
    return messages;
  }) as ChannelClient["listMessages"];
  client.events = ((channelId, options) => {
    const events = originalEvents(channelId, options);
    return (async function* () {
      for await (const event of events) {
        yield event;
        if (event.type === "message.created" && event.message.body === "live trigger") {
          liveObserved();
        }
      }
    })();
  }) as ChannelClient["events"];
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  });
  try {
    await relay.start();
    intercept = true;
    const attaching = relay.attach({ participantId: "agent-b", sessionId: "session-b", runtime });
    await captured;
    const live = await client.postMessage(channel.id, {
      participantId: "user",
      to: ["agent-b"],
      body: "live trigger",
    });
    await observed;
    releaseCatchUp();
    await attaching;
    await waitUntil(async () => relay.cursor("agent-b") === live.sequence);
    const prompts = runtime.prompts.get("session-b") ?? [];
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, new RegExp(`\\[${historical.sequence}\\].*historical trigger`));
    assert.match(prompts[1]!, new RegExp(`\\[${live.sequence}\\].*live trigger`));
  } finally {
    releaseCatchUp();
    await relay.stop();
    await server.close();
  }
});

test("two-participant Channels implicitly wake the sole agent for human messages", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const reliableClient = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
    client: new LostAcknowledgementClient(server.endpoint, { serviceToken: server.serviceToken }),
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

test("a failed trigger blocks later cursor advancement until ordered retry succeeds", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let attempts = 0;
  const timestamp = new Date().toISOString();
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; },
    async send() { throw new Error("legacy send must not be used"); },
    async messages() { return []; },
    async turn() { return undefined; },
    async startTurn(_sessionId, turnId, input) {
      attempts += 1;
      if (attempts === 1) throw new Error("transient failure");
      return {
        id: turnId,
        input,
        status: "completed" as const,
        response: { role: "assistant" as const, content: `attempt ${attempts}` },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client, channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore: server.service.storage,
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a first" });
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a second" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await server.service.storage.getCursor(channel.id, "agent-a"), 0);
    await waitUntil(async () => (await server.service.storage.getCursor(channel.id, "agent-a")) === 2);
    assert.equal(attempts, 3);
  } finally { await relay.stop(); await server.close(); }
});

test("Relay activity exposes retrying phase and the next attempt", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let sends = 0;
  const timestamp = new Date().toISOString();
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; },
    async send() { throw new Error("legacy send must not be used"); },
    async messages() { return []; },
    async turn() { return undefined; },
    async startTurn(_sessionId, turnId, input) {
      sends += 1;
      if (sends === 1) throw new Error("transient Runtime bridge failure");
      return {
        id: turnId,
        input,
        status: "completed" as const,
        response: { role: "assistant" as const, content: "retried" },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a retry visibly" });
    await waitUntil(async () => relay.activity("agent-a")?.phase === "retrying");
    assert.equal(relay.activity("agent-a")?.retryAttempt, 2);
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
  } finally { await relay.stop(); await server.close(); }
});

test("terminal Runtime failure is recorded visibly before the cursor advances", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  const runtime: AgentRuntimePort = {
    async send() {}, async messages() { return []; }, async status() { return "idle"; },
    async turn() { return undefined; },
    async startTurn(_sessionId, turnId, input) {
      const timestamp = new Date().toISOString();
      return { id: turnId, input, status: "failed", error: "provider failed", createdAt: timestamp, updatedAt: timestamp };
    },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client, channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore: server.service.storage,
  });
  try {
    await relay.start();
    const trigger = await client.postMessage(channel.id, { participantId: "user", body: "@agent-a fail" });
    await waitUntil(async () => (await server.service.storage.getCursor(channel.id, "agent-a")) === trigger.sequence);
    const messages = await client.listMessages(channel.id);
    assert.match(messages[1]!.body, /Runtime turn failed/);
  } finally { await relay.stop(); await server.close(); }
});

test("permanent response delivery rejection does not retry or block Relay shutdown", async () => {
  const server = await createChannelHttpServer();
  const reliableClient = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  class RejectingClient extends ChannelClient {
    calls = 0;
    override async postResponse(
      _channelId: string,
      _input: CreateResponseInput,
    ): Promise<ResponseResult> {
      this.calls += 1;
      throw new ChannelClientError("response validation failed", 422);
    }
  }
  const client = new RejectingClient(server.endpoint, { serviceToken: server.serviceToken });
  const timestamp = new Date().toISOString();
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; }, async send() {}, async messages() { return []; },
    async turn() { return undefined; },
    async startTurn(_sessionId, turnId, input) {
      return { id: turnId, input, status: "failed", createdAt: timestamp, updatedAt: timestamp };
    },
  };
  const channel = await reliableClient.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client, channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  });
  try {
    await relay.start();
    await reliableClient.postMessage(channel.id, { participantId: "user", body: "@agent-a fail" });
    await waitUntil(async () => client.calls === 1);
    await relay.waitForIdle();
    assert.equal(client.calls, 1);
  } finally { await relay.stop(); await server.close(); }
});

test("legacy Runtime does not resend after an ambiguous send failure", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let sends = 0;
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; },
    async send() { sends += 1; throw new Error("connection dropped after send"); },
    async messages() { return []; },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore: server.service.storage,
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a do not resend" });
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    assert.equal(sends, 1);
    assert.match((await client.listMessages(channel.id))[1]!.body, /Runtime turn failed/);
  } finally { await relay.stop(); await server.close(); }
});

test("legacy Runtime response recovery survives transcript compaction", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let compacted = false;
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; },
    async send() { compacted = true; },
    async messages() {
      return compacted
        ? [{ role: "assistant", content: "response after compaction" }]
        : Array.from({ length: 3 }, (_, index) => ({ role: "user" as const, content: `old-${index}` }));
    },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client, channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a compact" });
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    assert.equal((await client.listMessages(channel.id))[1]?.body, "response after compaction");
  } finally { await relay.stop(); await server.close(); }
});

test("Relay shutdown is bounded when a Runtime request stalls", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  const runtime: AgentRuntimePort = {
    async send() {}, async messages() { return []; },
    async status() { return await new Promise<"idle">(() => {}); },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client, channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    runtimeRequestTimeoutMs: 20,
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a stall" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    await relay.stop();
    assert.ok(Date.now() - started < 200);
  } finally { await relay.stop(); await server.close(); }
});

test("relay supports an explicit agent-to-agent mention handoff", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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

test("relay exposes active queue state and cancels only the current turn", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  const runtime = new InterruptibleRuntime();
  const cursorStore = new InMemoryChannelStorage();
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    cursorStore,
  });
  try {
    await relay.start();
    const first = await client.postMessage(channel.id, { participantId: "user", body: "@agent-a first" });
    await waitUntil(async () => (await runtime.status()) === "working");
    const initial = relay.activity("agent-a");
    assert.deepEqual(initial && {
      phase: initial.phase,
      triggerMessageId: initial.triggerMessageId,
      triggerSequence: initial.triggerSequence,
      queuedTurns: initial.queuedTurns,
    }, {
      phase: "running",
      triggerMessageId: first.id,
      triggerSequence: first.sequence,
      queuedTurns: 0,
    });
    assert.ok(initial?.startedAt);
    const startedAt = initial!.startedAt;
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a second" });
    await waitUntil(async () => relay.activity("agent-a")?.queuedTurns === 1);
    assert.equal(relay.activity("agent-a")?.startedAt, startedAt);

    await relay.cancelCurrent("agent-a", "user");
    await relay.cancelCurrent("agent-a", "user");
    assert.equal(relay.activity("agent-a")?.phase, "canceling");
    await waitUntil(async () => runtime.interruptCount === 1);
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 4);
    const messages = await client.listMessages(channel.id);
    assert.equal(runtime.interruptCount, 1);
    assert.equal(messages.some((message) => message.body === "Current request was canceled by @user."), true);
    assert.equal(messages.some((message) => message.body.includes("original")), false);
    assert.equal(await cursorStore.getCursor(channel.id, "agent-a"), 2);
    assert.equal(relay.activity("agent-a"), undefined);
  } finally {
    await relay.stop();
    await server.close();
  }
});

test("cancellation before recoverable turn dispatch never starts Runtime work", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let resolveLookup!: (turn: RuntimePortTurn | undefined) => void;
  let lookups = 0;
  let starts = 0;
  let interrupts = 0;
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; },
    async send() { throw new Error("legacy send must not be used"); },
    async messages() { return []; },
    turn() {
      lookups += 1;
      return new Promise<RuntimePortTurn | undefined>((resolve) => { resolveLookup = resolve; });
    },
    async startTurn() { starts += 1; throw new Error("must not start"); },
    async interrupt() { interrupts += 1; },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({ client, channelId: channel.id, bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }] });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a do not dispatch" });
    await waitUntil(async () => lookups === 1);
    await relay.cancelCurrent("agent-a", "user");
    resolveLookup(undefined);
    await waitUntil(async () => (await client.listMessages(channel.id)).length === 2);
    assert.equal(starts, 0);
    assert.equal(interrupts, 0);
    assert.equal((await client.listMessages(channel.id))[1]?.body, "Current request was canceled by @user.");
  } finally { await relay.stop(); await server.close(); }
});

test("a delayed session interrupt cannot reach the next queued turn", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let starts = 0;
  let interrupted = false;
  let firstTurnId: string | undefined;
  let releaseInterrupt!: () => void;
  const timestamp = new Date().toISOString();
  const runtime: AgentRuntimePort = {
    async send() { throw new Error("legacy send must not be used"); },
    async messages() { return []; },
    async status() { return starts === 0 || interrupted ? "idle" : "working"; },
    async startTurn(_sessionId, turnId, input) {
      starts += 1;
      if (starts === 1) {
        firstTurnId = turnId;
        return { id: turnId, input, status: "running", createdAt: timestamp, updatedAt: timestamp };
      }
      return { id: turnId, input, status: "completed", response: { role: "assistant" as const, content: "second completed" }, createdAt: timestamp, updatedAt: timestamp };
    },
    async turn(_sessionId, turnId) {
      if (turnId === firstTurnId) return { id: turnId, input: "first", status: interrupted ? "interrupted" : "running", createdAt: timestamp, updatedAt: timestamp };
      return starts >= 2
        ? { id: turnId, input: "second", status: "completed", response: { role: "assistant" as const, content: "second completed" }, createdAt: timestamp, updatedAt: timestamp }
        : undefined;
    },
    interrupt() {
      return new Promise<void>((resolve) => { releaseInterrupt = () => { interrupted = true; resolve(); }; });
    },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({ client, channelId: channel.id, bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }], turnPollIntervalMs: 5 });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a first" });
    await waitUntil(async () => starts === 1);
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a second" });
    await waitUntil(async () => relay.activity("agent-a")?.queuedTurns === 1);
    await relay.cancelCurrent("agent-a", "user");
    await waitUntil(async () => typeof releaseInterrupt === "function");
    assert.equal(starts, 1);
    releaseInterrupt();
    await waitUntil(async () => starts === 2);
    assert.equal((await client.listMessages(channel.id)).some((message) => message.body === "Current request was canceled by @user."), true);
  } finally { await relay.stop(); await server.close(); }
});

test("a lease check failure does not poison later queued turns", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let starts = 0;
  const turns = new Map<string, RuntimePortTurn>();
  let leaseChecks = 0;
  const errors: Error[] = [];
  const timestamp = new Date().toISOString();
  const runtime: AgentRuntimePort = {
    async send() { throw new Error("legacy send must not be used"); },
    async messages() { return []; },
    async status() { return "idle"; },
    async startTurn(_sessionId, turnId, input) {
      starts += 1;
      const turn: RuntimePortTurn = starts === 1
        ? { id: turnId, input, status: "failed", error: "first failed", createdAt: timestamp, updatedAt: timestamp }
        : { id: turnId, input, status: "completed", response: { role: "assistant", content: "second completed" }, createdAt: timestamp, updatedAt: timestamp };
      turns.set(turnId, turn);
      return turn;
    },
    async turn(_sessionId, turnId) { return turns.get(turnId); },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime, verifyLease: async () => {
      leaseChecks += 1;
      if (leaseChecks === 2) throw new Error("db temporarily unavailable");
      return true;
    } }],
    onError: (_binding, error) => errors.push(error),
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a first" });
    await waitUntil(async () => errors.some((error) => error.message === "db temporarily unavailable"));
    await waitUntil(async () => (await client.listMessages(channel.id)).some((message) => message.body.includes("Runtime turn failed")));
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a second" });
    await waitUntil(async () => (await client.listMessages(channel.id)).some((message) => message.body === "second completed"));
    assert.equal(starts, 2);
    await relay.stop();
  } finally { await server.close(); }
});

test("an ambiguous Runtime interrupt remains canceling and is not retried", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
  let started = false;
  let interrupts = 0;
  const timestamp = new Date().toISOString();
  const runtime: AgentRuntimePort = {
    async send() { throw new Error("legacy send must not be used"); },
    async messages() { return []; },
    async status() { return started ? "working" : "idle"; },
    async startTurn(_sessionId, turnId, input) {
      started = true;
      return { id: turnId, input, status: "running", createdAt: timestamp, updatedAt: timestamp };
    },
    async turn(_sessionId, turnId) {
      return started
        ? { id: turnId, input: "pending", status: "running", createdAt: timestamp, updatedAt: timestamp }
        : undefined;
    },
    async interrupt() {
      interrupts += 1;
      throw new Error("connection dropped after interrupt invocation");
    },
  };
  const channel = await client.createChannel({ participants: [
    { id: "user", type: "human" }, { id: "agent-a", type: "agent" },
  ] });
  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [{ participantId: "agent-a", sessionId: "session-a", runtime }],
    turnPollIntervalMs: 5,
  });
  try {
    await relay.start();
    await client.postMessage(channel.id, { participantId: "user", body: "@agent-a remain observable" });
    await waitUntil(async () => started);
    await relay.cancelCurrent("agent-a", "user");
    await relay.cancelCurrent("agent-a", "user");
    await waitUntil(async () => relay.activity("agent-a")?.phase === "canceling");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(interrupts, 1);
    assert.equal((await client.listMessages(channel.id)).length, 1);
  } finally { await relay.stop(); await server.close(); }
});

test("relay wakes only addressed agents and posts responses without reply loops", async () => {
  const server = await createChannelHttpServer();
  const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
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
