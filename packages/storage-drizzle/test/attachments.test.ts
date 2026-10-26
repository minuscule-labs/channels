import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationService, FilesystemAttachmentContentStore } from "@minu/channels-core";
import { DrizzleLibSqlConversationStorage, localLibSqlUrl } from "../src/storage.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("Drizzle persists staged and attached image metadata and sweeps abandoned uploads after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-attachments-"));
  const url = localLibSqlUrl(join(directory, "channels.db"));
  const content = new FilesystemAttachmentContentStore(join(directory, "attachments"));
  let storage = await DrizzleLibSqlConversationStorage.open({ url });
  try {
    let service = new ConversationService(storage, content);
    const human = await service.createIdentity({ type: "human", displayName: "You" });
    const agent = await service.createIdentity({ type: "agent", displayName: "Builder" });
    const workspace = await service.createWorkspace({ slug: "attachment-persistence", name: "Attachments" });
    await service.addWorkspaceMember(workspace.id, {
      identityId: human.id,
      mentionHandle: "you",
      accessRole: "owner",
    });
    await service.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "builder" });
    const conversation = await service.createConversation({
      workspaceId: workspace.id,
      participantIds: [human.id, agent.id],
      actorIdentityId: human.id,
    });
    const attachment = await service.uploadAttachment(conversation.id, human.id, "stored.png", "image/png", png);
    const abandoned = await service.uploadAttachment(conversation.id, human.id, "abandoned.png", "image/png", png);
    const message = await service.createMessage(conversation.id, {
      participantId: human.id,
      body: "",
      attachmentIds: [attachment.id],
    }, "stored-image-send");
    assert.equal(message.attachments?.[0]?.id, attachment.id);
    const legacyInput = { participantId: human.id, body: "legacy text retry" };
    const legacyMessage = await service.createMessage(conversation.id, legacyInput, "legacy-text-retry");
    const direct = createClient({ url });
    try {
      const records = await direct.execute({
        sql: "SELECT request_fingerprint FROM message_idempotency WHERE idempotency_key = ?",
        args: ["legacy-text-retry"],
      });
      const legacyFingerprint = createHash("sha256").update(JSON.stringify({
        participantId: human.id,
        body: "legacy text retry",
        to: [],
        replyTo: null,
      })).digest("hex");
      assert.equal(records.rows[0]?.request_fingerprint, legacyFingerprint);
    } finally {
      direct.close();
    }
    assert.equal((await service.createMessage(conversation.id, legacyInput, "legacy-text-retry")).id, legacyMessage.id);
    await storage.close();

    storage = await DrizzleLibSqlConversationStorage.open({ url });
    service = new ConversationService(storage, new FilesystemAttachmentContentStore(join(directory, "attachments")));
    const messages = await service.listMessages(conversation.id);
    assert.equal(messages[0]?.id, message.id);
    assert.equal(messages[0]?.attachments?.[0]?.filename, "stored.png");
    assert.equal((await storage.getAttachment(conversation.id, attachment.id))?.status, "attached");
    assert.deepEqual((await service.readAttachmentContent(conversation.id, attachment.id)).bytes, new Uint8Array(png));
    await assert.rejects(new ConversationService(storage).uploadAttachment(conversation.id, human.id, "lost.png", "image/png", png), /not configured/);

    const cleanup = await service.cleanupStagedAttachments(new Date(Date.now() + 25 * 60 * 60 * 1_000));
    assert.deepEqual(cleanup, { scanned: 1, deleted: 1 });
    assert.equal(await storage.getAttachment(conversation.id, abandoned.id), undefined);
    assert.equal(await storage.getAttachment(conversation.id, attachment.id) !== undefined, true);
  } finally {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
