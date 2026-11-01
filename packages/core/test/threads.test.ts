import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient, ConversationClientError } from "../src/client.ts";
import { createConversationHttpServer } from "../src/http-server.ts";
import type { ConversationEvent } from "../src/types.ts";

test("HTTP threads retain one root, isolated messages, inherited roster and lifecycle", async () => {
  const server = await createConversationHttpServer();
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const human = await client.createIdentity({ type: "human" });
    const agent = await client.createIdentity({ type: "agent" });
    const outsider = await client.createIdentity({ type: "human" });
    const workspace = await client.createWorkspace({ slug: "threads", name: "Threads" });
    await client.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "you", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    await client.addWorkspaceMember(workspace.id, { identityId: outsider.id, mentionHandle: "outsider" });
    const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
    const background = await client.postMessage(parent.id, { participantId: human.id, body: "Parent background" });
    const root = await client.postMessage(parent.id, { participantId: agent.id, body: "Root" });
    const clarification = await client.postMessage(parent.id, { participantId: human.id, body: "Clarification after root, before thread creation" });
    const input = { actorIdentityId: human.id, rootMessageId: root.id };
    const [thread, reopened] = await Promise.all([client.createThread(parent.id, input), client.createThread(parent.id, input)]);
    assert.equal(thread.id, reopened.id);
    assert.deepEqual(thread.thread.context.map(({ id }) => id), [background.id, root.id, clarification.id]);
    assert.equal(thread.replyCount, 0);
    assert.deepEqual((await client.listWorkspaceConversations(workspace.id)).map(({ id }) => id), [parent.id]);
    await assert.rejects(client.createThread(parent.id, { ...input, actorIdentityId: outsider.id }), ConversationClientError);
    await assert.rejects(client.createThread(parent.id, { ...input, actorIdentityId: agent.id }), ConversationClientError);
    await assert.rejects(client.createThread(parent.id, { ...input, rootMessageId: "missing" }), ConversationClientError);
    await assert.rejects(client.createThread(thread.id, input), /Nested threads/);
    const other = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id] });
    await assert.rejects(client.createThread(other.id, input), /Root message/);

    const parentEvents: ConversationEvent[] = [];
    const threadEvents: ConversationEvent[] = [];
    const unsubParent = await server.service.subscribe(parent.id, (event) => parentEvents.push(event));
    const unsubThread = await server.service.subscribe(thread.id, (event) => threadEvents.push(event));
    try {
      const reply = await client.postMessage(thread.id, { participantId: human.id, body: "Thread only" }, { idempotencyKey: "reply" });
      const retried = await client.postMessage(thread.id, { participantId: human.id, body: "Thread only" }, { idempotencyKey: "reply" });
      assert.equal(reply.id, retried.id);
      const response = await client.postResponse(thread.id, { participantId: agent.id, body: "Agent thread only", triggerMessageId: reply.id, triggerSequence: reply.sequence });
      const responseRetry = await client.postResponse(thread.id, { participantId: agent.id, body: "Ignored retry", triggerMessageId: reply.id, triggerSequence: reply.sequence });
      assert.equal(response.message.id, responseRetry.message.id);
      assert.equal(response.message.replyTo, reply.id);
      assert.equal(await client.getCursor(thread.id, agent.id), reply.sequence);
      await assert.rejects(client.getCursor(thread.id, outsider.id), /Participant is not/);
      assert.equal((await client.listThreads(parent.id))[0]?.replyCount, 2);
      assert.equal((await client.listMessages(parent.id)).length, 3);
      assert.equal(parentEvents.filter(({ type }) => type === "message.created").length, 0);
      assert.equal(parentEvents.filter(({ type }) => type === "conversation.updated").length, 2);
      await assert.rejects(client.postResponse(parent.id, { participantId: agent.id, body: "Wrong destination", triggerMessageId: reply.id, triggerSequence: reply.sequence }), /trigger message/);
      await assert.rejects(client.updateConversationParticipants(thread.id, { actorIdentityId: human.id, expectedRosterRevision: 1, participantIds: [human.id, outsider.id] }), /inherit/);
      await assert.rejects(client.updateConversationLifecycle(thread.id, { actorIdentityId: human.id, state: "settled" }), /inherit/);
      await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, expectedRosterRevision: 1, participantIds: [human.id] });
      assert.deepEqual((await client.getConversation(thread.id)).participants.map(({ id }) => id), [human.id]);
      assert.ok(threadEvents.some((event) => event.type === "roster.updated" && event.rosterRevision === 2));
      await assert.rejects(client.postMessage(thread.id, { participantId: agent.id, body: "Removed agent" }), /Participant is not/);
      await client.updateConversationLifecycle(parent.id, { actorIdentityId: human.id, state: "settled" });
      assert.equal((await client.getConversationLifecycle(thread.id)).state, "settled");
      await assert.rejects(client.postMessage(thread.id, { participantId: human.id, body: "Frozen" }), /frozen/);
      assert.equal((await client.listMessages(thread.id)).length, 2);
    } finally { unsubParent(); unsubThread(); }
  } finally { await server.close(); }
});

