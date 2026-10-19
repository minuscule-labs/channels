import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type { DiagnosticRecord } from "@minu/channels-relay";
import { DiagnosticRecorder } from "../src/diagnostics-recorder.ts";

const scope = { workspaceId: "workspace-a", conversationId: "conversation-a", participantIdentityId: "agent-a" };
interface Packet { type: string; epoch: string; record?: DiagnosticRecord; requestId?: number }
class FakeWorker extends EventEmitter {
  epoch = "";
  packets: Packet[] = [];
  autoAck = true;
  terminated = 0;
  unref() { return this; }
  postMessage(input: unknown) {
    const packet = structuredClone(input) as Packet;
    this.packets.push(packet);
    if (packet.type === "put" && this.autoAck) queueMicrotask(() => this.ack(packet));
    if (packet.type === "close") queueMicrotask(() => this.emit("message", { type: "closed", epoch: this.epoch }));
  }
  ack(packet: Packet) { this.emit("message", { type: "written", epoch: this.epoch, id: packet.record?.operationId, revision: packet.record?.revision }); }
  ready() { this.emit("message", { type: "ready", epoch: this.epoch }); }
  async terminate() { this.terminated++; this.emit("exit", 0); return 0; }
}
function fake(options: { startupTimeoutMs?: number; ioTimeoutMs?: number; now?: () => Date; monotonicNow?: () => number } = {}) {
  const worker = new FakeWorker();
  const recorder = new DiagnosticRecorder({ path: "/unused-fixture-path", ...options, workerFactory: (_url, config) => {
    worker.epoch = config.workerData.epoch; return worker as unknown as Worker;
  } });
  return { worker, recorder };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error("Diagnostic fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("bounded recorder coalesces progress, reserves a terminal event, and rejects excess operations without waiting", async () => {
  const { recorder, worker } = fake();
  try {
    const operation = recorder.begin(scope, "stop");
    for (let i = 0; i < 500; i++) operation.event("interrupt_requested", "started");
    const others = Array.from({ length: 127 }, () => recorder.begin(scope, "stop"));
    const overflow = recorder.begin(scope, "start");
    assert.equal(overflow.recorded, false);
    assert.equal(recorder.recordingGap, true);
    assert.equal(worker.packets.length, 0, "initialization never blocks a lifecycle caller");
    operation.event("pause_committed", "confirmed");
    operation.finish("succeeded");
    others.forEach((item) => item.finish("unknown"));
    worker.ready();
    await until(() => worker.packets.filter((packet) => packet.type === "put").length === 128);
    const saved = worker.packets.find((packet) => packet.record?.operationId === operation.operationId)!.record!;
    assert.equal(saved.events.length, 128);
    assert.equal(saved.events.at(-1)?.stage, "completed");
    assert.equal(saved.events.at(-1)?.result, "confirmed");
    assert.equal(saved.outcome, "succeeded");
    assert.equal(saved.lastConfirmedStage, "pause_committed");
    assert.ok(saved.eventsDropped > 0);
    assert.equal(saved.recordingGap, true);
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 128 * 1024);
    assert.equal(worker.packets.some((packet) => packet.record?.operationId === overflow.operationId), false);
    const unknown = worker.packets.find((packet) => packet.record?.operationId === others[0]!.operationId)!.record!;
    assert.equal(unknown.outcome, "unknown");
    assert.equal(unknown.finishedAt, undefined);
  } finally { await recorder.close(); }
});

test("worker construction, startup timeout, crash and stalled writes cannot throw through observation calls", async () => {
  const failed = new DiagnosticRecorder({ path: "/unused", workerFactory() { throw new Error("private credential canary"); } });
  assert.equal(failed.begin(scope, "stop").recorded, false);
  await failed.close();
  for (const failure of ["startup", "crash", "write", "malformed"] as const) {
    const { worker, recorder } = fake({ startupTimeoutMs: 30, ioTimeoutMs: 30 });
    try {
      const operation = recorder.begin(scope, "stop");
      if (failure !== "startup") { worker.autoAck = false; worker.ready(); }
      if (failure === "crash") worker.emit("error", new Error("private raw native error"));
      if (failure === "malformed") assert.doesNotThrow(() => worker.emit("message", null));
      await until(() => recorder.recordingGap);
      assert.equal(recorder.available, false);
      assert.equal(operation.recorded, false);
      assert.doesNotThrow(() => { operation.event("pause_committed", "confirmed"); operation.finish("succeeded"); });
      assert.equal(recorder.begin(scope, "start").recorded, false);
      await assert.rejects(recorder.history(scope), { message: "Diagnostic journal unavailable" });
      assert.equal(worker.terminated, 1);
    } finally { await recorder.close(); }
  }
});

