import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient, ConversationService, InMemoryAttachmentContentStore, createConversationHttpServer } from "@minu/channels-core";
import { ConversationRuntimeRelay, type AgentRuntimePort, type RuntimePortImage, type RuntimePortMessage, type RuntimePortTurn } from "../src/relay.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
class RecordingRuntime implements AgentRuntimePort {
  calls: Array<{ text: string; images?: RuntimePortImage[] }> = [];
  transcript: RuntimePortMessage[] = [];
  inputCapabilities: AgentRuntimePort["inputCapabilities"] = async () => ({ version: 1, images: true });
  async status() { return "idle" as const; }
  async interrupt() {}
  async messages() { return [...this.transcript]; }
  async send(_session: string, text: string, images?: RuntimePortImage[]) {
    this.calls.push({ text, images });
    this.transcript.push({ role: "assistant", content: "Controlled reply" });
  }
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for image turn");
}
async function fixture(runtime: AgentRuntimePort, contextSequenceFloor?: number) {
  const content = new InMemoryAttachmentContentStore();
  const service = new ConversationService(undefined, content);
  const server = await createConversationHttpServer({ service });
  const client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const humanClient = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken, actorIdentityId: "human" });
  const conversation = await client.createConversation({ participants: [{ id: "human", type: "human" }, { id: "agent", type: "agent" }] });
  const relay = new ConversationRuntimeRelay({ client, conversationId: conversation.id,
    bindings: [{ participantId: "agent", sessionId: "controlled", runtime, wakePolicy: "direct_mentions", contextSequenceFloor }],
    turnPollIntervalMs: 5 });
  const upload = (name: string, bytes = png) => humanClient.uploadAttachment(conversation.id, { filename: name, bytes, mimeType: "image/png" });
  const post = (ids: string[], trigger = false) => humanClient.postMessage(conversation.id, { participantId: "human", body: "", attachmentIds: ids, to: trigger ? ["agent"] : [] });
  return { client, conversation, relay, upload, post, content, async close() { await relay.stop(); await server.close(); } };
}

test("Relay delivers bounded recent-context pixels in order, not paths/URLs or public message bodies", async () => {
  const runtime = new RecordingRuntime();
  const f = await fixture(runtime);
  try {
    const images = [];
    for (let index = 0; index < 6; index += 1) images.push(await f.upload(`image-${index}.png`));
    await f.post(images.slice(0, 2).map((image) => image.id));
    await f.post(images.slice(2, 4).map((image) => image.id));
    await f.relay.start();
    await f.post(images.slice(4).map((image) => image.id), true);
    await waitFor(() => runtime.calls.length === 1);
    const call = runtime.calls[0]!;
    assert.equal(call.images?.length, 4);
    assert.ok(call.images?.every((image) => image.data === png.toString("base64") && image.mimeType === "image/png"));
    assert.match(call.text, /"image-0.png"; image pixels are not available/);
    assert.match(call.text, /"image-2.png"; pixels supplied as image 1/);
    assert.match(call.text, /"image-5.png"; pixels supplied as image 4/);
    assert.doesNotMatch(call.text, /\/attachments\/|data:image|iVBOR/);
    await waitFor(async () => (await f.client.listMessages(f.conversation.id)).length === 4);
    assert.equal((await f.client.listMessages(f.conversation.id))[2]?.body, "");
  } finally { await f.close(); }
});

for (const capability of ["missing", "false", "error"] as const) test(`unverified image capability (${capability}) never reads or sends pixels`, async () => {
  const runtime = new RecordingRuntime();
  runtime.inputCapabilities = capability === "missing" ? undefined : async () => {
    if (capability === "error") throw new Error("unavailable capability");
    return { version: 1, images: false };
  };
  const f = await fixture(runtime);
  let reads = 0;
  f.client.readAttachmentContent = async () => { reads += 1; throw new Error("must not read"); };
  try {
    const image = await f.upload("unknown.png");
    await f.relay.start();
    await f.post([image.id], true);
    await waitFor(() => runtime.calls.length === 1);
    assert.equal(reads, 0);
    assert.equal(runtime.calls[0]?.images, undefined);
    assert.match(runtime.calls[0]!.text, /image pixels are not available/);
  } finally { await f.close(); }
});