test("HTTP event clients receive parent thread-count invalidations", { timeout: 5_000 }, async () => {
  const server = await createConversationHttpServer();
  const controller = new AbortController();
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const parent = await client.createConversation({ participants: [{ id: "human", type: "human" }] });
    const root = await client.postMessage(parent.id, { participantId: "human", body: "Root" });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const received = (async () => {
      for await (const event of client.events(parent.id, { signal: controller.signal, onReady: ready })) return event;
      throw new Error("Event stream closed without an update");
    })();
    try {
      await started;
      await client.createThread(parent.id, { actorIdentityId: "human", rootMessageId: root.id });
      const event = await received;
      assert.equal(event.type, "conversation.updated");
      assert.equal(event.conversationId, parent.id);
    } finally {
      controller.abort();
      await received.catch(() => undefined);
    }
  } finally { await server.close(); }
});

test("HTTP creation-time snapshots retain an old root, bound recent background and stay frozen", async () => {
  const server = await createConversationHttpServer();
  try {
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const parent = await client.createConversation({ participants: [{ id: "human", type: "human" }] });
    const root = await client.postMessage(parent.id, { participantId: "human", body: "Original root outside the recent window" });
    const background = [];
    for (let index = 1; index <= 25; index++) {
      background.push(await client.postMessage(parent.id, { participantId: "human", body: `Recent parent background ${index}` }));
    }
    const input = { actorIdentityId: "human", rootMessageId: root.id };
    const thread = await client.createThread(parent.id, input);
    assert.equal(thread.thread.context.length, 20);
    assert.deepEqual(thread.thread.context.map(({ id }) => id), [root.id, ...background.slice(-19).map(({ id }) => id)]);
    const frozen = structuredClone(thread.thread.context);
    await client.postMessage(parent.id, { participantId: "human", body: "Parent message after first creation" });
    const reopened = await client.createThread(parent.id, input);
    assert.equal(reopened.id, thread.id);
    assert.deepEqual(reopened.thread.context, frozen);
    assert.deepEqual((await client.getConversation(thread.id)).thread?.context, frozen);

    const largeRoot = await client.postMessage(parent.id, { participantId: "human", body: "r".repeat(16_001) });
    await client.postMessage(parent.id, { participantId: "human", body: "Recent background beyond the remaining character budget" });
    const largeThread = await client.createThread(parent.id, { actorIdentityId: "human", rootMessageId: largeRoot.id });
    assert.deepEqual(largeThread.thread.context.map(({ id }) => id), [largeRoot.id]);
    assert.equal(largeThread.thread.context[0]!.body.length, 16_001);
  } finally { await server.close(); }
});
