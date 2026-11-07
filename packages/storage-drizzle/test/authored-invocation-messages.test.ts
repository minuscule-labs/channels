import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationService, InMemoryConversationStorage, createResourceId, type ConversationEvent, type ConversationStorage } from "@minu/channels-core";
import { defaultConversationMigrationsFolder, DrizzleLibSqlConversationStorage, localLibSqlUrl } from "../src/storage.ts";

test("authored message migration upgrades existing conversation folders without losing ordinary messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-skill-folder-upgrade-"));
  const url = localLibSqlUrl(join(directory, "core.db"));
  const migrationsFolder = join(directory, "main-migrations");
  let storage: DrizzleLibSqlConversationStorage | undefined;
  try {
    await cp(defaultConversationMigrationsFolder(), migrationsFolder, { recursive: true });
    const journalPath = join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter(entry => entry.idx <= 11);
    await writeFile(journalPath, JSON.stringify(journal));
    storage = await DrizzleLibSqlConversationStorage.open({ url, migrationsFolder });
    let service = new ConversationService(storage);
    const human = await service.createIdentity({ type: "human" });
    const workspace = await service.createWorkspace({ slug: "upgrade", name: "Upgrade" });
    await service.addWorkspaceMember(workspace.id, { identityId: human.id, mentionHandle: "owner", accessRole: "owner" });
    const conversation = await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id] });
    const now = new Date().toISOString();
    const folder = await storage.createConversationFolder({ id: createResourceId("folder"), workspaceId: workspace.id, name: "Existing folder", createdAt: now, updatedAt: now });
    await storage.close();
    const beforeId = createResourceId("message");
    const raw = createClient({ url });
    try {
      await raw.batch([
        { sql: "INSERT INTO messages (id, conversation_id, sequence, participant_id, targets_json, body, created_at) VALUES (?, ?, 1, ?, '[]', ?, ?)", args: [beforeId, conversation.id, human.id, "Existing ordinary message", now] },
        { sql: "UPDATE conversations SET next_sequence = 2 WHERE id = ?", args: [conversation.id] },
      ], "write");
    } finally { raw.close(); }
    storage = await DrizzleLibSqlConversationStorage.open({ url });
    service = new ConversationService(storage);
    assert.deepEqual(await storage.getConversationFolder(folder.id), folder);
    const [before] = await service.listMessages(conversation.id);
    assert.equal(before?.id, beforeId);
    assert.equal(before.body, "Existing ordinary message");
    assert.deepEqual(before.to, []);
    assert.equal(before.authoredInvocationId, undefined);
    const after = await service.createMessage(conversation.id, { id: createResourceId("message"), participantId: human.id, to: [], body: "Arguments", authoredInvocationId: "accepted-operation" }, "upgrade");
    assert.equal(after.authoredInvocationId, "accepted-operation");
    assert.equal(after.sequence, before.sequence + 1);
  } finally { await storage?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: stable message IDs and public skill references preserve exact retries, events and snapshots`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-skill-message-"));
    const url = localLibSqlUrl(join(directory, "core.db"));
    let storage: ConversationStorage = kind === "memory" ? new InMemoryConversationStorage() : await DrizzleLibSqlConversationStorage.open({ url });
    let service = new ConversationService(storage);
    try {
      const human = await service.createIdentity({ type: "human", displayName: "Owner" });
      const agent = await service.createIdentity({ type: "agent", displayName: "Worker" });
      const workspace = await service.createWorkspace({ slug: "skill", name: "Skill" });
      for (const identity of [human, agent]) await service.addWorkspaceMember(workspace.id, { identityId: identity.id, mentionHandle: identity.displayName!.toLowerCase() });
      const conversation = await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
      const events: ConversationEvent[] = [];
      const unsubscribe = await service.subscribe(conversation.id, event => events.push(event));
      const input = { id: createResourceId("message"), authoredInvocationId: "public-correlation", participantId: human.id, to: [agent.id], body: "Arguments only" };
      const first = await service.createMessage(conversation.id, input, "stable");
      assert.equal(first.id, input.id);
      assert.equal(first.authoredInvocationId, input.authoredInvocationId);
      assert.deepEqual(await service.createMessage(conversation.id, input, "stable"), first);
      assert.equal(events.filter(event => event.type === "message.created").length, 1);
      for (const changed of [{ id: createResourceId("message") }, { authoredInvocationId: "copied" }, { body: "changed" }]) {
        await assert.rejects(service.createMessage(conversation.id, { ...input, ...changed }, "stable"), /different payload/);
      }
      await assert.rejects(service.createMessage(conversation.id, input, "other-key"), /Message ID is already in use/);
      await assert.rejects(service.createMessage(conversation.id, input), /idempotency key/);
      await assert.rejects(service.createMessage(conversation.id, { ...input, id: "invalid" }, "bad"), /valid message ID/);
      await assert.rejects(service.createMessage(conversation.id, { ...input, authoredInvocationId: "" }, "empty"), /Invalid authored/);
      const other = await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id, agent.id] });
      await assert.rejects(service.createMessage(other.id, input, "other-room"), /Message ID is already in use/);
      assert.deepEqual((await service.listMessages(conversation.id)).map(message => message.id), [first.id]);
      assert.equal((await service.getConversation(conversation.id)).messages[0]?.authoredInvocationId, input.authoredInvocationId);
      const thread = await service.createThread(conversation.id, { actorIdentityId: human.id, rootMessageId: first.id });
      assert.equal(thread.thread.context[0]?.authoredInvocationId, input.authoredInvocationId);
      unsubscribe();
      if (kind === "sqlite") {
        await storage.close?.();
        storage = await DrizzleLibSqlConversationStorage.open({ url });
        service = new ConversationService(storage);
        assert.deepEqual(await service.createMessage(conversation.id, input, "stable"), first);
        assert.equal((await service.listMessages(conversation.id))[0]?.authoredInvocationId, input.authoredInvocationId);
      }
      const ordinary = await service.createMessage(conversation.id, { participantId: human.id, to: [], body: "ordinary" }, "ordinary");
      assert.equal(ordinary.sequence, 2, "Conflicts must not allocate or consume sequences");
      assert.equal(ordinary.authoredInvocationId, undefined);
    } finally {
      await storage.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