test("stale worker acknowledgments cannot release newer snapshots or complete unrelated reads", async () => {
  const { worker, recorder } = fake();
  try {
    worker.autoAck = false;
    worker.ready();
    const operation = recorder.begin(scope, "stop");
    const initial = worker.packets[0]!;
    operation.event("pause_committed", "confirmed");
    operation.finish("succeeded");
    worker.emit("message", { type: "written", epoch: "wrong-epoch", id: operation.operationId, revision: initial.record!.revision });
    assert.equal(worker.packets.length, 1);
    worker.ack(initial);
    const final = worker.packets[1]!;
    assert.equal(final.record?.outcome, "succeeded");
    worker.ack(initial);
    assert.equal(worker.packets.length, 2);
    worker.ack(final);
    worker.autoAck = true;
  } finally { await recorder.close(); }
});

test("malformed observation fields are dropped before IPC and never become free-form event labels", async () => {
  const { worker, recorder } = fake();
  try {
    const operation = recorder.begin(scope, "stop");
    operation.event("private raw error" as "completed", "confirmed");
    operation.event("pause_committed", "confirmed", { reasonCode: "secret-path" as "unavailable" });
    operation.event("pause_committed", "confirmed", { triggerSequence: Infinity });
    operation.finish("unknown");
    worker.ready();
    await until(() => worker.packets.length > 0);
    const serialized = JSON.stringify(worker.packets);
    assert.ok(!serialized.includes("private raw error"));
    assert.ok(!serialized.includes("secret-path"));
    assert.equal(worker.packets[0]?.record?.recordingGap, true);
    assert.equal(recorder.begin({ ...scope, workspaceId: "/private/workspace" }, "start").recorded, false);
    const taintedScope = { ...scope, privateToken: "do-not-copy-unknown-scope-fields" };
    const request = recorder.history(taintedScope).catch(() => undefined);
    assert.ok(!JSON.stringify(worker.packets).includes(taintedScope.privateToken));
    await recorder.close();
    await request;
  } finally { await recorder.close(); }
});

test("read requests are bounded and a stalled read disables the optional worker", async () => {
  const { worker, recorder } = fake({ ioTimeoutMs: 30 });
  try {
    worker.ready();
    const requests = Array.from({ length: 17 }, () => recorder.history(scope));
    const results = await Promise.allSettled(requests);
    assert.equal(worker.packets.filter((packet) => packet.type === "history").length, 16);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(recorder.available, false);
    assert.equal(worker.terminated, 1);
  } finally { await recorder.close(); }
});

test("shutdown abandons a nonresponsive optional worker within its flush budget", { timeout: 3_000 }, async () => {
  const { worker, recorder } = fake();
  recorder.begin(scope, "stop");
  const started = performance.now();
  await recorder.close();
  assert.ok(performance.now() - started < 1_500, "must not wait for the five-second startup deadline");
  assert.equal(worker.terminated, 1);
  assert.equal(recorder.recordingGap, true);
});

test("clean recorder shutdown rejects outstanding reads instead of leaving their promises pending", async () => {
  const { worker, recorder } = fake();
  worker.ready();
  const request = Promise.allSettled([recorder.history(scope)]);
  await recorder.close();
  assert.equal((await request)[0]?.status, "rejected");
  assert.equal(worker.terminated, 0);
});

test("private observation scope cannot change after it is captured", async () => {
  const { worker, recorder } = fake();
  try {
    const operation = recorder.begin(scope, "cancel_current");
    operation.correlate({ sourceBinding: { id: "binding-a", generation: 2 }, trigger: { messageId: "message-a", sequence: 42 } });
    operation.correlate({ sourceBinding: { id: "binding-a", generation: 3 } });
    operation.requestFinished("handler_returned");
    operation.requestFinished("handler_failed");
    worker.ready();
    await until(() => worker.packets.length > 0);
    const record = worker.packets[0]!.record!;
    assert.equal(record.correlations?.sourceBinding?.generation, 2);
    assert.equal(record.correlations?.trigger?.sequence, 42);
    assert.equal(record.recordingGap, true);
    assert.equal(record.requestDisposition, "handler_returned");
    assert.equal(record.outcome, "pending");
  } finally { await recorder.close(); }
});

test("operation durations use a monotonic clock rather than subtracting wall-clock timestamps", async () => {
  let wall = Date.now(), monotonic = 100;
  const { worker, recorder } = fake({ now: () => new Date(wall), monotonicNow: () => monotonic });
  try {
    const operation = recorder.begin(scope, "stop");
    wall -= 60_000; monotonic += 123;
    operation.event("pause_committed", "confirmed");
    operation.finish("succeeded");
    worker.ready();
    await until(() => worker.packets.length > 0);
    const saved = worker.packets[0]!.record!;
    assert.equal(saved.elapsedMs, 123);
    assert.ok(Date.parse(saved.finishedAt!) < Date.parse(saved.requestedAt));
    const invalidClock = recorder.begin(scope, "stop");
    monotonic = NaN;
    assert.doesNotThrow(() => invalidClock.event("pause_committed", "confirmed"));
    assert.equal(recorder.available, false);
    assert.equal(invalidClock.recorded, false);
    assert.ok(worker.packets.every((packet) => !packet.record || Number.isFinite(packet.record.elapsedMs)));
  } finally { await recorder.close(); }
});

