import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { ChannelClient } from "../src/client.ts";
import { createChannelHttpServer, type ChannelHttpServer } from "../src/http-server.ts";
import { createResourceId, isResourceId, RESOURCE_ID_PREFIXES } from "../src/ids.ts";
import type { ChannelEvent } from "../src/types.ts";

async function jsonRequest(server: ChannelHttpServer, path: string, init?: RequestInit) {
  const response = await fetch(`${server.endpoint}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${server.serviceToken}`, ...init?.headers },
  });
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

test("creates typed resource ids with UUID-strength random payloads", () => {
  for (const prefix of RESOURCE_ID_PREFIXES) {
    const first = createResourceId(prefix);
    const second = createResourceId(prefix);
    assert.equal(isResourceId(first, prefix), true);
    assert.equal(isResourceId(first), true);
    assert.notEqual(first, second);
  }
  assert.equal(isResourceId("550e8400-e29b-41d4-a716-446655440000"), false);
  assert.equal(isResourceId("channel_not-random", "channel"), false);
});

async function createTestChannel(server: ChannelHttpServer) {
  const result = await jsonRequest(server, "/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "build-and-review",
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
  return result.body.channel as { id: string; name: string; participants: unknown[]; messages: unknown[] };
}

test("creates a channel and starts with no messages", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    assert.equal(isResourceId(channel.id, "channel"), true);
    assert.equal(channel.name, "build-and-review");
    assert.equal(channel.participants.length, 2);
    assert.deepEqual(channel.messages, []);

    const fetched = await jsonRequest(server, `/channels/${channel.id}`);
    assert.equal(fetched.response.status, 200);
    const fetchedChannel = fetched.body.channel as {
      name: string;
      participants: Array<{ id: string; role?: string; profile?: string }>;
      messages?: unknown;
    };
    assert.equal(fetchedChannel.name, "build-and-review");
    assert.equal("messages" in fetchedChannel, false);
    assert.deepEqual(fetchedChannel.participants[0], {
      id: "agent-a",
      handle: "agent-a",
      type: "agent",
      displayName: "Builder",
      role: "implementation",
      profile: "Builds and tests requested changes.",
      status: "active",
    });

    const listed = await jsonRequest(server, `/channels/${channel.id}/messages`);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.messages, []);
  } finally {
    await server.close();
  }
});

