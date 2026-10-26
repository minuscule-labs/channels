// Controlled cross-repository integration: never invokes the installed Pi executable.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConversationClient, ConversationService, FilesystemAttachmentContentStore, createConversationHttpServer } from "../packages/core/dist/src/index.js";
import { DrizzleLibSqlConversationStorage, localLibSqlUrl } from "../packages/storage-drizzle/dist/src/storage.js";
import { ConversationRuntimeRelay } from "../packages/relay/dist/src/index.js";

const runtimeRoot = resolve(process.env.MINU_RUNTIME_ROOT ?? fileURLToPath(new URL("../../runtime/", import.meta.url)));
const runtimeModule = resolve(process.env.MINU_RUNTIME_MODULE ?? join(runtimeRoot, "packages/pi/dist/src/client.js"));
const { PiAgentRuntime } = await import(pathToFileURL(runtimeModule).href);
const temporary = await mkdtemp(join(tmpdir(), "channels-image-vision-"));
const fakePi = join(temporary, "controlled-pi.mjs");
const requestsFile = join(temporary, "requests.jsonl");
// Use the exact image fixture accepted by the Conversation raster-container validator.
const pixels = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const savedEnvironment = { PI_COMMAND: process.env.PI_COMMAND, MINU_RUNTIME_DIR: process.env.MINU_RUNTIME_DIR };
let storage;
let server;
let relay;
let session;
const runtime = new PiAgentRuntime();
const owner = "controlled-image-owner";
async function waitFor(check) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Image vision integration timed out");
}
try {
  await writeFile(fakePi, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const file = process.argv[process.argv.indexOf("--session") + 1];
const lines = readFileSync(file, "utf8").trim().split("\\n");
const header = JSON.parse(lines[0]);
const messages = lines.slice(1).map(line => JSON.parse(line).message).filter(Boolean);
function persist() {
  const entries = messages.map((message, index) => ({ type: "message", id: String(index + 1), parentId: index ? String(index) : null, timestamp: new Date(message.timestamp).toISOString(), message }));
  writeFileSync(file, [header, ...entries].map(entry => JSON.stringify(entry)).join("\\n") + "\\n");
}
if (!messages.length) { messages.push({ role: "system", content: "", timestamp: Date.now() }); persist(); }
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const respond = data => console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }));
    if (request.type === "get_state") respond({ sessionId: "controlled-native", sessionFile: file, isStreaming: false, model: { provider: "controlled", id: "vision-fixture", input: ["text", "image"] } });
    else if (request.type === "get_messages") respond({ messages });
    else if (request.type === "prompt") {
      appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(request) + "\\n", { mode: 0o600 });
      const valid = request.images?.length === 1 && request.images[0].data === ${JSON.stringify(pixels.toString("base64"))};
      messages.push({ role: "user", content: [{ type: "text", text: request.message }, ...(request.images ?? [])], timestamp: Date.now() });
      messages.push({ role: "assistant", content: [{ type: "text", text: valid ? "PIXELS_OK" : "PIXELS_MISSING" }], timestamp: Date.now() });
      persist(); respond(undefined);
      console.log(JSON.stringify({ type: "agent_settled" }));
    } else respond({});
  }
});
process.on("SIGTERM", () => process.exit(0));
`, { mode: 0o700 });
  await chmod(fakePi, 0o700);
  process.env.PI_COMMAND = fakePi;
  process.env.MINU_RUNTIME_DIR = join(temporary, "runtime");
  session = await runtime.startManaged({ cwd: temporary }, owner);
  const url = localLibSqlUrl(join(temporary, "channels.db"));
  async function open() {
    storage = await DrizzleLibSqlConversationStorage.open({ url });
    server = await createConversationHttpServer({ service: new ConversationService(storage, new FilesystemAttachmentContentStore(join(temporary, "attachments"))) });
    return new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  }
  let client = await open();
  const conversation = await client.createConversation({ participants: [{ id: "human", type: "human" }, { id: "agent", type: "agent" }] });
  const human = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken, actorIdentityId: "human" });
  const image = await human.uploadAttachment(conversation.id, { filename: "controlled.png", mimeType: "image/png", bytes: pixels });
  async function attach() {
    relay = new ConversationRuntimeRelay({ client, conversationId: conversation.id, cursorStore: storage,
      bindings: [{ participantId: "agent", sessionId: session.id, runtime }], turnPollIntervalMs: 10 });
    await relay.start();
  }
  await attach();
  await human.postMessage(conversation.id, { participantId: "human", body: "Inspect this image", attachmentIds: [image.id] }, { idempotencyKey: "vision-once" });
  await waitFor(async () => (await client.listMessages(conversation.id)).at(-1)?.body === "PIXELS_OK");
  await relay.stop(); relay = undefined;
  await server.close(); server = undefined;
  await storage.close(); storage = undefined;
  await runtime.suspend(session.id, owner);
  session = await runtime.resume(session.id, owner);
  client = await open();
  const reopened = await client.listMessages(conversation.id);
  assert.equal(reopened.length, 2);
  assert.equal(reopened[0].attachments[0].id, image.id);
  assert.deepEqual((await client.readAttachmentContent(conversation.id, image.id)).bytes, new Uint8Array(pixels));
  await attach();
  await client.postMessage(conversation.id, { participantId: "human", body: "Recheck the earlier image" });
  await waitFor(async () => (await client.listMessages(conversation.id)).length === 4);
  assert.equal((await client.listMessages(conversation.id)).at(-1).body, "PIXELS_OK");
  const requests = (await readFile(requestsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.images.length === 1 && request.images[0].data === pixels.toString("base64")));
  assert.ok(!JSON.stringify(await runtime.messages(session.id)).includes(pixels.toString("base64")));
  console.log("Image vision smoke passed: Conversation HTTP/SQLite/files → Relay → Runtime HTTP/owned worker → controlled Pi RPC, including suspend/resume and storage reopen");
} finally {
  await relay?.stop().catch(() => {});
  if (session) await runtime.destroy(session.id, owner).catch(() => {});
  await server?.close().catch(() => {});
  await storage?.close().catch(() => {});
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temporary, { recursive: true, force: true });
}
