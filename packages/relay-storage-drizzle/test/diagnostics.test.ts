import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { diagnosticRecord, type DiagnosticRecord } from "@minu/channels-relay";
import { DiagnosticJournal } from "../src/diagnostics.ts";

const scope = { workspaceId: "workspace-a", conversationId: "conversation-a", participantIdentityId: "agent-a" };
const now = new Date().toISOString();
function record(id = "operation-a", extra: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
  return { ...scope, operationId: id, recorderEpoch: "epoch-a", action: "stop", outcome: "pending", requestDisposition: "accepted",
    requestedAt: now, acceptedAt: now, observedAt: now, elapsedMs: 0, revision: 1, lastSequence: 1,
    eventsDropped: 0, recordingGap: false,
    events: [{ sequence: 1, stage: "accepted", result: "confirmed", source: "agent_host", observedAt: now, elapsedMs: 0 }], ...extra };
}
const terminal = (id: string, extra: Partial<DiagnosticRecord> = {}) => record(id, { outcome: "succeeded", finishedAt: now, closedAt: now, ...extra });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "channels-diagnostic-journal-"));
  const path = join(directory, "agent-diagnostics.db");
  const journal = await DiagnosticJournal.open(path, "epoch-a", now);
  return { directory, path, journal, async close(clean = true) { try { await journal.close(clean); } finally { await rm(directory, { recursive: true, force: true }); } } };
}