test("registers reusable identities and Workspace-local handles for Channel routing", async () => {
  const server = await createChannelHttpServer();
  try {
    const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
    const human = await client.createIdentity({ type: "human", displayName: "David" });
    const builder = await client.createIdentity({
      type: "agent",
      displayName: "Builder",
      publicProfile: "Implements changes",
    });
    const outsider = await client.createIdentity({ type: "agent", displayName: "Outsider" });
    const workspace = await client.createWorkspace({ slug: "runtime", name: "Runtime" });
    assert.equal(isResourceId(human.id, "identity"), true);
    assert.equal(isResourceId(builder.id, "identity"), true);
    assert.equal(isResourceId(workspace.id, "workspace"), true);
    await client.addWorkspaceMember(workspace.id, {
      identityId: human.id,
      mentionHandle: "David",
      accessRole: "owner",
    });
    await client.addWorkspaceMember(workspace.id, {
      identityId: builder.id,
      mentionHandle: "builder",
      roleLabel: "builder",
    });
    await assert.rejects(
      client.addWorkspaceMember(workspace.id, {
        identityId: outsider.id,
        mentionHandle: "BUILDER",
      }),
      /already exists/,
    );
    await assert.rejects(
      client.addWorkspaceMember(workspace.id, {
        identityId: outsider.id,
        mentionHandle: "outsider",
        accessRole: "admin",
      }),
      /must use member access/,
    );

    const secondWorkspace = await client.createWorkspace({ slug: "website", name: "Website" });
    await client.addWorkspaceMember(secondWorkspace.id, {
      identityId: builder.id,
      mentionHandle: "security-reviewer",
      roleLabel: "reviewer",
    });
    assert.equal(
      (await client.listWorkspaceMembers(secondWorkspace.id))[0]?.identityId,
      builder.id,
    );

    await assert.rejects(
      client.updateWorkspace(workspace.id, { actorIdentityId: builder.id, name: "Unauthorized" }),
      /owner or admin is required/,
    );
    const renamedWorkspace = await client.updateWorkspace(workspace.id, {
      actorIdentityId: human.id,
      name: "Runtime Platform",
    });
    assert.equal(renamedWorkspace.name, "Runtime Platform");
    assert.equal((await client.getWorkspace(workspace.id)).name, "Runtime Platform");

    await assert.rejects(
      client.createChannel({
        workspaceId: workspace.id,
        name: "member-created",
        participantIds: [human.id, builder.id],
        actorIdentityId: builder.id,
      }),
      /owner or admin is required/,
    );
    const channel = await client.createChannel({
      workspaceId: workspace.id,
      name: "runtime-work",
      participantIds: [human.id, builder.id],
      actorIdentityId: human.id,
    });
    assert.equal(channel.workspaceId, workspace.id);
    assert.equal(channel.name, "runtime-work");
    assert.deepEqual(
      channel.participants.map((participant) => [participant.id, participant.handle]),
      [[human.id, "david"], [builder.id, "builder"]],
    );
    const message = await client.postMessage(channel.id, {
      participantId: human.id,
      body: "Background. @builder please implement this",
    });
    assert.equal(isResourceId(channel.id, "channel"), true);
    assert.equal(isResourceId(message.id, "message"), true);
    assert.deepEqual(message.to, [builder.id]);
    await assert.rejects(
      client.updateIdentity(builder.id, {
        workspaceId: workspace.id,
        actorIdentityId: builder.id,
        displayName: "Unauthorized Builder",
      }),
      /owner or admin is required/,
    );
    const renamedBuilder = await client.updateIdentity(builder.id, {
      workspaceId: workspace.id,
      actorIdentityId: human.id,
      displayName: "Lead Builder",
    });
    assert.equal(renamedBuilder.displayName, "Lead Builder");
    const renamedChannel = await client.getChannel(channel.id);
    assert.equal(renamedChannel.participants[1]?.displayName, "Lead Builder");
    assert.equal(renamedChannel.rosterRevision, channel.rosterRevision + 1);
    assert.equal((await client.listWorkspaces()).length, 2);
    assert.equal((await client.listIdentities()).length, 3);
    assert.equal((await client.listWorkspaceMembers(workspace.id)).length, 2);
    assert.equal((await client.listWorkspaceChannels(workspace.id))[0]?.id, channel.id);
    assert.equal((await client.listWorkspaceChannels(workspace.id))[0]?.name, "runtime-work");
    await assert.rejects(
      client.createChannel({ workspaceId: workspace.id, name: "   ", participantIds: [human.id] }),
      /name must be a non-empty string/i,
    );
    await assert.rejects(
      client.createChannel({ workspaceId: workspace.id, name: "x".repeat(101), participantIds: [human.id] }),
      /at most 100 characters/i,
    );
    await assert.rejects(
      client.createChannel({ workspaceId: workspace.id, participantIds: [outsider.id] }),
      /not an active Workspace member/,
    );
  } finally {
    await server.close();
  }
});

