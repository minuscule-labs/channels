import assert from "node:assert/strict";
import test from "node:test";
import { ConversationClient, ConversationClientError, createConversationHttpServer, InMemoryConversationStorage } from "@minu/channels-core";
import { ConversationRuntimeRelay, type AgentRuntimePort } from "../src/relay.ts";
import type { DeliveryEvent, DeliveryOutcome, DeliveryObservation, DeliveryStage } from "../src/delivery-diagnostics.ts";
async function fixture(mode: "normal" | "reused" | "lost-ack" | "cursor" | "fenced" | "throwing" | "legacy" | "failed" = "normal") {
  const server = await createConversationHttpServer({ port: 0 }), client = new ConversationClient(server.endpoint, { serviceToken: server.serviceToken });
  const owner = await client.createIdentity({ type: "human", displayName: "Owner" }), agent = await client.createIdentity({ type: "agent", displayName: "Agent" });
  const workspace = await client.createWorkspace({ slug: "delivery-trail", name: "Delivery trail" });
  await client.addWorkspaceMember(workspace.id, { identityId: owner.id, mentionHandle: "owner", accessRole: "owner" });
  await client.addWorkspaceMember(workspace.id, { identityId: agent.id, mentionHandle: "agent" });
  const conversation = await client.createConversation({ workspaceId: workspace.id, participantIds: [owner.id, agent.id] });
  const cursor = new InMemoryConversationStorage(); let starts = 0, lease = true, posts = 0, cursorFails = mode === "cursor";
  const events: Array<{ stage: DeliveryStage; extra?: Partial<DeliveryEvent> }> = []; let outcome: DeliveryOutcome = "pending";
  const observation: DeliveryObservation = { event(stage, extra) { if (outcome === "pending") events.push({ stage, extra }); }, finish(value) { if (outcome === "pending") outcome = value; } };
  const runtime: AgentRuntimePort = {
    async status() { return "idle"; }, async send() { starts++; }, async messages() { return starts ? [{ role: "assistant", content: "PRIVATE_RESPONSE" }] : []; },
    ...(mode === "legacy" ? {} : {
      async turn() { return mode === "reused" ? { id: "PRIVATE_TURN", status: "completed" as const, input: "PRIVATE_INPUT", response: { role: "assistant" as const, content: "PRIVATE_RESPONSE" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : undefined; },
      async startTurn(_session: string, id: string) { starts++; if (mode === "fenced") lease = false; return { id, status: mode === "failed" ? "failed" as const : "completed" as const, input: "PRIVATE_INPUT", error: "PRIVATE_ERROR", response: { role: "assistant" as const, content: "PRIVATE_RESPONSE" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; },
    }),
  };
  const post = client.postResponse.bind(client);
  client.postResponse = async (...args) => { const result = await post(...args); if (mode === "lost-ack" && ++posts === 1) throw new ConversationClientError("PRIVATE_LOST_ACK", 503); return result; };
  const relay = new ConversationRuntimeRelay({ client, conversationId: conversation.id, bindings: [{ participantId: agent.id, sessionId: "PRIVATE_SESSION", runtime, verifyLease: async () => lease }],
    cursorStore: { getCursor: cursor.getCursor.bind(cursor), setCursor: async (...args) => { if (cursorFails) { cursorFails = false; throw new Error("PRIVATE_CURSOR"); } await cursor.setCursor(...args); },
      commitDeliveryDeadLetter: async input => { await cursor.setCursor(input.conversationId, input.participantId, input.triggerSequence); } },
    onTurnDelivery: (_binding, trigger) => { assert.deepEqual(Object.keys(trigger), ["id", "sequence"]); if (mode === "throwing") return { event() { throw new Error("PRIVATE_LOGGER"); }, finish() { throw new Error("PRIVATE_LOGGER"); } }; return observation; },
    scheduleTurnRetryTimer: callback => { queueMicrotask(callback); return { cancel() {} }; },
  });
  await relay.start();
  const trigger = await client.postMessage(conversation.id, { participantId: owner.id, body: "@agent PRIVATE_MESSAGE" });
  return { client, conversation, agent, events, starts: () => starts, outcome: () => outcome, async wait() {
    const end = Date.now() + 3000;
    while (Date.now() < end) { if (mode === "fenced" ? outcome === "unknown" : (await client.listMessages(conversation.id)).length === 2 && !relay.activity(agent.id)) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("Delivery fixture timeout");
  }, async close() { await relay.stop(); await server.close(); }, trigger };
}
test("normal recoverable turns capture only missing milestones in execution order", async () => {
  const f = await fixture();
  try { await f.wait(); assert.deepEqual(f.events.map(event => event.stage), ["processing_started", "dispatch_requested", "runtime_accepted", "runtime_completed", "delivery_requested", "response_committed", "cursor_committed"]); assert.equal(f.outcome(), "delivered"); assert.equal(f.starts(), 1); assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE/); }
  finally { await f.close(); }
});
for (const mode of ["reused", "lost-ack", "cursor", "fenced", "legacy", "failed", "throwing"] as const) test(`delivery observations preserve ${mode} execution/delivery semantics`, async () => {
  const f = await fixture(mode);
  try {
    await f.wait();
    if (mode === "reused") { assert.equal(f.starts(), 0); assert.ok(f.events.some(event => event.stage === "runtime_reused")); assert.ok(!f.events.some(event => event.stage === "dispatch_requested")); }
    if (mode === "lost-ack") { assert.equal(f.starts(), 1); assert.ok(f.events.some(event => event.stage === "response_reused")); assert.ok(!f.events.some(event => event.stage === "response_committed")); assert.equal(f.outcome(), "response_reused"); assert.equal(f.events.find(event => event.stage === "response_reused")?.extra?.kind, undefined); }
    if (mode === "cursor") { assert.equal(f.outcome(), "unknown"); assert.equal(f.events.at(-1)?.extra?.reason, "cursor_commit_failed"); assert.ok(f.events.some(event => event.stage === "response_committed")); }
    if (mode === "fenced") { assert.equal(f.outcome(), "unknown"); assert.ok(!f.events.some(event => event.stage === "response_committed")); }
    if (mode === "legacy") { assert.equal(f.outcome(), "delivered"); assert.ok(!f.events.some(event => event.stage === "runtime_accepted" || event.stage === "runtime_completed")); }
    if (mode === "failed") { assert.equal(f.outcome(), "failed"); assert.ok(f.events.some(event => event.stage === "runtime_failed")); assert.ok(f.events.some(event => event.extra?.kind === "failure_notice")); }
    if (mode === "throwing") assert.equal(f.starts(), 1);
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE/);
  } finally { await f.close(); }
});
