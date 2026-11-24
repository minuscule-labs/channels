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

test("Activity views group threads across authors without changing eligibility, unread counts or read scopes", async () => {
  const service = new ConversationService();
  const server = await createConversationHttpServer({ service });
  try {
    const human = await service.createIdentity({ type: "human" });
    const alice = await service.createIdentity({ type: "human", displayName: "Alice" });
    const bob = await service.createIdentity({ type: "human", displayName: "Bob" });
    const workspace = await service.createWorkspace({ slug: "views", name: "Views" });
    for (const [index, person] of [human, alice, bob].entries()) await service.addWorkspaceMember(workspace.id, {
      identityId: person.id, mentionHandle: `person${index}`, accessRole: "owner",
    });
    const parent = await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id, alice.id, bob.id] });
    const root = await service.createMessage(parent.id, { participantId: human.id, body: "My thread root" });
    const mention = await service.createMessage(parent.id, { participantId: alice.id, body: "Parent mention", to: [human.id] });
    await service.createMessage(parent.id, { participantId: bob.id, body: "Ordinary parent message", to: [] });
    const thread = await service.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
    const read = await service.createMessage(thread.id, { participantId: alice.id, body: "Already read", to: [] });
    await service.acknowledgeRead(thread.id, human.id, read.sequence);
    const mentioned = await service.createMessage(thread.id, { participantId: bob.id, body: "Mentioned reply", to: [human.id] });
    // Keep distinct timestamps so the representative is explicitly the newest eligible reply.
    await new Promise(resolve => setTimeout(resolve, 2));
    const reply = await service.createMessage(thread.id, { participantId: alice.id, body: "Latest ordinary reply", to: [] });
    await service.createMessage(thread.id, { participantId: human.id, body: "Own reply is excluded", to: [] });
    const headers = { authorization: `Bearer ${server.serviceToken}`, "x-minu-actor-id": human.id };
    const page = async (view: string) => {
      const response = await fetch(`${server.endpoint}/identities/me/activity?workspaceId=${workspace.id}&view=${view}`, { headers });
      assert.equal(response.status, 200);
      return await response.json() as { items: Array<Record<string, unknown>> };
    };
    const before = await service.listInbox(human.id);
    const all = await page("all");
    assert.equal(all.items.length, 2, "thread replies consume one row, not one row per participant/message");
    const grouped = all.items.find(item => item.conversationId === thread.id)!;
    assert.equal(grouped.id, reply.id);
    assert.equal(grouped.authorName, "Alice");
    assert.equal(grouped.authorCount, 2);
    assert.equal(grouped.unreadCount, 2);
    assert.equal(grouped.firstUnreadSequence, mentioned.sequence);
    assert.equal(grouped.parentConversationId, parent.id);
    assert.equal(grouped.rootSequence, root.sequence);
    const mentions = await page("mentions");
    assert.deepEqual(new Set(mentions.items.map(item => item.id)), new Set([mention.id, mentioned.id]));
    assert.equal(mentions.items.find(item => item.conversationId === thread.id)?.unreadCount, 1);
    assert.ok(mentions.items.every(item => item.kind === "mention"));
    const threads = await page("threads");
    assert.equal(threads.items.length, 1);
    assert.equal(threads.items[0]?.id, reply.id);
    assert.deepEqual(await service.listInbox(human.id), before, "viewing/changing tabs never acknowledges messages");
    assert.equal(before.reduce((sum, item) => sum + item.activityCount, 0), 3, "the badge counts notifications, not grouped rows");
    const legacy = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken, actorIdentityId: human.id });
    assert.equal((await legacy.listActivity(undefined, workspace.id)).items.length, 4, "omitted view preserves the flat API");
    assert.deepEqual(await legacy.listActivity(undefined, workspace.id, "threads"), threads, "typed clients forward the selected view");
    const invalid = await fetch(`${server.endpoint}/identities/me/activity?view=other`, { headers });
    assert.equal(invalid.status, 400);
    await service.updateWorkspaceMember(workspace.id, human.id, { actorIdentityId: alice.id, status: "disabled" });
    for (const view of ["all", "mentions", "threads"]) assert.deepEqual((await page(view)).items, []);
  } finally { await server.close(); }
});