test("owner-governed membership updates revise Channel rosters and preserve history", async () => {
  const server = await createChannelHttpServer();
  try {
    const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
    const owner = await client.createIdentity({ type: "human", displayName: "Owner" });
    const agent = await client.createIdentity({ type: "agent", displayName: "Builder" });
    const workspace = await client.createWorkspace({ slug: "mutable-roster", name: "Mutable" });
    await client.addWorkspaceMember(workspace.id, {
      identityId: owner.id,
      mentionHandle: "owner",
      accessRole: "owner",
    });
    await client.addWorkspaceMember(workspace.id, {
      identityId: agent.id,
      mentionHandle: "builder",
      roleLabel: "implementation",
    });
    const channel = await client.createChannel({
      workspaceId: workspace.id,
      participantIds: [owner.id, agent.id],
    });
    await client.postMessage(channel.id, {
      participantId: owner.id,
      body: "@builder original task",
    });
    const events: ChannelEvent[] = [];
    const unsubscribe = await server.service.subscribe(channel.id, (event) => events.push(event));

    await assert.rejects(
      client.updateWorkspaceMember(workspace.id, agent.id, {
        actorIdentityId: agent.id,
        mentionHandle: "not-allowed",
      }),
      /owner or admin is required/,
    );
    const updated = await client.updateWorkspaceMember(workspace.id, agent.id, {
      actorIdentityId: owner.id,
      mentionHandle: "implementer",
      roleLabel: "builder",
      profileOverride: "Owns implementation",
    });
    assert.equal(updated.mentionHandle, "implementer");
    assert.equal(events[0]?.type, "roster.updated");
    if (events[0]?.type === "roster.updated") assert.equal(events[0].rosterRevision, 2);
    const revised = await client.getChannel(channel.id);
    assert.equal(revised.rosterRevision, 2);
    assert.equal(revised.participants[1]?.handle, "implementer");
    assert.equal(revised.participants[1]?.role, "builder");
    assert.equal((await client.listMessages(channel.id))[0]?.body, "@builder original task");
    await assert.rejects(
      client.postMessage(channel.id, { participantId: owner.id, body: "@builder old alias" }),
      /not in channel/,
    );

    await client.updateWorkspaceMember(workspace.id, agent.id, {
      actorIdentityId: owner.id,
      status: "disabled",
    });
    const disabled = await client.getChannel(channel.id);
    assert.equal(disabled.rosterRevision, 3);
    assert.equal(disabled.participants[1]?.status, "disabled");
    assert.equal(await server.service.storage.getCursor(channel.id, agent.id), 1);
    await assert.rejects(
      client.postMessage(channel.id, { participantId: owner.id, body: "@implementer wake" }),
      /disabled/,
    );
    await assert.rejects(
      client.postMessage(channel.id, { participantId: agent.id, body: "still here" }),
      /not active/,
    );
    await assert.rejects(
      client.updateWorkspaceMember(workspace.id, owner.id, {
        actorIdentityId: owner.id,
        status: "disabled",
      }),
      /retain an active owner/,
    );
    unsubscribe();
  } finally {
    await server.close();
  }
});

test("owner-governed Channel roster replacement is revisioned and preserves message attribution", async () => {
  const server = await createChannelHttpServer();
  try {
    const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
    const [owner, builder, reviewer] = await Promise.all([
      client.createIdentity({ type: "human", displayName: "Owner" }),
      client.createIdentity({ type: "agent", displayName: "Builder" }),
      client.createIdentity({ type: "agent", displayName: "Reviewer" }),
    ]);
    const workspace = await client.createWorkspace({ slug: "channel-rosters", name: "Rosters" });
    await Promise.all([
      client.addWorkspaceMember(workspace.id, {
        identityId: owner.id,
        mentionHandle: "owner",
        accessRole: "owner",
      }),
      client.addWorkspaceMember(workspace.id, {
        identityId: builder.id,
        mentionHandle: "builder",
      }),
      client.addWorkspaceMember(workspace.id, {
        identityId: reviewer.id,
        mentionHandle: "reviewer",
      }),
    ]);
    await assert.rejects(
      client.createChannel({
        workspaceId: workspace.id,
        name: "missing-owner",
        participantIds: [builder.id],
        actorIdentityId: owner.id,
      }),
      /participants must include the acting human/,
    );
    const channel = await client.createChannel({
      workspaceId: workspace.id,
      name: "implementation",
      participantIds: [owner.id, builder.id],
      actorIdentityId: owner.id,
    });
    await client.postMessage(channel.id, {
      participantId: builder.id,
      body: "Historical builder update",
    });
    const events: ChannelEvent[] = [];
    const unsubscribe = await server.service.subscribe(channel.id, (event) => events.push(event));

    await assert.rejects(
      client.updateChannel(channel.id, { actorIdentityId: builder.id, name: "delivery" }),
      /owner or admin is required/,
    );
    const renamed = await client.updateChannel(channel.id, {
      actorIdentityId: owner.id,
      name: "  delivery  ",
    });
    assert.equal(renamed.name, "delivery");
    assert.equal((await client.getChannel(channel.id)).name, "delivery");
    assert.equal(events[0]?.type, "channel.updated");

    await assert.rejects(
      client.updateChannelParticipants(channel.id, {
        actorIdentityId: builder.id,
        participantIds: [owner.id, reviewer.id],
        expectedRosterRevision: 1,
      }),
      /owner or admin is required/,
    );
    await assert.rejects(
      client.updateChannelParticipants(channel.id, {
        actorIdentityId: owner.id,
        participantIds: [reviewer.id],
        expectedRosterRevision: 1,
      }),
      /participants must include the acting human/,
    );
    const revised = await client.updateChannelParticipants(channel.id, {
      actorIdentityId: owner.id,
      participantIds: [owner.id, reviewer.id],
      expectedRosterRevision: 1,
    });
    assert.equal(revised.rosterRevision, 2);
    assert.deepEqual(revised.participants.map(({ id }) => id), [owner.id, reviewer.id]);
    assert.equal(events[1]?.type, "roster.updated");
    if (events[1]?.type === "roster.updated") assert.equal(events[1].rosterRevision, 2);
    assert.equal((await client.listMessages(channel.id))[0]?.participantId, builder.id);
    assert.equal(await server.service.storage.getCursor(channel.id, builder.id), 1);
    await assert.rejects(
      client.postMessage(channel.id, { participantId: builder.id, body: "No longer assigned" }),
      /not in channel/,
    );
    await assert.rejects(
      client.updateChannelParticipants(channel.id, {
        actorIdentityId: owner.id,
        participantIds: [owner.id, builder.id, reviewer.id],
        expectedRosterRevision: 1,
      }),
      /roster changed; reload and retry/i,
    );
    const restored = await client.updateChannelParticipants(channel.id, {
      actorIdentityId: owner.id,
      participantIds: [owner.id, builder.id, reviewer.id],
      expectedRosterRevision: revised.rosterRevision,
    });
    assert.equal(restored.rosterRevision, 3);
    assert.deepEqual(restored.participants.map(({ id }) => id), [owner.id, builder.id, reviewer.id]);
    unsubscribe();
  } finally {
    await server.close();
  }
});

