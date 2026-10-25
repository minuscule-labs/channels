import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Worker } from "node:worker_threads";
import { deliveryDetail, type DeliveryRecord } from "@minu/channels-relay";
import { DiagnosticRecorder } from "../src/diagnostics-recorder.ts";
const scope = { workspaceId: "workspace", conversationId: "conversation", participantIdentityId: "agent", bindingId: "PRIVATE_BINDING", generation: 1, adapter: "pi", sessionId: "PRIVATE_SESSION", ownerId: "PRIVATE_OWNER" };
class FakeWorker extends EventEmitter {
  epoch = ""; packets: any[] = []; autoAck = true;
  unref() {}
  postMessage(packet: any) {
    this.packets.push(structuredClone(packet));
    if (this.autoAck && ["put", "put_delivery"].includes(packet.type)) queueMicrotask(() => this.ack(packet));
    if (packet.type === "close") queueMicrotask(() => { this.emit("message", { type: "closed", epoch: this.epoch }); this.emit("exit", 0); });
  }
  ack(packet: any) { this.emit("message", { type: packet.type === "put_delivery" ? "delivery_written" : "written", id: packet.record.trailId ?? packet.record.operationId, revision: packet.record.revision, epoch: this.epoch }); }
  async terminate() { this.emit("exit", 1); return 1; }
}
function fixture() {
  const worker = new FakeWorker();
  const recorder = new DiagnosticRecorder({ path: "/unused", workerFactory: (_url, data) => { worker.epoch = data.workerData.epoch; return worker as unknown as Worker; } });
  return { worker, recorder, ready() { worker.emit("message", { type: "ready", epoch: worker.epoch }); } };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { if (Date.now() > end) throw new Error("Fixture timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
test("capture has separate capacity, reuses triggers, coalesces repeated stages and bounds snapshots", async () => {
  const f = fixture();
  try {
    const trail = f.recorder.delivery.begin(scope, "trigger", 1)!;
    assert.equal(f.recorder.delivery.begin(scope, "trigger", 1), trail);
    for (let i = 0; i < 1000; i++) { trail.event("processing_started"); trail.event("runtime_waiting"); }
    for (let i = 0; i < 100; i++) {
      trail.event("retrying", { attempt: i + 1, prompt: "SECRET_PROMPT" } as never);
      trail.event("runtime_accepted", { attempt: i + 1 });
    }
    trail.event("response_committed", { responseSequence: 2 }); trail.event("cursor_committed"); trail.finish("delivered");
    for (let i = 1; i < 128; i++) assert.ok(f.recorder.delivery.begin(scope, `trigger_${i}`, i + 1));
    assert.equal(f.recorder.delivery.begin(scope, "overflow", 999), undefined);
    assert.equal(f.recorder.begin(scope, "stop").recorded, true, "normal turn pressure cannot consume lifecycle capture capacity");
    f.ready(); await until(() => f.worker.packets.some(packet => packet.type === "put_delivery"));
    const saved = f.worker.packets.find(packet => packet.type === "put_delivery").record as DeliveryRecord;
    assert.ok(saved.events.length <= 16); assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 8192);
    assert.equal(saved.events.filter(event => event.stage === "runtime_waiting").length, 1);
    assert.equal(saved.events.at(-1)?.stage, "cursor_committed"); assert.equal(saved.outcome, "delivered"); assert.ok(saved.eventsDropped > 0);
    assert.doesNotMatch(JSON.stringify(saved), /SECRET_PROMPT/);
    assert.doesNotMatch(JSON.stringify(deliveryDetail(saved)), /PRIVATE|bindingId|sessionId|ownerId|epoch/);
    trail.event("runtime_failed"); trail.finish("failed"); assert.equal(saved.outcome, "delivered");
  } finally { await f.recorder.close(); }
});
test("waiting lifecycle writes take priority over message traffic and stale acknowledgments cannot free their slot", async () => {
  const f = fixture(); f.worker.autoAck = false;
  try {
    f.ready(); f.recorder.delivery.begin(scope, "first", 1); const first = f.worker.packets[0];
    f.recorder.delivery.begin(scope, "second", 2); const operation = f.recorder.begin(scope, "stop"); operation.finish("succeeded");
    f.worker.ack(first);
    assert.equal(f.worker.packets[1].type, "put");
    f.worker.ack(first); assert.equal(f.worker.packets.length, 2);
    f.worker.ack(f.worker.packets[1]); assert.equal(f.worker.packets[2].type, "put_delivery");
    f.worker.autoAck = true; f.worker.ack(f.worker.packets[2]);
  } finally { await f.recorder.close(); }
});
test("closed binding observers become unknown without changing lifecycle gaps", async () => {
  const f = fixture();
  try {
    f.recorder.delivery.begin(scope, "trigger", 1); f.recorder.delivery.abandon(scope); f.ready();
    await until(() => f.worker.packets.some(packet => packet.type === "put_delivery"));
    assert.equal(f.worker.packets.find(packet => packet.type === "put_delivery").record.outcome, "unknown");
    assert.equal(f.recorder.recordingGap, false);
  } finally { await f.recorder.close(); }
});
test("real worker persists separate trail and operation pools, reads safe fields, and physically closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-worker-"));
  const recorder = new DiagnosticRecorder({ path: join(dir, "diagnostics.db") });
  try {
    await until(() => recorder.available);
    const trail = recorder.delivery.begin(scope, "trigger", 1)!; trail.event("processing_started"); trail.event("response_committed", { kind: "reply", responseSequence: 2 }); trail.finish("delivered");
    const operation = recorder.begin(scope, "stop"); operation.finish("succeeded");
    await until(async () => (await recorder.deliveryHistory(scope)).trails[0]?.outcome === "delivered");
    const history = await recorder.deliveryHistory(scope), detail = await recorder.deliveryDetail(scope, history.trails[0]!.trailId);
    assert.equal(detail?.outcome, "delivered"); assert.equal((await recorder.history(scope)).operations.length, 1);
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|triggerId|bindingId|epoch/);
    assert.equal(await recorder.deliveryDetail({ ...scope, ownerId: "foreign" }, history.trails[0]!.trailId), undefined);
    await assert.rejects(recorder.deliveryHistory({ ...scope, ownerId: "bad /owner" }), /Invalid diagnostic query/);
    assert.equal(recorder.available, true, "invalid selection cannot disable lifecycle diagnostics");
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});
