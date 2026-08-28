import assert from "node:assert/strict";
import test from "node:test";
import { createChannelHttpServer } from "../src/http-server.js";

async function jsonRequest(endpoint: string, path: string, init?: RequestInit) {
  const response = await fetch(`${endpoint}${path}`, init);
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

async function readSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<string> {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const frame = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      return frame;
    }
    const next = await reader.read();
    if (next.done) throw new Error("SSE stream ended before a complete frame");
    state.buffer += decoder.decode(next.value, { stream: true });
  }
}

async function createTestChannel(endpoint: string) {
  const result = await jsonRequest(endpoint, "/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participants: [
        {
          id: "agent-a",
          type: "agent",
          displayName: "Builder",
          role: "implementation",
          profile: "Builds and tests requested changes.",
        },
        {
          id: "agent-b",
          type: "agent",
          displayName: "Reviewer",
          role: "review",
          profile: "Reviews correctness and regressions.",
        },
      ],
    }),
  });
  assert.equal(result.response.status, 201);
  return result.body.channel as { id: string; participants: unknown[]; messages: unknown[] };
}

test("creates a channel and starts with no messages", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server.endpoint);
    assert.equal(channel.participants.length, 2);
    assert.deepEqual(channel.messages, []);

    const fetched = await jsonRequest(server.endpoint, `/channels/${channel.id}`);
    assert.equal(fetched.response.status, 200);
    const fetchedChannel = fetched.body.channel as {
      participants: Array<{ id: string; role?: string; profile?: string }>;
      messages?: unknown;
    };
    assert.equal("messages" in fetchedChannel, false);
    assert.deepEqual(fetchedChannel.participants[0], {
      id: "agent-a",
      type: "agent",
      displayName: "Builder",
      role: "implementation",
      profile: "Builds and tests requested changes.",
    });

    const listed = await jsonRequest(server.endpoint, `/channels/${channel.id}/messages`);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.messages, []);
  } finally {
    await server.close();
  }
});

test("assigns per-channel sequences and resolves channel mentions", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server.endpoint);
    const clientMessage = async (body: string) =>
      (
        await jsonRequest(server.endpoint, `/channels/${channel.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ participantId: "agent-a", body }),
        })
      ).body.message as { sequence: number; to: string[] };

    const first = await clientMessage("status update");
    assert.equal(first.sequence, 1);
    assert.deepEqual(first.to, []);
    const second = await clientMessage("@channel please inspect");
    assert.equal(second.sequence, 2);
    assert.deepEqual(second.to, ["@channel"]);
  } finally {
    await server.close();
  }
});

test("commits one idempotent response and advances its cursor atomically", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server.endpoint);
    const triggerResult = await jsonRequest(server.endpoint, `/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "agent-a", body: "@agent-b review this" }),
    });
    const trigger = triggerResult.body.message as { id: string; sequence: number };
    let responseEvents = 0;
    const unsubscribe = await server.service.subscribe(channel.id, () => {
      responseEvents += 1;
    });
    const input = {
      participantId: "agent-b",
      body: "Review complete",
      triggerMessageId: trigger.id,
      triggerSequence: trigger.sequence,
    };
    const [first, duplicate] = await Promise.all([
      jsonRequest(server.endpoint, `/channels/${channel.id}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      jsonRequest(server.endpoint, `/channels/${channel.id}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ]);
    assert.deepEqual(
      [first.response.status, duplicate.response.status].sort(),
      [200, 201],
    );
    assert.deepEqual(
      [first.body.created, duplicate.body.created].sort(),
      [false, true],
    );
    assert.equal(
      (first.body.message as { id: string }).id,
      (duplicate.body.message as { id: string }).id,
    );
    assert.equal((await server.service.listMessages(channel.id)).length, 2);
    assert.equal(responseEvents, 1);
    assert.equal(await server.service.storage.getCursor(channel.id, "agent-b"), trigger.sequence);
    unsubscribe();
  } finally {
    await server.close();
  }
});

test("posts a message and emits it over SSE", async () => {
  const server = await createChannelHttpServer();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const channel = await createTestChannel(server.endpoint);
    const eventResponse = await fetch(`${server.endpoint}/channels/${channel.id}/events`);
    assert.equal(eventResponse.status, 200);
    assert.ok(eventResponse.body);
    reader = eventResponse.body!.getReader();
    const stream = { buffer: "" };
    assert.match(await readSseFrame(reader, stream), /event: ready/);

    const posted = await jsonRequest(server.endpoint, `/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "agent-a", body: "@agent-b Please review README.md" }),
    });
    assert.equal(posted.response.status, 201);
    const postedMessage = posted.body.message as { sequence: number; to: string[] };
    assert.equal(postedMessage.sequence, 1);
    assert.deepEqual(postedMessage.to, ["agent-b"]);

    const frame = await readSseFrame(reader, stream);
    assert.match(frame, /event: message\.created/);
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
    const event = JSON.parse(dataLine.slice(6)) as {
      type: string;
      message: { sequence: number; participantId: string; to: string[]; body: string };
    };
    assert.equal(event.type, "message.created");
    assert.equal(event.message.sequence, 1);
    assert.equal(event.message.participantId, "agent-a");
    assert.deepEqual(event.message.to, ["agent-b"]);
    assert.equal(event.message.body, "@agent-b Please review README.md");

    const listed = await jsonRequest(server.endpoint, `/channels/${channel.id}/messages`);
    assert.equal((listed.body.messages as unknown[]).length, 1);
  } finally {
    await reader?.cancel();
    await server.close();
  }
});

test("rejects messages from participants outside the channel", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server.endpoint);
    const result = await jsonRequest(server.endpoint, `/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "intruder", body: "hello" }),
    });
    assert.equal(result.response.status, 400);
    assert.match(String(result.body.error), /not in channel/);
  } finally {
    await server.close();
  }
});

test("server shutdown closes active SSE connections", async () => {
  const server = await createChannelHttpServer();
  const channel = await createTestChannel(server.endpoint);
  const response = await fetch(`${server.endpoint}/channels/${channel.id}/events`);
  assert.equal(response.status, 200);
  await server.close();
});

test("returns 404 for an unknown channel", async () => {
  const server = await createChannelHttpServer();
  try {
    const result = await jsonRequest(server.endpoint, "/channels/missing/messages");
    assert.equal(result.response.status, 404);
  } finally {
    await server.close();
  }
});
