import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { FilesystemAttachmentContentStore, InMemoryAttachmentContentStore } from "../src/attachment-storage.ts";
import {
  ConversationAttachmentStorageError,
  ConversationConflictError,
  ConversationNotFoundError,
  ConversationService,
  ConversationValidationError,
} from "../src/conversation-service.ts";
import { createConversationHttpServer, type ConversationHttpServer } from "../src/http-server.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, validateImageBytes } from "../src/image-validation.ts";
import { createResourceId, isResourceId } from "../src/ids.ts";
import { InMemoryConversationStorage } from "../src/storage.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function createHumanConversation(service: ConversationService) {
  const human = await service.createIdentity({ type: "human", displayName: "You" });
  const agent = await service.createIdentity({ type: "agent", displayName: "Builder" });
  const workspace = await service.createWorkspace({ slug: `attachments-${Date.now()}`, name: "Attachments" });
  await service.addWorkspaceMember(workspace.id, {
    identityId: human.id,
    mentionHandle: "you",
    accessRole: "owner",
  });
  await service.addWorkspaceMember(workspace.id, {
    identityId: agent.id,
    mentionHandle: "builder",
  });
  const conversation = await service.createConversation({
    workspaceId: workspace.id,
    participantIds: [human.id, agent.id],
    actorIdentityId: human.id,
  });
  return { human, agent, workspace, conversation };
}