test("missing images retain honest markers while available pixels and fresh context survive", async () => {
  const runtime = new RecordingRuntime();
  const f = await fixture(runtime, 1);
  try {
    const old = await f.upload("before-fresh.png");
    await f.post([old.id]);
    const missing = await f.upload("missing.png");
    const present = await f.upload("present.png");
    await f.content.delete(missing.id);
    await f.relay.start();
    await f.post([missing.id, present.id], true);
    await waitFor(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0]?.images?.length, 1);
    assert.match(runtime.calls[0]!.text, /"missing.png"; image pixels are not available/);
    assert.match(runtime.calls[0]!.text, /"present.png"; pixels supplied as image 1/);
    assert.doesNotMatch(runtime.calls[0]!.text, /before-fresh/);
  } finally { await f.close(); }
});

test("Relay bounds aggregate pixels across context messages to 20 MiB", async () => {
  const runtime = new RecordingRuntime();
  const f = await fixture(runtime);
  // A valid container with a large ancillary chunk, without introducing a pixel decoder.
  const ancillary = Buffer.alloc(8 * 1024 * 1024 - png.length);
  ancillary.writeUInt32BE(ancillary.length - 12, 0);
  ancillary.write("tEXt", 4);
  const large = Buffer.concat([png.subarray(0, -12), ancillary, png.subarray(-12)]);
  try {
    for (let index = 0; index < 3; index += 1) {
      const image = await f.upload(`large-${index}.png`, large);
      await f.post([image.id], index === 2);
    }
    await f.relay.start();
    await waitFor(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0]?.images?.length, 2);
    assert.equal(runtime.calls[0]!.images!.reduce((size, image) => size + Buffer.from(image.data, "base64").length, 0), 16 * 1024 * 1024);
    assert.match(runtime.calls[0]!.text, /"large-0.png"; image pixels are not available/);
  } finally { await f.close(); }
});

test("recoverable turns do not refetch pixels or redispatch an already accepted image turn", async () => {
  const runtime = new RecordingRuntime();
  const recoverable: AgentRuntimePort = Object.assign(runtime, {
    async startTurn(): Promise<RuntimePortTurn> { throw new Error("must not redispatch"); },
    async turn(_session: string, id: string): Promise<RuntimePortTurn> {
      const now = new Date().toISOString();
      return { id, input: "already accepted", status: "completed", response: { role: "assistant", content: "Recovered reply" }, createdAt: now, updatedAt: now };
    },
  });
  const f = await fixture(recoverable);
  let reads = 0;
  f.client.readAttachmentContent = async () => { reads += 1; throw new Error("must not read"); };
  runtime.inputCapabilities = async () => { throw new Error("must not inspect"); };
  try {
    const image = await f.upload("recover.png");
    await f.relay.start();
    await f.post([image.id], true);
    await waitFor(async () => (await f.client.listMessages(f.conversation.id)).length === 2);
    assert.equal(reads, 0);
    assert.equal(runtime.calls.length, 0);
    assert.equal((await f.client.listMessages(f.conversation.id))[1]?.body, "Recovered reply");
  } finally { await f.close(); }
});

test("cancellation during pixel loading cannot dispatch a new turn", async () => {
  const runtime = new RecordingRuntime();
  const f = await fixture(runtime);
  let release!: () => void;
  let reading = false;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  f.client.readAttachmentContent = async () => { reading = true; await hold; return { bytes: png, mimeType: "image/png" }; };
  try {
    const image = await f.upload("cancel.png");
    await f.relay.start();
    const message = await f.post([image.id], true);
    await waitFor(() => reading);
    await f.relay.cancelCurrent("agent", "human");
    release();
    await waitFor(() => f.relay.cursor("agent") === message.sequence);
    assert.equal(runtime.calls.length, 0);
  } finally { release?.(); await f.close(); }
});