test("assigns per-channel sequences and resolves channel mentions", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    const clientMessage = async (body: string) =>
      (
        await jsonRequest(server, `/channels/${channel.id}/messages`, {
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

test("replays sequential and concurrent message retries without another sequence or event", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    let events = 0;
    const unsubscribe = await server.service.subscribe(channel.id, () => {
      events += 1;
    });
    const post = (key: string) => jsonRequest(server, `/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ participantId: "agent-a", body: "@agent-b review" }),
    });

    const first = await post("sequential-key");
    const replay = await post("sequential-key");
    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 201);
    assert.equal(
      (first.body.message as { id: string }).id,
      (replay.body.message as { id: string }).id,
    );

    const [concurrentFirst, concurrentReplay] = await Promise.all([
      post("concurrent-key"),
      post("concurrent-key"),
    ]);
    assert.equal(
      (concurrentFirst.body.message as { id: string }).id,
      (concurrentReplay.body.message as { id: string }).id,
    );
    assert.deepEqual(
      (await server.service.listMessages(channel.id)).map((message) => message.sequence),
      [1, 2],
    );
    assert.equal(events, 2);
    unsubscribe();
  } finally {
    await server.close();
  }
});

test("rejects reuse with a changed effective payload and accepts intentional duplicates", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    const reply = await server.service.createMessage(channel.id, {
      participantId: "agent-b",
      body: "reply anchor",
    });
    const post = (key: string | undefined, input: Record<string, unknown>) =>
      jsonRequest(server, `/channels/${channel.id}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        body: JSON.stringify(input),
      });
    const base = { participantId: "agent-a", body: "same body", to: ["agent-b"] };

    for (const [key, changed] of [
      ["changed-body", { ...base, body: "changed" }],
      ["changed-target", { ...base, to: [] }],
      ["changed-reply", { ...base, replyTo: reply.id }],
    ] as const) {
      assert.equal((await post(key, base)).response.status, 201);
      const conflict = await post(key, changed);
      assert.equal(conflict.response.status, 409);
      assert.match(String(conflict.body.error), /different payload/);
    }

    const competingPayloads = await Promise.all([
      post("concurrent-conflict", base),
      post("concurrent-conflict", { ...base, body: "competing body" }),
    ]);
    assert.deepEqual(
      competingPayloads.map((result) => result.response.status).sort(),
      [201, 409],
    );

    const normalized = await post("normalized-author", { ...base, participantId: " agent-a " });
    const normalizedReplay = await post("normalized-author", base);
    assert.equal(
      (normalized.body.message as { id: string }).id,
      (normalizedReplay.body.message as { id: string }).id,
    );

    const keyedFirst = await post("intentional-1", base);
    const keyedSecond = await post("intentional-2", base);
    assert.notEqual(
      (keyedFirst.body.message as { id: string }).id,
      (keyedSecond.body.message as { id: string }).id,
    );
    const unkeyedFirst = await post(undefined, base);
    const unkeyedSecond = await post(undefined, base);
    assert.notEqual(
      (unkeyedFirst.body.message as { id: string }).id,
      (unkeyedSecond.body.message as { id: string }).id,
    );

    const otherAuthor = await post("intentional-1", {
      participantId: "agent-b",
      body: "same body",
      to: ["agent-a"],
    });
    assert.equal(otherAuthor.response.status, 201);
  } finally {
    await server.close();
  }
});

test("ChannelClient forwards its optional idempotency key", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
    const input = { participantId: "agent-a", body: "sent through client" };
    const first = await client.postMessage(channel.id, input, { idempotencyKey: "client-key" });
    const replay = await client.postMessage(channel.id, input, { idempotencyKey: "client-key" });
    assert.equal(first.id, replay.id);
  } finally {
    await server.close();
  }
});