test("bulk totals and target results are allowlisted, immutable in scope, and monotonic", async () => {
  const f = await fixture();
  try {
    const counts = { targets: 3, completed: 1, started: 0, stopped: 0, skipped: 1, failed: 0, unknown: 1, childrenUnrecorded: 0 };
    const parent = record("bulk-parent", { action: "bulk_start", participantIdentityId: "human-a", bulk: counts });
    assert.equal(await f.journal.put(parent), true);
    assert.equal(await f.journal.put({ ...parent, revision: 2, bulk: { ...counts, targets: 4 } }), false);
    assert.equal(await f.journal.put({ ...parent, revision: 2, bulk: { ...counts, completed: 0, skipped: 0, unknown: 0 } }), false);
    assert.equal(await f.journal.put({ ...parent, revision: 2, bulk: { ...counts, completed: 2, started: 1 } }), true);
    const child = terminal("bulk-child", { action: "start", parentOperationId: parent.operationId,
      bulkTarget: { outcome: "skipped", reason: "already_idle" } });
    assert.equal(await f.journal.put(child), true);
    assert.equal(await f.journal.put({ ...child, revision: 2, bulkTarget: { outcome: "started" } }), false);
    const hostile = { ...parent, bulk: { ...counts, rawError: "PRIVATE_CANARY", childrenUnavailable: 99 },
      bulkTarget: undefined };
    const clean = diagnosticRecord(hostile);
    assert.ok(!JSON.stringify(clean).includes("PRIVATE_CANARY"));
    assert.equal(clean.bulk?.childrenUnavailable, undefined);
    for (const invalid of [
      { ...parent, bulk: { ...counts, completed: 4 } },
      { ...parent, bulk: { ...counts, unknown: -1 } },
      { ...parent, bulk: { ...counts, childrenUnrecorded: 2 } },
      { ...parent, action: "start" },
      { ...child, parentOperationId: undefined },
      { ...child, bulkTarget: { outcome: "skipped", reason: "PRIVATE_CANARY" } },
      { ...child, bulkTarget: { outcome: "stopped" } },
    ]) assert.throws(() => diagnosticRecord(invalid), /Invalid diagnostic/);
    assert.equal(await f.journal.put({ ...child, operationId: "duplicate-target-child" }), true);
    const detail = await f.journal.detail({ ...scope, participantIdentityId: "human-a" }, parent.operationId);
    assert.equal(detail?.operation.bulk?.completed, 2);
    assert.equal(detail?.operation.bulk?.childrenUnavailable, 1);
    assert.equal((await f.journal.history({ ...scope, participantIdentityId: "human-a" })).operations[0]?.bulk?.childrenUnavailable, 1);
    await f.journal.close(false);
    const reopened = await DiagnosticJournal.open(f.path, "epoch-b", now);
    try {
      const lost = await reopened.detail({ ...scope, participantIdentityId: "human-a" }, parent.operationId);
      assert.equal(lost?.operation.outcome, "unknown"); assert.equal(lost?.operation.finishedAt, undefined);
      assert.equal(lost?.operation.bulk?.completed, 2); assert.equal(lost?.operation.bulk?.targets, 3);
      assert.equal(lost?.events.at(-1)?.stage, "observer_lost");
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("bulk parent totals survive child expiry and pruning never cascades into pending children", async () => {
  const f = await fixture();
  try {
    const old = new Date(Date.parse(now) - 8 * 86_400_000).toISOString();
    const parentScope = { ...scope, participantIdentityId: "human-a" };
    const parent = record("retained-parent", { ...parentScope, action: "bulk_start", outcome: "unknown", closedAt: now,
      bulk: { targets: 2, completed: 1, started: 1, stopped: 0, skipped: 0, failed: 0, unknown: 0, childrenUnrecorded: 0 } });
    assert.equal(await f.journal.put(terminal("expired-child", { action: "start", parentOperationId: parent.operationId,
      observedAt: old, closedAt: old, finishedAt: old, bulkTarget: { outcome: "started" } })), true);
    assert.equal(await f.journal.put(record("pending-child", { action: "start", parentOperationId: parent.operationId })), true);
    // A different Workspace cannot supply a retained child to hide missing coverage.
    assert.equal(await f.journal.put(terminal("wrong-scope-child", { workspaceId: "workspace-other", action: "start", parentOperationId: parent.operationId, bulkTarget: { outcome: "started" } })), true);
    assert.equal(await f.journal.put(parent), true);
    const detail = await f.journal.detail(parentScope, parent.operationId, now);
    assert.equal(detail?.operation.bulk?.started, 1);
    assert.equal(detail?.operation.bulk?.childrenUnavailable, 1);
    const future = new Date(Date.parse(now) + 8 * 86_400_000).toISOString();
    await f.journal.prune(future);
    assert.equal(await f.journal.detail(parentScope, parent.operationId, future), undefined);
    assert.ok(await f.journal.detail(scope, "pending-child", future), "no parent/child foreign-key cascade");
  } finally { await f.close(); }
});

test("diagnostic journal accepts only bounded absolute local paths", async () => {
  for (const path of ["https://example.turso.io", "file:./relay.db", "../relay.db", `/tmp/${"x".repeat(4096)}`]) {
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"), /absolute local path/);
  }
});

test("diagnostic schema is independent, private, scoped, revision-fenced, and allowlist projected", async () => {
  const f = await fixture();
  try {
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    const secret = "private-path-and-credential-canary";
    const input = { ...record(), rawError: secret, runtimeSessionId: secret,
      events: [{ ...record().events[0]!, rawOutput: secret }] };
    assert.equal(await f.journal.put(input), true);
    const updated = record("operation-a", { revision: 2, lastSequence: 2, elapsedMs: 2,
      events: [...record().events, { sequence: 2, stage: "pause_committed", result: "confirmed", source: "agent_host", observedAt: now, elapsedMs: 2 }] });
    assert.equal(await f.journal.put(updated), true);
    assert.equal(await f.journal.put(record()), false);
    assert.equal(await f.journal.put({ ...updated, events: [] }), false);
    assert.equal(await f.journal.put({ ...updated, revision: 3, workspaceId: "workspace-other" }), false);
    assert.equal(await f.journal.put({ ...updated, revision: 3, action: "start" }), false);
    assert.equal(await f.journal.put({ ...updated, revision: 3, outcome: "succeeded", finishedAt: now, closedAt: now }), true);
    assert.equal(await f.journal.put({ ...updated, revision: 4 }), false, "terminal records cannot become pending again");
    const history = await f.journal.history(scope);
    const detail = await f.journal.detail(scope, "operation-a");
    assert.equal(history.operations.length, 1);
    assert.equal(detail?.events.length, 2);
    assert.equal(detail?.operation.outcome, "succeeded");
    const serialized = JSON.stringify({ history, detail });
    for (const forbidden of [secret, "workspaceId", "recorderEpoch", "revision", "lastSequence", "rawOutput", "runtimeSessionId"]) assert.ok(!serialized.includes(forbidden));
    assert.equal((await f.journal.history({ ...scope, workspaceId: "workspace-other" })).operations.length, 0);
    assert.equal(await f.journal.detail({ ...scope, conversationId: "conversation-other" }, "operation-a"), undefined);
    assert.equal(await f.journal.detail({ ...scope, participantIdentityId: "agent-other" }, "operation-a"), undefined);
    const bytes = await readFile(f.path);
    assert.ok(!bytes.includes(Buffer.from(secret)));
  } finally { await f.close(); }
});

test("private correlations match exact generation/trigger/scope and cannot be reassigned", async () => {
  const f = await fixture();
  try {
    const correlations = { sourceBinding: { id: "private-binding", generation: 2 },
      targetBinding: { id: "private-target", generation: 3 },
      trigger: { messageId: "message-a", sequence: 42 }, cleanupHistoryId: "private-history" };
    await f.journal.put(record("operation-a", { correlations }));
    const ref = { bindingId: "private-binding", generation: 2, triggerMessageId: "message-a", triggerSequence: 42 };
    assert.deepEqual(await f.journal.correlated(scope, ref), ["operation-a"]);
    for (const wrong of [{ generation: 3 }, { triggerMessageId: "message-b" }, { triggerSequence: 43 }, { bindingId: "private-target" }]) {
      assert.deepEqual(await f.journal.correlated(scope, { ...ref, ...wrong }), []);
    }
    assert.deepEqual(await f.journal.correlated({ ...scope, workspaceId: "workspace-b" }, ref), []);
    assert.equal(await f.journal.put(record("operation-a", { revision: 2, correlations: { ...correlations, sourceBinding: { id: "private-binding", generation: 3 } } })), false);
    assert.equal(await f.journal.put(record("operation-a", { revision: 2 })), false);
    const response = JSON.stringify({ history: await f.journal.history(scope), detail: await f.journal.detail(scope, "operation-a") });
    assert.ok(!response.includes("private-binding")); assert.ok(!response.includes("private-target")); assert.ok(!response.includes("private-history"));
    assert.equal((await f.journal.detail(scope, "operation-a"))?.operation.triggerSequence, 42);
    assert.equal((await f.journal.history(scope)).operations[0]?.triggerSequence, 42);
  } finally { await f.close(); }
});

test("recorder epochs turn pending evidence into unknown without inventing a finish time or accepting old writers", async () => {
  const f = await fixture();
  let next: DiagnosticJournal | undefined;
  try {
    await f.journal.put(record());
    next = await DiagnosticJournal.open(f.path, "epoch-b", now);
    assert.equal(next.recordingGap, true);
    assert.equal(await f.journal.put(record("operation-old-late")), false);
    const detail = await next.detail(scope, "operation-a");
    assert.equal(detail?.operation.outcome, "unknown");
    assert.equal(detail?.operation.finishedAt, undefined);
    assert.equal(detail?.operation.closedAt, now);
    assert.equal(detail?.operation.recordingGap, true);
    assert.equal(detail?.events.at(-1)?.stage, "observer_lost");
    assert.equal(await next.put(record("operation-b", { recorderEpoch: "epoch-b" })), true);
    assert.equal(await next.put(record("operation-a", { recorderEpoch: "epoch-b", revision: 100 })), false);
  } finally { await next?.close(); await f.close(); }
});

test("stable ordinal cursors neither repeat nor include newer insertions, despite progress updates", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 56; i++) await f.journal.put(record(`operation-${i}`));
    const first = await f.journal.history(scope);
    assert.equal(first.operations.length, 50);
    assert.ok(first.nextCursor);
    await f.journal.put(record("operation-new"));
    await f.journal.put(record("operation-0", { revision: 2, elapsedMs: 3 }));
    const second = await f.journal.history(scope, first.nextCursor);
    assert.equal(second.operations.length, 6);
    assert.equal(second.nextCursor, undefined);
    const ids = [...first.operations, ...second.operations].map((operation) => operation.operationId);
    assert.equal(new Set(ids).size, 56);
    assert.ok(!ids.includes("operation-new"));
    assert.equal(second.operations.at(-1)?.elapsedMs, 3);
    for (const cursor of ["../private", "9999999999999999:1", "0:1", "1:3", "-1:0"]) await assert.rejects(f.journal.history(scope, cursor), /Invalid diagnostic cursor/);
    assert.equal((await f.journal.history(scope)).operations[0]?.operationId, "operation-new");
  } finally { await f.close(); }
});

test("retention caps terminal history globally, protects pending operations, and hides expired evidence immediately", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const old = new Date(Date.parse(now) - 8 * 86_400_000).toISOString();
    await f.journal.put(record("operation-pending-old", { requestedAt: old, acceptedAt: old, observedAt: old }));
    for (let i = 0; i < 1003; i++) await f.journal.put(terminal(`operation-terminal-${i}`, { participantIdentityId: i % 2 ? "agent-b" : "agent-a" }));
    const client = createClient({ url: `file:${f.path}` });
    try {
      const rows = await client.execute("SELECT outcome,count(*) AS count FROM operations GROUP BY outcome");
      assert.deepEqual(rows.rows.map((row) => [row.outcome, Number(row.count)]).sort(), [["pending", 1], ["succeeded", 1000]]);
    } finally { client.close(); }
    assert.ok(await f.journal.detail(scope, "operation-pending-old"));
    assert.equal(await f.journal.detail(scope, "operation-terminal-0"), undefined);
    const later = new Date(Date.parse(now) + 8 * 86_400_000).toISOString();
    const history = await f.journal.history(scope, undefined, later);
    assert.deepEqual(history.operations.map((operation) => operation.operationId), ["operation-pending-old"]);
    assert.equal(await f.journal.detail(scope, "operation-terminal-1002", later), undefined);
  } finally { await f.close(); }
});