async function jsonRequest(server: ConversationHttpServer, path: string, init: RequestInit = {}) {
  const response = await fetch(`${server.endpoint}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${server.serviceToken}`,
      ...(init.headers ?? {}),
    },
  });
  return { response, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

test("image validation rejects unsupported, mismatched, empty, and oversized uploads", () => {
  assert.deepEqual(validateImageBytes({ bytes: png, claimedMimeType: "image/png" }), {
    ok: true,
    mimeType: "image/png",
    size: png.length,
  });
  assert.deepEqual(validateImageBytes({ bytes: png, claimedMimeType: "image/jpeg" }), {
    ok: false,
    reason: "type_mismatch",
  });
  assert.deepEqual(validateImageBytes({ bytes: png, claimedMimeType: "image/svg+xml" }), {
    ok: false,
    reason: "unsupported_type",
  });
  assert.deepEqual(validateImageBytes({ bytes: new Uint8Array(), claimedMimeType: "image/png" }), {
    ok: false,
    reason: "empty",
  });
  assert.deepEqual(validateImageBytes({ bytes: new Uint8Array(MAX_IMAGE_BYTES + 1), claimedMimeType: "image/png" }), {
    ok: false,
    reason: "too_large",
  });
});

test("staged images attach transactionally, survive idempotent retries, and expire when unclaimed", async () => {
  const storage = new InMemoryConversationStorage();
  const content = new InMemoryAttachmentContentStore();
  const service = new ConversationService(storage, content);
  const { human, agent, conversation } = await createHumanConversation(service);
  const staged = await service.uploadAttachment(conversation.id, human.id, "../tiny image.png", "image/png", png);
  assert.equal(staged.filename, "tiny-image.png");
  assert.equal(staged.mimeType, "image/png");
  assert.equal(staged.size, png.length);
  assert.equal(staged.contentUrl, `/conversations/${conversation.id}/attachments/${staged.id}/content`);
  assert.equal(await content.get(staged.id) !== undefined, true);
  await assert.rejects(
    () => service.readAttachmentContent(conversation.id, staged.id, agent.id),
    ConversationNotFoundError,
  );
  await assert.rejects(
    () => service.uploadAttachment(conversation.id, agent.id, "tiny.png", "image/png", png),
    ConversationValidationError,
  );
  await assert.rejects(
    () => service.uploadAttachment(conversation.id, human.id, "wrong.png", "image/png", Uint8Array.from([1, 2, 3])),
    ConversationValidationError,
  );

  const input = { participantId: human.id, body: "", attachmentIds: [staged.id] };
  const message = await service.createMessage(conversation.id, input, "image-send-1");
  assert.equal(message.body, "");
  assert.equal(message.attachments?.[0]?.id, staged.id);
  assert.equal(message.attachments?.[0]?.filename, "tiny-image.png");
  const replay = await service.createMessage(conversation.id, input, "image-send-1");
  assert.equal(replay.id, message.id);
  assert.equal(replay.sequence, message.sequence);
  await assert.rejects(
    () => service.createMessage(conversation.id, { ...input, body: "changed" }, "image-send-1"),
    ConversationConflictError,
  );
  await assert.rejects(
    () => service.createMessage(conversation.id, input),
    ConversationValidationError,
  );

  const orphan = await service.uploadAttachment(conversation.id, human.id, "orphan.png", "image/png", png);
  const cleanup = await service.cleanupStagedAttachments(new Date(Date.now() + 25 * 60 * 60 * 1_000));
  assert.equal(cleanup.scanned, 1);
  assert.equal(cleanup.deleted, 1);
  assert.equal(await storage.getAttachment(conversation.id, orphan.id), undefined);
  assert.equal(await content.get(orphan.id), undefined);
  assert.deepEqual([...(await service.readAttachmentContent(conversation.id, staged.id)).bytes], [...png]);
  await content.put(staged.id, Uint8Array.from([1, 2, 3]));
  await assert.rejects(
    () => service.readAttachmentContent(conversation.id, staged.id),
    ConversationNotFoundError,
  );
  await content.put(staged.id, png);
  const listed = await storage.listMessages(conversation.id);
  assert.equal(listed?.[0]?.attachments?.[0]?.id, staged.id);
});

test("HTTP attachment routes enforce the session actor, preserve bytes, and serve private content", async () => {
  const service = new ConversationService(new InMemoryConversationStorage(), new InMemoryAttachmentContentStore());
  const { human, agent, conversation } = await createHumanConversation(service);
  const server = await createConversationHttpServer({ service });
  try {
    const upload = await jsonRequest(server, `/conversations/${conversation.id}/attachments?filename=${encodeURIComponent("tiny.png")}`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-minu-actor-id": human.id,
      },
      body: Buffer.from(png),
    });
    assert.equal(upload.response.status, 201);
    const attachment = upload.body.attachment as { id: string; contentUrl: string };
    assert.equal(attachment.id.startsWith("attachment_"), true);

    const stolen = await fetch(`${server.endpoint}${attachment.contentUrl}`, {
      headers: { authorization: `Bearer ${server.serviceToken}`, "x-minu-actor-id": agent.id },
    });
    assert.equal(stolen.status, 404);

    const posted = await jsonRequest(server, `/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-minu-actor-id": human.id,
        "idempotency-key": "http-image-send",
      },
      body: JSON.stringify({ participantId: human.id, body: "", attachmentIds: [attachment.id] }),
    });
    assert.equal(posted.response.status, 201);
    assert.equal((posted.body.message as { attachments: Array<{ id: string }> }).attachments[0]?.id, attachment.id);

    const fetched = await fetch(`${server.endpoint}${attachment.contentUrl}`, {
      headers: { authorization: `Bearer ${server.serviceToken}`, "x-minu-actor-id": human.id },
    });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "image/png");
    assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
    assert.equal(fetched.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.deepEqual([...new Uint8Array(await fetched.arrayBuffer())], [...png]);

    const missingActor = await jsonRequest(server, `/conversations/${conversation.id}/attachments?filename=x.png`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.from(png),
    });
    assert.equal(missingActor.response.status, 400);

    const oversized = await jsonRequest(server, `/conversations/${conversation.id}/attachments?filename=large.png`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-minu-actor-id": human.id,
      },
      body: Buffer.alloc(MAX_IMAGE_BYTES + 1),
    });
    assert.equal(oversized.response.status, 413);
    const streamedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${server.endpoint}/conversations/${conversation.id}/attachments?filename=stream.png`, {
        method: "POST", headers: { authorization: `Bearer ${server.serviceToken}`, "x-minu-actor-id": human.id, "content-type": "image/png" },
      }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.write(Buffer.alloc(MAX_IMAGE_BYTES));
      request.end(Buffer.alloc(1));
    });
    assert.equal(streamedStatus, 413);
  } finally {
    await server.close();
  }
});

test("attachment storage failures do not expose filesystem paths", async () => {
  const storage = new InMemoryConversationStorage();
  const brokenContent = {
    async put() { throw new Error("EACCES: /private/product/attachments/image.png"); },
    async get() { throw new Error("EACCES: /private/product/attachments/image.png"); },
    async delete() {},
  };
  const service = new ConversationService(storage, brokenContent);
  const { human, conversation } = await createHumanConversation(service);
  await assert.rejects(
    () => service.uploadAttachment(conversation.id, human.id, "image.png", "image/png", png),
    (error) => error instanceof ConversationAttachmentStorageError
      && !error.message.includes("/private/product"),
  );

  const readableService = new ConversationService(storage, {
    async put() {},
    async get() { throw new Error("EACCES: /private/product/attachments/image.png"); },
    async delete() {},
  });
  const attachment = await readableService.uploadAttachment(conversation.id, human.id, "image.png", "image/png", png);
  await assert.rejects(
    () => readableService.readAttachmentContent(conversation.id, attachment.id, human.id),
    (error) => error instanceof ConversationAttachmentStorageError
      && !error.message.includes("/private/product"),
  );
});