test("validates idempotency keys by UTF-8 byte length", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    for (const key of [" ", "é".repeat(128)]) {
      await assert.rejects(
        server.service.createMessage(
          channel.id,
          { participantId: "agent-a", body: "hello" },
          key,
        ),
        /idempotency key/,
      );
    }
    const accepted = await server.service.createMessage(
      channel.id,
      { participantId: "agent-a", body: "hello" },
      "é".repeat(127) + "a",
    );
    assert.equal(accepted.sequence, 1);
  } finally {
    await server.close();
  }
});

test("commits one idempotent response and advances its cursor atomically", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    const triggerResult = await jsonRequest(server, `/channels/${channel.id}/messages`, {
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
      jsonRequest(server, `/channels/${channel.id}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      jsonRequest(server, `/channels/${channel.id}/responses`, {
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
    const channel = await createTestChannel(server);
    const eventResponse = await fetch(`${server.endpoint}/channels/${channel.id}/events`, { headers: { authorization: `Bearer ${server.serviceToken}` } });
    assert.equal(eventResponse.status, 200);
    assert.ok(eventResponse.body);
    reader = eventResponse.body!.getReader();
    const stream = { buffer: "" };
    assert.match(await readSseFrame(reader, stream), /event: ready/);

    const posted = await jsonRequest(server, `/channels/${channel.id}/messages`, {
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

    const listed = await jsonRequest(server, `/channels/${channel.id}/messages`);
    assert.equal((listed.body.messages as unknown[]).length, 1);
  } finally {
    await reader?.cancel();
    await server.close();
  }
});

test("multiplexes several Channels over one SSE connection", async () => {
  const server = await createChannelHttpServer();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const first = await createTestChannel(server);
    const second = await createTestChannel(server);
    const query = new URLSearchParams();
    query.append("channelId", first.id);
    query.append("channelId", second.id);
    const eventResponse = await fetch(`${server.endpoint}/channels/events?${query}`, {
      headers: { authorization: `Bearer ${server.serviceToken}` },
    });
    assert.equal(eventResponse.status, 200);
    assert.ok(eventResponse.body);
    reader = eventResponse.body!.getReader();
    const stream = { buffer: "" };
    const ready = await readSseFrame(reader, stream);
    assert.match(ready, /event: ready/);
    assert.deepEqual(JSON.parse(ready.split("\n").find((line) => line.startsWith("data: "))!.slice(6)), {
      channelIds: [first.id, second.id],
    });

    await server.service.createMessage(second.id, {
      participantId: "agent-a",
      body: "second Channel event",
    });
    const frame = await readSseFrame(reader, stream);
    assert.match(frame, /event: message\.created/);
    const event = JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as ChannelEvent;
    assert.equal(event.channelId, second.id);
  } finally {
    await reader?.cancel();
    await server.close();
  }
});

test("rejects invalid multiplexed SSE Channel sets and cleans up partial subscriptions", async () => {
  const server = await createChannelHttpServer();
  try {
    const response = await fetch(`${server.endpoint}/channels/events`, {
      headers: { authorization: `Bearer ${server.serviceToken}` },
    });
    assert.equal(response.status, 400);

    const channel = await createTestChannel(server);
    let delivered = 0;
    await assert.rejects(
      server.service.subscribeMany([channel.id, "missing-channel"], () => { delivered += 1; }),
      /Channel not found/,
    );
    await server.service.createMessage(channel.id, { participantId: "agent-a", body: "after failure" });
    assert.equal(delivered, 0);
  } finally {
    await server.close();
  }
});

test("rejects messages from participants outside the channel", async () => {
  const server = await createChannelHttpServer();
  try {
    const channel = await createTestChannel(server);
    const result = await jsonRequest(server, `/channels/${channel.id}/messages`, {
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

test("SSE connections receive validated heartbeats while a Channel is quiet", async () => {
  await assert.rejects(
    createChannelHttpServer({ heartbeatIntervalMs: 0 }),
    /heartbeatIntervalMs must be a positive integer/,
  );
  const server = await createChannelHttpServer({ heartbeatIntervalMs: 10 });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const channel = await createTestChannel(server);
    const response = await fetch(`${server.endpoint}/channels/${channel.id}/events`, { headers: { authorization: `Bearer ${server.serviceToken}` } });
    assert.ok(response.body);
    reader = response.body!.getReader();
    const stream = { buffer: "" };
    assert.match(await readSseFrame(reader, stream), /event: ready/);
    assert.equal(await readSseFrame(reader, stream), ": keepalive");
  } finally {
    await reader?.cancel();
    await server.close();
  }
});

test("server shutdown closes active SSE connections", async () => {
  const server = await createChannelHttpServer();
  const channel = await createTestChannel(server);
  const response = await fetch(`${server.endpoint}/channels/${channel.id}/events`, { headers: { authorization: `Bearer ${server.serviceToken}` } });
  assert.equal(response.status, 200);
  await server.close();
});

test("direct collaboration HTTP requires its service credential and rejects browser spoofing", async () => {
  const server = await createChannelHttpServer();
  try {
    const unauthorized = await fetch(`${server.endpoint}/identities`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ type: "human" }),
    });
    assert.equal(unauthorized.status, 401);
    const hostileOrigin = await fetch(`${server.endpoint}/identities`, {
      headers: { authorization: `Bearer ${server.serviceToken}`, origin: "https://hostile.example" },
    });
    assert.equal(hostileOrigin.status, 403);
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${server.endpoint}/identities`, {
        headers: { authorization: `Bearer ${server.serviceToken}`, host: "hostile.example" },
      }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.once("error", reject);
      request.end();
    });
    assert.equal(hostileHostStatus, 403);
    const productHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${server.endpoint}/identities`, {
        headers: { authorization: `Bearer ${server.serviceToken}`, host: "minu-channels.localhost:47410" },
      }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.once("error", reject);
      request.end();
    });
    assert.equal(productHostStatus, 200);
    const wrongType = await fetch(`${server.endpoint}/identities`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.serviceToken}`, "content-type": "text/plain" },
      body: JSON.stringify({ type: "human" }),
    });
    assert.equal(wrongType.status, 400);

    const channel = await createTestChannel(server);
    const spoofed = await fetch(`${server.endpoint}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.serviceToken}`,
        "content-type": "application/json",
        "x-minu-actor-id": "agent-b",
      },
      body: JSON.stringify({ participantId: "agent-a", body: "spoofed" }),
    });
    assert.equal(spoofed.status, 400);
  } finally { await server.close(); }
});

test("lists messages with bounded sequence pagination", async () => {
  const server = await createChannelHttpServer();
  try {
    const client = new ChannelClient(server.endpoint, { serviceToken: server.serviceToken });
    const channel = await createTestChannel(server);
    for (const body of ["one", "two", "three", "four"]) {
      await client.postMessage(channel.id, { participantId: "agent-a", body });
    }
    assert.deepEqual((await client.listMessages(channel.id, { afterSequence: 1, limit: 2 })).map(({ sequence }) => sequence), [2, 3]);
    assert.deepEqual((await client.listMessages(channel.id, { beforeSequence: 4, limit: 2 })).map(({ sequence }) => sequence), [2, 3]);
    const invalid = await jsonRequest(server, `/channels/${channel.id}/messages?afterSequence=1&beforeSequence=4`);
    assert.equal(invalid.response.status, 400);
  } finally { await server.close(); }
});

test("returns 404 for an unknown channel", async () => {
  const server = await createChannelHttpServer();
  try {
    const result = await jsonRequest(server, "/channels/missing/messages");
    assert.equal(result.response.status, 404);
  } finally {
    await server.close();
  }
});