test("active/event capacities and unsafe record values are bounded without modifying existing rows", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 128; i++) assert.equal(await f.journal.put(record(`operation-${i}`)), true);
    assert.equal(await f.journal.put(record("operation-overflow")), false);
    const excessive = record("operation-0", { revision: 2, events: Array.from({ length: 129 }, (_, i) => ({ ...record().events[0]!, sequence: i + 1 })), lastSequence: 129 });
    await assert.rejects(f.journal.put(excessive), /coverage/);
    for (const invalid of [
      { action: "raw error secret" }, { workspaceId: "/private/home" }, { observedAt: "secret" },
      { elapsedMs: Infinity }, { eventsDropped: -1 }, { outcome: "unknown", closedAt: now, finishedAt: now },
    ]) assert.throws(() => diagnosticRecord({ ...record(), ...invalid }));
    assert.equal((await f.journal.detail(scope, "operation-0"))?.events.length, 1);
  } finally { await f.close(); }
});

test("journal contention does not acquire or modify Relay authority locks", async () => {
  const f = await fixture();
  const relay = createClient({ url: `file:${join(f.directory, "relay.db")}` });
  const locker = createClient({ url: `file:${f.path}` });
  try {
    await relay.execute("CREATE TABLE authority(value INTEGER NOT NULL)");
    await relay.execute("INSERT INTO authority VALUES(41)");
    await relay.execute("BEGIN IMMEDIATE");
    assert.equal(await f.journal.put(record()), true, "Relay write lock cannot block a separate journal");
    await relay.execute("COMMIT");
    await locker.execute("BEGIN IMMEDIATE");
    await assert.rejects(f.journal.put(record("operation-locked")));
    await relay.execute("UPDATE authority SET value=42");
    assert.equal((await relay.execute("SELECT value FROM authority")).rows[0]?.value, 42);
    await locker.execute("ROLLBACK");
  } finally { relay.close(); locker.close(); await f.close(false); }
});

