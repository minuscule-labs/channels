import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient } from "../src/client.ts";
import { ConversationService } from "../src/conversation-service.ts";
import { createConversationHttpServer } from "../src/http-server.ts";

test("Activity workspace filtering precedes pagination and preserves current access and read state", async () => {
  const service = new ConversationService();
  const server = await createConversationHttpServer({ service });
  try {
    const human = await service.createIdentity({ type: "human" });
    const other = await service.createIdentity({ type: "human" });
    const workspaces = await Promise.all(["a", "b"].map(slug => service.createWorkspace({ slug, name: slug })));
    const conversations = [];
    for (const workspace of workspaces) {
      for (const identity of [human, other]) await service.addWorkspaceMember(workspace.id, {
        identityId: identity.id, mentionHandle: identity.id === human.id ? "you" : "other", accessRole: "owner",
      });
      conversations.push(await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id, other.id] }));
    }
    for (let index = 0; index < 53; index++) await service.createMessage(conversations[0]!.id, {
      participantId: other.id, body: `A ${index}`, to: [human.id],
    });
    for (let index = 0; index < 3; index++) await service.createMessage(conversations[1]!.id, {
      participantId: other.id, body: `B ${index}`, to: [human.id],
    });
    const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken, actorIdentityId: human.id });
    const page = async (workspaceId: string, before?: string) => {
      const query = new URLSearchParams({ workspaceId, ...(before ? { before } : {}) });
      const response = await fetch(`${server.endpoint}/identities/me/activity?${query}`, { headers: {
        authorization: `Bearer ${server.serviceToken}`, "x-minu-actor-id": human.id,
      } });
      assert.equal(response.status, 200);
      return await response.json() as Awaited<ReturnType<typeof client.listActivity>>;
    };
    const first = await page(workspaces[0]!.id);
    assert.equal(first.items.length, 50);
    assert.ok(first.items.every(item => item.workspaceId === workspaces[0]!.id));
    const second = await page(workspaces[0]!.id, first.nextCursor);
    assert.equal(second.items.length, 3);
    assert.equal(second.nextCursor, undefined);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 53);
    assert.equal((await page(workspaces[1]!.id)).items.length, 3);
    assert.deepEqual(await page(""), { items: [] });
    assert.deepEqual(await page("missing"), { items: [] });
    assert.deepEqual((await client.listInbox()).map(item => item.activityCount), [53, 3]);
    await service.updateWorkspaceMember(workspaces[0]!.id, human.id, { actorIdentityId: other.id, status: "disabled" });
    assert.deepEqual(await page(workspaces[0]!.id), { items: [] });
    assert.equal((await page(workspaces[1]!.id)).items.length, 3);
  } finally { await server.close(); }
});

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
    assert.equal((await client.listInbox())[0]?.activityCount, 1);
    await client.acknowledgeRead(conversation.id, message.sequence);
    await client.acknowledgeRead(conversation.id, 0);
    assert.equal((await client.listInbox())[0]?.count, 0);
    assert.equal((await client.listInbox())[0]?.activityCount, 0);
    const otherClient = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken, actorIdentityId: other.id });
    assert.equal((await otherClient.listInbox())[0]?.readSequence, undefined);
    assert.equal((await otherClient.listInbox())[0]?.activityCount, 0, "own messages are not Activity notifications");
    await service.createMessage(conversation.id, { participantId: other.id, body: "Arrived after acknowledgement", to: [human.id] });
    assert.equal((await client.listInbox())[0]?.count, 1);
    const fetched = await fetch(`${server.endpoint}/identities/me/inbox?identityId=${other.id}`, { headers: {
      authorization: `Bearer ${server.serviceToken}`, "x-minu-actor-id": human.id,
    } });
    assert.equal((await fetched.json() as { summaries: Array<{ readSequence: number }> }).summaries[0]?.readSequence, message.sequence);
  } finally { controller.abort(); await consuming; await server.close(); }
});
