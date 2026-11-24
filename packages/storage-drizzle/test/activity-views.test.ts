import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationService, type ActivityView } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage } from "../src/storage.ts";

for (const durable of [false, true]) {
  test(`${durable ? "SQLite" : "memory"} Activity groups and filters before paging, preserving eligibility, counts and current access`, async () => {
    const directory = durable ? await mkdtemp(join(tmpdir(), "channels-activity-views-")) : undefined;
    const url = directory ? `file:${join(directory, "channels.db")}` : undefined;
    let storage = url ? await DrizzleLibSqlConversationStorage.open({ url }) : undefined;
    let service = new ConversationService(storage);
    try {
      const human = await service.createIdentity({ type: "human", displayName: "You" });
      const alice = await service.createIdentity({ type: "human", displayName: "Alice" });
      const bob = await service.createIdentity({ type: "human", displayName: "Bob" });
      const parents = [];
      for (const slug of ["grouped", "other"]) {
        const workspace = await service.createWorkspace({ slug, name: slug });
        for (const [index, person] of [human, alice, bob].entries()) await service.addWorkspaceMember(workspace.id, {
          identityId: person.id, mentionHandle: `person${index}`, accessRole: "owner",
        });
        parents.push(await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id, alice.id, bob.id] }));
      }
      const [parent, foreign] = parents;
      const post = (conversationId: string, participantId: string, body: string, to: string[] = []) =>
        service.createMessage(conversationId, { participantId, body, to });
      const root = await post(parent!.id, human.id, "Owned root");
      const busy = await service.createThread(parent!.id, { actorIdentityId: human.id, rootMessageId: root.id });
      const read = await post(busy.id, alice.id, "Already read");
      await service.acknowledgeRead(busy.id, human.id, read.sequence);
      const mention = await post(busy.id, bob.id, "Busy mention", [human.id]);
      await post(busy.id, alice.id, "Ordinary eligible reply");
      await post(busy.id, human.id, "Own reply");
      const replies = [];
      for (let index = 0; index < 55; index++) replies.push(await post(busy.id, alice.id, `Busy reply ${index}`));
      const otherRoot = await post(parent!.id, alice.id, "Another topic in the same Conversation");
      const mentioned = await service.createThread(parent!.id, { actorIdentityId: human.id, rootMessageId: otherRoot.id });
      const early = await post(mentioned.id, alice.id, "Not eligible before participation");
      const explicit = await post(mentioned.id, bob.id, "An explicit thread mention", [human.id]);
      const ignoredRoot = await post(parent!.id, bob.id, "An unrelated discussion");
      const ignored = await service.createThread(parent!.id, { actorIdentityId: human.id, rootMessageId: ignoredRoot.id });
      await post(ignored.id, alice.id, "Creating a thread alone does not subscribe its creator");
      for (let index = 0; index < 51; index++) await post(parent!.id, alice.id, `Parent mention ${index}`, [human.id]);
      await post(parent!.id, bob.id, "A broadcast", ["@conversation"]);
      await post(foreign!.id, bob.id, "A foreign-workspace mention", [human.id]);
      const page = (view: ActivityView, before?: string, workspaceId = parent!.workspaceId) =>
        service.listActivity(human.id, before, workspaceId, view);
      const allRows = async (view: ActivityView) => {
        const first = await page(view);
        if (!first.nextCursor) return first.items;
        const second = await page(view, first.nextCursor);
        assert.equal(second.nextCursor, undefined);
        assert.equal(first.items.length, 50);
        assert.equal(second.items.length, 4);
        return [...first.items, ...second.items];
      };
      const before = await service.listInbox(human.id);
      const all = await allRows("all");
      assert.equal(all.length, 54, "55 busy replies do not consume 55 page slots");
      assert.equal(new Set(all.map(item => item.parentConversationId ? item.conversationId : item.id)).size, 54);
      const grouped = all.find(item => item.conversationId === busy.id)!;
      const newest = [...replies].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]!;
      assert.equal(grouped.id, newest.id);
      assert.equal(grouped.rootSequence, root.sequence);
      assert.equal(grouped.authorCount, 2);
      assert.equal(grouped.unreadCount, 57);
      assert.equal(grouped.firstUnreadSequence, mention.sequence);
      assert.equal(all.filter(item => item.conversationId === parent!.id).length, 52, "unrelated root mentions remain individual items");
      assert.ok(all.every(item => item.workspaceId === parent!.workspaceId));
      const threads = await page("threads");
      assert.equal(threads.nextCursor, undefined);
      assert.equal(threads.items.length, 2);
      assert.ok(threads.items.every(item => item.parentConversationId === parent!.id));
      assert.equal(threads.items.find(item => item.conversationId === mentioned.id)?.id, explicit.id, "thread mentions also appear under Threads");
      assert.ok(!threads.items.some(item => item.conversationId === ignored.id || item.id === early.id));
      const mentions = await allRows("mentions");
      assert.ok(mentions.every(item => item.kind === "mention"));
      const mentionedBusy = mentions.find(item => item.conversationId === busy.id)!;
      assert.equal(mentionedBusy.id, mention.id, "Mentions previews the latest matching mention, not a later ordinary reply");
      assert.equal(mentionedBusy.unreadCount, 1);
      assert.equal(mentionedBusy.authorCount, 1);
      assert.equal(all.reduce((sum, item) => sum + item.unreadCount!, 0), 110);
      assert.equal(before.filter(item => item.workspaceId === parent!.workspaceId).reduce((sum, item) => sum + item.activityCount, 0), 110);
      assert.deepEqual(await service.listInbox(human.id), before);
      for (const view of ["all", "mentions", "threads"] as const) {
        assert.deepEqual(await page(view, undefined, "missing"), { items: [] });
        assert.deepEqual(await page(view, undefined, ""), { items: [] });
      }
      // Sequence is the cursor contract, independently of timestamp/id ordering.
      await service.acknowledgeRead(busy.id, human.id, replies.at(-1)!.sequence);
      assert.equal((await page("threads")).items.find(item => item.conversationId === busy.id)?.unreadCount, 0);
      assert.equal((await service.listInbox(human.id)).find(item => item.conversationId === parent!.id)?.activityCount, 52);
      if (storage) assert.equal(await storage.getCursor(busy.id, human.id), 0);
      if (storage && url) {
        const expected = await page("threads");
        await storage.close();
        storage = await DrizzleLibSqlConversationStorage.open({ url });
        service = new ConversationService(storage);
        assert.deepEqual(await page("threads"), expected, "grouped unread state survives SQLite reopen");
      }
      await service.updateConversationParticipants(parent!.id, { actorIdentityId: alice.id, expectedRosterRevision: 1, participantIds: [alice.id, bob.id] });
      for (const view of ["all", "mentions", "threads"] as const) assert.deepEqual(await page(view), { items: [] }, "thread groups inherit current parent-roster access");
      await service.updateWorkspaceMember(parent!.workspaceId, human.id, { actorIdentityId: alice.id, status: "disabled" });
      for (const view of ["all", "mentions", "threads"] as const) assert.deepEqual(await page(view), { items: [] });
      assert.equal((await page("all", undefined, foreign!.workspaceId)).items.length, 1);
    } finally {
      await storage?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
}
