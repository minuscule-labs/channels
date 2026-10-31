import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationService, ConversationClient, createConversationHttpServer } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "../src/storage.ts";

test("thread snapshots, reply scopes and inherited administration survive libSQL reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-threads-"));
  const url = `file:${join(directory, "conversations.db")}`;
  let storage = await DrizzleLibSqlConversationStorage.open({ url });
  let server = await createConversationHttpServer({ service: new ConversationService(storage) });
  try {
    let client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    const human = await client.createIdentity({ type: "human" });
    const agent = await client.createIdentity({ type: "agent" });
    const workspace = await client.createWorkspace({ slug: "threads", name: "Threads" });
    await client.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "you", accessRole: "owner" });
    await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
    const parent = await client.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
    const root = await client.postMessage(parent.id, { participantId: human.id, body: "Root background" });
    const clarification = await client.postMessage(parent.id, { participantId: human.id, body: "Pre-creation clarification after the root" });
    const thread = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
    const secondRoot = await client.postMessage(parent.id, { participantId: human.id, body: "Different root" });
    const sibling = await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: secondRoot.id });
    const reply = await client.postMessage(thread.id, { participantId: human.id, body: "Thread reply" }, { idempotencyKey: "same-key" });
    await client.postMessage(sibling.id, { participantId: human.id, body: "Sibling reply" }, { idempotencyKey: "same-key" });
    const answer = await client.postResponse(thread.id, { participantId: agent.id, body: "Thread answer", triggerMessageId: reply.id, triggerSequence: reply.sequence });
    await client.updateConversationParticipants(parent.id, { actorIdentityId: human.id, expectedRosterRevision: 1, participantIds: [human.id] });
    await server.close();
    await storage.close();
    storage = await DrizzleLibSqlConversationStorage.open({ url });
    server = await createConversationHttpServer({ service: new ConversationService(storage) });
    client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
      const threads = await client.listThreads(parent.id);
      assert.deepEqual(threads.map(({ id, replyCount }) => [id, replyCount]), [[thread.id, 2], [sibling.id, 1]]);
      assert.equal((await client.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id })).id, thread.id);
      assert.equal((await client.getConversation(thread.id)).thread?.context[0]?.body, "Root background");
      assert.deepEqual((await client.getConversation(thread.id)).thread?.context.map(({ id }) => id), [root.id, clarification.id]);
      assert.deepEqual((await client.getConversation(thread.id)).participants.map(({ id }) => id), [human.id]);
      assert.equal((await client.getConversation(thread.id)).rosterRevision, 2);
      assert.deepEqual((await client.listMessages(thread.id)).map(({ body }) => body), ["Thread reply", "Thread answer"]);
      assert.equal((await client.postMessage(thread.id, { participantId: human.id, body: "Thread reply" }, { idempotencyKey: "same-key" })).id, reply.id);
      assert.equal((await client.listMessages(thread.id))[1]?.id, answer.message.id);
      assert.equal((await client.listMessages(parent.id)).length, 3);
      assert.deepEqual((await client.listWorkspaceConversations(workspace.id)).map(({ id }) => id), [parent.id]);
      await client.updateConversationLifecycle(parent.id, { actorIdentityId: human.id, state: "settled" });
      assert.equal((await client.getConversationLifecycle(thread.id)).state, "settled");
      await assert.rejects(client.postMessage(thread.id, { participantId: human.id, body: "Frozen" }), /frozen/);
      assert.equal(await storage.getCursor(thread.id, agent.id), answer.message.sequence);
      assert.equal(await storage.getCursor(sibling.id, agent.id), 1);
  } finally {
    await server.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
