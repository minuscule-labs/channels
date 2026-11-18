import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationService } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "../src/storage.ts";

test("durable inbox counts all messages, keeps read scopes monotonic and projects paged Activity with current access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-inbox-"));
  const url = `file:${join(directory, "collaboration.db")}`;
  let storage = await DrizzleLibSqlConversationStorage.open({ url });
  try {
    let service = new ConversationService(storage);
    const human = await service.createIdentity({ type: "human", displayName: "You" });
    const other = await service.createIdentity({ type: "human", displayName: "Other" });
    const outsider = await service.createIdentity({ type: "human" });
    const workspace = await service.createWorkspace({ slug: "inbox", name: "Inbox" });
    for (const identity of [human, other, outsider]) await service.addWorkspaceMember(workspace.id, {
      identityId: identity.id, mentionHandle: identity.id === human.id ? "you" : identity.id === other.id ? "other" : "outsider", accessRole: "owner",
    });
    const parent = await service.createConversation({ workspaceId: workspace.id, name: "Parent", participantIds: [human.id, other.id] });
    const root = await service.createMessage(parent.id, { participantId: human.id, body: "My root" });
    const thread = await service.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: root.id });
    const reply = await service.createMessage(thread.id, { participantId: other.id, body: "Reply without a mention", to: [] });
    assert.equal((await service.listActivity(human.id)).items[0]?.kind, "thread-reply");
    const messages = [];
    for (let index = 0; index < 110; index++) messages.push(await service.createMessage(parent.id, {
      participantId: other.id, body: `Mention ${index}`, to: [human.id],
    }));
    assert.equal((await service.listInbox(human.id)).find(s => s.conversationId === parent.id)?.count, 110);
    const first = await service.listActivity(human.id);
    const second = await service.listActivity(human.id, first.nextCursor);
    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 50);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 100);
    assert.deepEqual(await service.listActivity(outsider.id), { items: [] });
    assert.deepEqual(await service.listInbox(outsider.id), []);
    await assert.rejects(service.acknowledgeRead(parent.id, outsider.id, root.sequence), /not found/);
    await assert.rejects(service.acknowledgeRead(parent.id, human.id, 9999), /persisted message/);
    await service.acknowledgeRead(parent.id, human.id, messages[108]!.sequence);
    await service.acknowledgeRead(parent.id, human.id, root.sequence); // stale tab cannot rewind
    assert.equal((await service.listInbox(human.id)).find(s => s.conversationId === parent.id)?.count, 1);
    assert.equal((await service.listInbox(human.id)).find(s => s.conversationId === thread.id)?.count, 1);
    assert.equal(await storage.getCursor(parent.id, human.id), 0, "human read state must not change agent processing cursors");
    await storage.close();
    storage = await DrizzleLibSqlConversationStorage.open({ url });
    service = new ConversationService(storage);
    assert.equal((await service.listInbox(human.id)).find(s => s.conversationId === parent.id)?.count, 1);
    assert.equal((await service.listActivity(human.id)).items[0]?.unread, true);
    await service.acknowledgeRead(thread.id, human.id, reply.sequence);
    assert.equal((await service.listInbox(human.id)).find(s => s.conversationId === thread.id)?.count, 0);
    const otherRoot = await service.createMessage(parent.id, { participantId: other.id, body: "Someone else's root", to: [] });
    const joined = await service.createThread(parent.id, { actorIdentityId: human.id, rootMessageId: otherRoot.id });
    const early = await service.createMessage(joined.id, { participantId: other.id, body: "Before participation", to: [] });
    assert.ok(!(await service.listActivity(human.id)).items.some(item => item.id === early.id));
    await service.createMessage(joined.id, { participantId: human.id, body: "Joining", to: [] });
    const later = await service.createMessage(joined.id, { participantId: other.id, body: "After participation", to: [] });
    assert.equal((await service.listActivity(human.id)).items.find(item => item.id === later.id)?.kind, "thread-reply");
    const broadcast = await service.createMessage(parent.id, { participantId: other.id, body: "@channel Update", to: ["@conversation"] });
    assert.equal((await service.listActivity(human.id)).items.find(item => item.id === broadcast.id)?.kind, "mention");
    await assert.rejects(service.listActivity(human.id, "malformed"), /Invalid Activity cursor/);
    assert.equal((await service.listActivity(human.id, JSON.stringify(["9999-01-01T00:00:00.000Z", "removed-boundary"])) ).items.length, 50);
    await service.updateConversationParticipants(parent.id, { actorIdentityId: other.id, expectedRosterRevision: 1, participantIds: [other.id] });
    assert.deepEqual(await service.listInbox(human.id), []);
    assert.deepEqual(await service.listActivity(human.id), { items: [] });
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});
