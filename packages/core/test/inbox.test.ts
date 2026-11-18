import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient } from "../src/client.ts";
import { ConversationService } from "../src/conversation-service.ts";
import { createConversationHttpServer } from "../src/http-server.ts";

test("authenticated inbox updates arrive with no conversation topics; read state belongs only to the actor", { timeout: 10_000 }, async () => {
  const service = new ConversationService();
  const server = await createConversationHttpServer({ service });
  const controller = new AbortController();
  let consuming: Promise<void> | undefined;
  try {
    const human = await service.createIdentity({ type: "human" });
    const other = await service.createIdentity({ type: "human" });
    const workspace = await service.createWorkspace({ slug: "inbox", name: "Inbox" });
    for (const identity of [human, other]) await service.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.id === human.id ? "you" : "other" });
    const conversation = await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id, other.id] });
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken, actorIdentityId: human.id });
    const anonymous = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
    await assert.rejects(anonymous.listInbox(), /Authenticated identity/);
    await assert.rejects(anonymous.acknowledgeRead(conversation.id, 0), /Authenticated identity/);
    let ready!: () => void, changed!: () => void;
    const established = new Promise<void>(resolve => { ready = resolve; });
    const notification = new Promise<void>(resolve => { changed = resolve; });
    consuming = (async () => {
      for await (const _event of client.eventsMany([], { inbox: true, signal: controller.signal, onReady: ready, onInboxChange: changed })) {
        assert.fail("An inbox-only stream must not deliver conversation bodies");
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    await established;
    const message = await service.createMessage(conversation.id, { participantId: other.id, body: "A direct mention", to: [human.id] });
    await notification;
    assert.equal((await client.listInbox())[0]?.count, 1);
    assert.equal((await client.listActivity()).items[0]?.id, message.id);
    assert.equal((await client.listInbox())[0]?.count, 1, "fetching Activity does not mark anything read");
    await client.acknowledgeRead(conversation.id, message.sequence);
    await client.acknowledgeRead(conversation.id, 0);
    assert.equal((await client.listInbox())[0]?.count, 0);
    const otherClient = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken, actorIdentityId: other.id });
    assert.equal((await otherClient.listInbox())[0]?.readSequence, undefined);
    await service.createMessage(conversation.id, { participantId: other.id, body: "Arrived after acknowledgement", to: [human.id] });
    assert.equal((await client.listInbox())[0]?.count, 1);
    const fetched = await fetch(`${server.endpoint}/identities/me/inbox?identityId=${other.id}`, { headers: {
      authorization: `Bearer ${server.serviceToken}`, "x-minu-actor-id": human.id,
    } });
    assert.equal((await fetched.json() as { summaries: Array<{ readSequence: number }> }).summaries[0]?.readSequence, message.sequence);
  } finally { controller.abort(); await consuming; await server.close(); }
});