test("independent migration history is recorded and inconsistent ledgers disable the journal", async () => {
  const f = await fixture();
  try {
    await f.journal.close();
    const client = createClient({ url: `file:${f.path}` });
    try {
      assert.equal((await client.execute("PRAGMA user_version")).rows[0]?.user_version, 2);
      const migrations = (await client.execute("SELECT version,applied_at FROM journal_migrations")).rows;
      assert.equal(migrations.length, 2);
      assert.equal(migrations[0]?.version, 1);
      assert.equal(migrations[1]?.version, 2);
      assert.ok(Number.isFinite(Date.parse(String(migrations[0]?.applied_at))));
      await client.execute("UPDATE journal_migrations SET version=99 WHERE version=2");
    } finally { client.close(); }
    await assert.rejects(DiagnosticJournal.open(f.path, "epoch-b"), /Unsupported diagnostic migration history/);
  } finally { await f.close(); }
});

test("an accidental authoritative database path is rejected without migration or persistent PRAGMA changes", async () => {
  const f = await fixture();
  const path = join(f.directory, "relay.db");
  try {
    const authority = createClient({ url: `file:${path}` });
    await authority.execute("CREATE TABLE binding_authority(value INTEGER NOT NULL)");
    await authority.execute("INSERT INTO binding_authority VALUES(42)");
    authority.close();
    await chmod(path, 0o600);
    const before = await readFile(path);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-b"), /Unsupported diagnostic schema/);
    assert.deepEqual(await readFile(path), before);
  } finally { await f.close(); }
});

test("owner-private journal refuses permissive directories, symlinks, hardlinks, corrupt files and unsupported versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "channels-diagnostic-private-"));
  const path = join(directory, "journal.db");
  try {
    await chmod(directory, 0o755);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"), /Unsafe diagnostic directory/);
    await chmod(directory, 0o700);
    const target = join(directory, "authority.db");
    await writeFile(target, "preserve authority", { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"));
    await rm(path);
    await link(target, path);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"), /Unsafe diagnostic file/);
    assert.equal(await readFile(target, "utf8"), "preserve authority");
    await rm(path);
    await writeFile(path, "not a database", { mode: 0o644 });
    await chmod(path, 0o644);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"), /Unsafe diagnostic file/);
    await chmod(path, 0o600);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"));
    await rm(path);
    await writeFile(path, "", { mode: 0o600 });
    await symlink(target, `${path}-wal`);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"));
    assert.equal(await readFile(target, "utf8"), "preserve authority");
    await rm(`${path}-wal`);
    await rm(path);
    const future = createClient({ url: `file:${path}` });
    await future.execute("PRAGMA user_version=99"); future.close();
    await chmod(path, 0o600);
    await assert.rejects(DiagnosticJournal.open(path, "epoch-a"), /Unsupported diagnostic schema/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