test("real worker persists late bulk-target results and bounded aggregate coverage", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-bulk-recorder-"));
  const recorder = new DiagnosticRecorder({ path: join(directory, "journal.db") });
  try {
    const parent = recorder.begin(scope, "bulk_start");
    const progress = { targets: 1, completed: 0, started: 0, stopped: 0, skipped: 0, failed: 0, unknown: 0, childrenUnrecorded: 0 };
    parent.bulkProgress(progress);
    const child = recorder.begin(scope, "start", { parentOperationId: parent.operationId });
    child.requestFinished("not_applicable"); child.finish("succeeded");
    await until(() => recorder.available);
    await until(async () => (await recorder.detail(scope, child.operationId))?.operation.outcome === "succeeded");
    child.targetResult({ outcome: "started" });
    await until(async () => (await recorder.detail(scope, child.operationId))?.operation.bulkTarget?.outcome === "started");
    parent.bulkProgress({ ...progress, completed: 1, started: 1 });
    parent.bulkProgress(progress); // A late older counter snapshot must not regress progress.
    parent.requestFinished("handler_returned"); parent.finish("succeeded");
    await until(async () => (await recorder.detail(scope, parent.operationId))?.operation.outcome === "succeeded");
    const summary = (await recorder.detail(scope, parent.operationId))!.operation;
    assert.equal(summary.bulk?.completed, 1); assert.equal(summary.bulk?.childrenUnavailable, 0);
    assert.equal(recorder.recordingGap, true, "rejected regressing observations disclose a gap");
  } finally { await recorder.close(); await rm(directory, { recursive: true, force: true }); }
});

test("real worker persists safe operations, tolerates invalid cursors, and reconciles epochs on reopen", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-recorder-worker-"));
  const path = join(directory, "journal.db");
  let recorder = new DiagnosticRecorder({ path });
  try {
    const pending = recorder.begin(scope, "cancel_current");
    pending.correlate({ sourceBinding: { id: "binding-a", generation: 2 }, trigger: { messageId: "message-a", sequence: 42 } });
    pending.event("interrupt_requested", "started", { source: "relay", triggerSequence: 42 });
    pending.requestFinished("handler_returned");
    const stopped = recorder.begin(scope, "stop");
    stopped.event("pause_committed", "confirmed");
    stopped.finish("succeeded");
    await until(() => recorder.available);
    await until(async () => (await recorder.history(scope)).operations.some((operation) => operation.operationId === stopped.operationId && operation.outcome === "succeeded"));
    stopped.requestFinished("handler_returned");
    await until(async () => (await recorder.detail(scope, stopped.operationId))?.operation.requestDisposition === "handler_returned");
    await assert.rejects(recorder.history(scope, "not-a-cursor"), { message: "Invalid diagnostic query" });
    assert.equal(recorder.available, true);
    const accepted = (await recorder.detail(scope, pending.operationId))!.operation;
    assert.equal(accepted.outcome, "pending", "handler return is not cancellation settlement");
    assert.equal(accepted.requestDisposition, "handler_returned");
    assert.equal(accepted.triggerSequence, 42);
    const reference = { bindingId: "binding-a", generation: 2, triggerMessageId: "message-a", triggerSequence: 42 };
    assert.deepEqual(await recorder.correlated(scope, reference), [pending.operationId]);
    assert.deepEqual(await recorder.correlated(scope, { ...reference, generation: 3 }), []);
    assert.deepEqual(await recorder.correlated({ ...scope, participantIdentityId: "agent-other" }, reference), []);
    await assert.rejects(recorder.correlated(scope, { ...reference, generation: -1 }), { message: "Invalid diagnostic query" });
    assert.equal(recorder.available, true);
    await recorder.close();
    recorder = new DiagnosticRecorder({ path });
    await until(() => recorder.available);
    const detail = await recorder.detail(scope, pending.operationId);
    assert.equal(detail?.operation.outcome, "unknown");
    assert.equal(detail?.operation.finishedAt, undefined);
    assert.equal(detail?.events.at(-1)?.stage, "observer_lost");
    assert.equal(await recorder.detail({ ...scope, participantIdentityId: "agent-other" }, stopped.operationId), undefined);
  } finally { await recorder.close(); await rm(directory, { recursive: true, force: true }); }
});
