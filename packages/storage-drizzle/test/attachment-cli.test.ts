import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConversationClient, FilesystemAttachmentContentStore, createResourceId } from "@minu/channels-core";

const token = "disposable-image-cli-token";
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function start(directory: string, database = "channels.db") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    "--port", "0", "--db", join(directory, database), "--service-token", token], { stdio: ["ignore", "pipe", "pipe"] });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI startup timed out")); }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = /MinuChannels listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`CLI exited during startup: ${code}`)); });
  });
  return { endpoint, async close() { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } } };
}

function clientFor(server: Awaited<ReturnType<typeof start>>) {
  return new ConversationClient(server.endpoint, { serviceToken: token, actorIdentityId: "owner" });
}

async function shareImage(client: ConversationClient) {
  const conversation = await client.createConversation({ participants: [{ id: "owner", type: "human" }] });
  const image = await client.uploadAttachment(conversation.id, { filename: "persist.png", mimeType: "image/png", bytes });
  const message = await client.postMessage(conversation.id, { participantId: "owner", body: "", attachmentIds: [image.id] }, { idempotencyKey: "persist-image" });
  return { conversation, image, message };
}

async function assertImage(server: Awaited<ReturnType<typeof start>>, shared: Awaited<ReturnType<typeof shareImage>>) {
  assert.deepEqual(await clientFor(server).listMessages(shared.conversation.id), [shared.message]);
  const response = await fetch(`${server.endpoint}${shared.image.contentUrl}`, { headers: { authorization: `Bearer ${token}`, "x-minu-actor-id": "owner" } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
}

test("standalone local server preserves image bytes across process restart", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-image-cli-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(directory);
    const shared = await shareImage(clientFor(server));
    await server.close();
    const orphan = createResourceId("attachment");
    await new FilesystemAttachmentContentStore(join(directory, "attachments")).put(orphan, bytes);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(join(directory, "attachments", orphan), old, old);
    server = await start(directory);
    await assert.rejects(stat(join(directory, "attachments", orphan)), /ENOENT/);
    await assertImage(server, shared);
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("standalone databases in one directory cannot sweep each other's message images", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-image-cli-isolation-"));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(directory);
    const first = await shareImage(clientFor(server));
    await server.close();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const firstPath = join(directory, "attachments", first.image.id);
    await utimes(firstPath, old, old);

    server = await start(directory, "other.db");
    await stat(firstPath); // Starting another database must not delete the first database's bytes.
    const second = await shareImage(clientFor(server));
    await server.close();
    await utimes(join(directory, "attachments", "other.db", second.image.id), old, old);

    server = await start(directory);
    await assertImage(server, first);
    await server.close();
    server = await start(directory, "other.db");
    await assertImage(server, second);
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});