test("filesystem attachment storage is owner-private and rejects path-shaped ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-attachment-content-"));
  const root = join(directory, "private-attachments");
  const content = new FilesystemAttachmentContentStore(root);
  const id = createResourceId("attachment");
  try {
    await content.put(id, png);
    assert.deepEqual([...(await content.get(id) ?? [])], [...png]);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, id))).mode & 0o777, 0o600);
    await assert.rejects(() => content.get("../outside"));
    await content.delete(id);
    assert.equal(await content.get(id), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("attachment IDs are opaque typed resource identifiers", () => {
  assert.equal(isResourceId(createResourceId("attachment"), "attachment"), true);
  assert.equal(isResourceId(createResourceId("message"), "attachment"), false);
});

test("container checks accept real raster fixtures and reject header-only or truncated files", () => {
  const fixtures = [
    ["image/png", png],
    ["image/gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")],
    ["image/webp", Buffer.from("UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA", "base64")],
    ["image/jpeg", Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z", "base64")],
  ] as const;
  for (const [claimedMimeType, bytes] of fixtures) {
    assert.equal(validateImageBytes({ bytes, claimedMimeType }).ok, true, claimedMimeType);
    for (const length of [3, 8, bytes.length - 1]) {
      assert.equal(validateImageBytes({ bytes: bytes.subarray(0, length), claimedMimeType }).ok, false, `${claimedMimeType} truncated to ${length}`);
    }
  }
});

test("attachment claims reject other Conversations, authors, duplicates, counts, and total size", async () => {
  const storage = new InMemoryConversationStorage();
  const service = new ConversationService(storage);
  const { human, agent, workspace, conversation } = await createHumanConversation(service);
  const other = await service.createConversation({ workspaceId: workspace.id, participantIds: [human.id] });
  const image = await service.uploadAttachment(conversation.id, human.id, "pixel.png", "image/png", png);
  for (const [id, author, ids] of [
    [other.id, human.id, [image.id]],
    [conversation.id, agent.id, [image.id]],
    [conversation.id, human.id, [image.id, image.id]],
    [conversation.id, human.id, Array(MAX_ATTACHMENTS_PER_MESSAGE + 1).fill(image.id)],
    [conversation.id, human.id, [createResourceId("attachment")]],
  ] as const) {
    await assert.rejects(service.createMessage(id, { participantId: author, body: "invalid", attachmentIds: [...ids] }), ConversationValidationError);
  }
  const large = createResourceId("attachment");
  await storage.stageAttachment({ ...(await storage.getAttachment(conversation.id, image.id))!, id: large, size: MAX_MESSAGE_ATTACHMENT_BYTES });
  await assert.rejects(service.createMessage(conversation.id, { participantId: human.id, body: "large", attachmentIds: [image.id, large] }), /Combined image/);
  assert.deepEqual(await service.listMessages(conversation.id), []);
});

test("filesystem cleanup recovers orphan bytes and temporary files, but retains message images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-image-orphans-"));
  const content = new FilesystemAttachmentContentStore(directory);
  const service = new ConversationService(new InMemoryConversationStorage(), content);
  try {
    const { human, conversation } = await createHumanConversation(service);
    const image = await service.uploadAttachment(conversation.id, human.id, "keep.png", "image/png", png);
    await service.createMessage(conversation.id, { participantId: human.id, body: "", attachmentIds: [image.id] });
    const orphan = createResourceId("attachment");
    await content.put(orphan, png);
    const temporary = `.${createResourceId("attachment")}.00000000-0000-0000-0000-000000000000.tmp`;
    await writeFile(join(directory, temporary), png);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await Promise.all([image.id, orphan, temporary].map((name) => utimes(join(directory, name), old, old)));
    await service.cleanupStagedAttachments();
    assert.deepEqual(await content.get(image.id), new Uint8Array(png));
    assert.equal(await content.get(orphan), undefined);
    await assert.rejects(stat(join(directory, temporary)), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
