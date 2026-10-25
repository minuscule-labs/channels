import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { deliveryRecord, type DeliveryRecord, type DiagnosticRecord } from "@minu/channels-relay";
import { DiagnosticJournal } from "../src/diagnostics.ts";
const scope = { workspaceId: "workspace", conversationId: "conversation", participantIdentityId: "agent", bindingId: "PRIVATE_BINDING", generation: 1, adapter: "pi", sessionId: "PRIVATE_SESSION", ownerId: "PRIVATE_OWNER" };
const now = new Date().toISOString();
function record(id: string, patch: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return { ...scope, trailId: id, triggerId: "PRIVATE_TRIGGER", triggerSequence: 1, epoch: "epoch-a", revision: 1, lastSequence: 1,
    startedAt: now, observedAt: now, closedAt: now, outcome: "delivered", eventsDropped: 0, recordingGap: false,
    events: [{ sequence: 1, stage: "response_committed", observedAt: now, elapsedMs: 0 }], ...patch };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "delivery-journal-")), path = join(dir, "diagnostics.db");
  const journal = await DiagnosticJournal.open(path, "epoch-a", now);
  return { path, journal, async close() { await journal.close(); await rm(dir, { recursive: true, force: true }); } };
}
test("trail parsers reconstruct fixed fields and reject hostile or oversized snapshots", () => {
  const projected = deliveryRecord({ ...record("trail"), prompt: "SECRET", events: [{ ...record("trail").events[0], error: "SECRET", toolOutput: "SECRET" }] });
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|prompt|toolOutput/);
  for (const patch of [{ triggerSequence: -1 }, { epoch: "/private/path" }, { outcome: "secret" }, { closedAt: undefined }, { events: Array(17).fill(record("trail").events[0]) }, { events: [{ ...record("trail").events[0], stage: "SECRET" }] }]) {
    assert.throws(() => deliveryRecord({ ...record("trail"), ...patch }));
  }
});
test("exact trail scope, immutable correlation, revisions and public projection survive reopen", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.journal.delivery.put(record("trail", { outcome: "pending", closedAt: undefined })), true);
    assert.equal(await f.journal.delivery.put(record("trail", { generation: 2, revision: 2 })), false);
    assert.equal(await f.journal.delivery.put(record("trail", { triggerId: "foreign", revision: 2 })), false);
    assert.equal(await f.journal.delivery.put(record("trail", { revision: 2 })), true);
    assert.equal(await f.journal.delivery.put(record("trail", { revision: 3 })), false, "terminal observation cannot be rewritten");
    for (const key of Object.keys(scope)) {
      assert.equal(await f.journal.delivery.detail({ ...scope, [key]: key === "generation" ? 2 : "foreign" }, "trail"), undefined, key);
    }
    const history = await f.journal.delivery.history(scope);
    assert.equal(history.trails.length, 1); assert.doesNotMatch(JSON.stringify(history), /PRIVATE|epoch|bindingId|sessionId/);
    await f.journal.close();
    const next = await DiagnosticJournal.open(f.path, "epoch-b", now);
    try { assert.equal((await next.delivery.detail(scope, "trail"))?.outcome, "delivered"); assert.equal(await next.delivery.put(record("stale")), false); }
    finally { await next.close(); }
  } finally { await f.close(); }
});
test("trail and lifecycle retention pools cannot evict one another, and expired rows are hidden before pruning", async () => {
  const f = await fixture();
  try {
    const lifecycle: DiagnosticRecord = { workspaceId: scope.workspaceId, conversationId: scope.conversationId, participantIdentityId: scope.participantIdentityId,
      operationId: "operation", recorderEpoch: "epoch-a", revision: 1, lastSequence: 1, action: "stop", requestedAt: now, acceptedAt: now, observedAt: now,
      outcome: "succeeded", requestDisposition: "not_applicable", closedAt: now, finishedAt: now, elapsedMs: 0, eventsDropped: 0, recordingGap: false,
      events: [{ sequence: 1, stage: "completed", result: "confirmed", source: "agent_host", observedAt: now, elapsedMs: 0 }] };
    for (let i = 0; i < 1005; i++) await f.journal.delivery.put(record(`trail_${i}`));
    for (let i = 0; i < 1005; i++) await f.journal.put({ ...lifecycle, operationId: `operation_${i}` });
    const db = createClient({ url: `file:${f.path}` });
    try {
      assert.equal((await db.execute("SELECT count(*) AS count FROM delivery_trails")).rows[0]?.count, 1000);
      assert.equal((await db.execute("SELECT count(*) AS count FROM operations")).rows[0]?.count, 1000);
    } finally { db.close(); }
    const first = await f.journal.delivery.history(scope); assert.equal(first.trails.length, 50); assert.ok(first.nextCursor);
    await f.journal.delivery.put(record("inserted_later"));
    const second = await f.journal.delivery.history(scope, first.nextCursor); assert.equal(second.trails.length, 50);
    assert.ok(!second.trails.some(trail => trail.trailId === "inserted_later"));
    const expiredTime = new Date(Date.parse(now) + 8 * 86400000).toISOString();
    assert.equal((await f.journal.delivery.history(scope, undefined, expiredTime)).trails.length, 0);
    assert.equal(await f.journal.delivery.detail(scope, "inserted_later", expiredTime), undefined);
    await f.journal.delivery.prune(expiredTime);
    assert.equal((await f.journal.history(scope, undefined, now)).operations.length, 50, "trail expiry cannot prune lifecycle history");
  } finally { await f.close(); }
});
test("pending capture is capped and restart closes observers as unknown without recovery calls", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1000; i++) await f.journal.delivery.put(record(`completed_${i}`));
    for (let i = 0; i < 128; i++) assert.equal(await f.journal.delivery.put(record(`pending_${i}`, { outcome: "pending", closedAt: undefined })), true);
    assert.equal(await f.journal.delivery.put(record("overflow", { outcome: "pending", closedAt: undefined })), false);
    await f.journal.close(false);
    const next = await DiagnosticJournal.open(f.path, "epoch-b", now);
    try {
      const value = await next.delivery.detail(scope, "pending_127"); assert.equal(value?.outcome, "unknown"); assert.equal(value?.events.at(-1)?.stage, "observer_lost"); assert.equal(next.delivery.recordingGap, true);
      const db = createClient({ url: `file:${f.path}` });
      try { assert.equal((await db.execute("SELECT count(*) AS count FROM delivery_trails WHERE outcome<>'pending'")).rows[0]?.count, 1000, "restart reconciliation must not exceed the completed cap"); }
      finally { db.close(); }
    }
    finally { await next.close(); }
  } finally { await f.close(); }
});
test("version-one companion journal upgrades independently without losing lifecycle observations", async () => {
  const f = await fixture();
  try {
    await f.journal.put({ workspaceId: scope.workspaceId, conversationId: scope.conversationId, participantIdentityId: scope.participantIdentityId,
      operationId: "retained_stop", recorderEpoch: "epoch-a", action: "stop", revision: 1, lastSequence: 1,
      requestedAt: now, acceptedAt: now, observedAt: now, closedAt: now, finishedAt: now, elapsedMs: 0,
      outcome: "succeeded", requestDisposition: "not_applicable", recordingGap: false, eventsDropped: 0,
      events: [{ sequence: 1, stage: "completed", source: "agent_host", result: "confirmed", observedAt: now, elapsedMs: 0 }] });
    await f.journal.close();
    const db = createClient({ url: `file:${f.path}` });
    await db.execute("DROP TABLE delivery_trails"); await db.execute("ALTER TABLE journal_meta DROP COLUMN delivery_gap");
    await db.execute("DELETE FROM journal_migrations WHERE version=2"); await db.execute("PRAGMA user_version=1"); db.close();
    const next = await DiagnosticJournal.open(f.path, "epoch-b", now);
    try { assert.deepEqual((await next.delivery.history(scope)).trails, []); assert.equal((await next.history(scope)).operations[0]?.operationId, "retained_stop"); assert.equal((await next.detail(scope, "retained_stop"))?.operation.outcome, "succeeded"); }
    finally { await next.close(); }
  } finally { await f.close(); }
});
