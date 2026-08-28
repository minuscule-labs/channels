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
  ChannelRuntimeRelay,
  type AgentRuntimePort,
  type RuntimePortMessage,
} from "../src/relay.js";

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
      /@user — human — name: David — role: coordinator/,
    );
    assert.match(
      runtime.prompts.get("session-a")![0]!,
      /@agent-b — agent — name: Reviewer — role: review — runtime-connected/,
    );
    assert.match(
      runtime.prompts.get("session-a")![0]!,
      /Delegation guidance: Reviews correctness and regressions\./,
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
