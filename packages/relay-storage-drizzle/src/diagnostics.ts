import { createClient, type Client, type InStatement } from "@libsql/client";
import { DIAGNOSTIC_LIMITS, diagnosticRecord, diagnosticSummary, type DiagnosticRecord, type DiagnosticScope, type DiagnosticHistory, type DiagnosticDetail, type DiagnosticTurnReference } from "@minu/channels-relay";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DeliveryJournal, DELIVERY_SCHEMA } from "./delivery-diagnostics.ts";

// Independent versioned schema. Never migrate or open relay.db through this store.
const VERSION_ONE = [
  "CREATE TABLE journal_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  "CREATE TABLE epochs (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, closed_at TEXT, closure TEXT)",
  "CREATE TABLE journal_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL, clean INTEGER NOT NULL, gap INTEGER NOT NULL DEFAULT 0)",
  `CREATE TABLE operations (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    epoch TEXT NOT NULL, revision INTEGER NOT NULL, write_nonce TEXT NOT NULL, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    participant_id TEXT NOT NULL, parent_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, closed_at TEXT, snapshot TEXT NOT NULL)`,
  "CREATE INDEX operation_scope ON operations(workspace_id,conversation_id,participant_id,ordinal)",
  "CREATE INDEX operation_parent ON operations(parent_id,ordinal)",
  "CREATE INDEX operation_retention ON operations(outcome,closed_at,ordinal)",
  "CREATE INDEX operation_epoch ON operations(epoch,outcome)",
  `CREATE TABLE correlations (operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
    source_binding_id TEXT, source_generation INTEGER, target_binding_id TEXT, target_generation INTEGER,
    trigger_message_id TEXT, trigger_sequence INTEGER, cleanup_history_id TEXT)`,
  "CREATE INDEX correlation_source ON correlations(source_binding_id,source_generation,trigger_message_id,trigger_sequence)",
  "CREATE INDEX correlation_target ON correlations(target_binding_id,target_generation)",
  "CREATE INDEX correlation_cleanup ON correlations(cleanup_history_id)",
  `CREATE TABLE events (operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(operation_id,sequence))`,
  "INSERT INTO journal_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  "PRAGMA user_version=1",
];

async function privateFile(path: string, create: boolean) {
  if (!process.getuid || !constants.O_NOFOLLOW) throw new Error("Owner-private diagnostic storage unavailable");
  let handle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe diagnostic file");
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  } finally { await handle?.close(); }
}

export class DiagnosticQueryError extends Error {
  constructor() { super("Invalid diagnostic cursor"); }
}

export class DiagnosticJournal {
  private gap: boolean;
  get recordingGap() { return this.gap; }
  readonly delivery: DeliveryJournal;
  private constructor(private client: Client, readonly epoch: string, gap: boolean, deliveryGap: boolean) {
    this.gap = gap;
    this.delivery = new DeliveryJournal(client, epoch, deliveryGap);
  }

  static async open(path: string, epoch: string, now = new Date().toISOString()): Promise<DiagnosticJournal> {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0")) throw new Error("Diagnostic journal requires an absolute local path");
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(epoch)) throw new Error("Invalid recorder epoch");
    path = resolve(path);
    const directory = dirname(path);
    const stat = await lstat(directory);
    if (!process.getuid || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe diagnostic directory");
    // Canonicalize OS aliases such as macOS /var -> /private/var. The private
    // containing directory and the database itself must not be symlinks.
    path = resolve(await realpath(directory), basename(path));
    await privateFile(path, true);
    for (const suffix of ["-wal", "-shm", "-journal"]) await privateFile(`${path}${suffix}`, false);
    const client = createClient({ url: pathToFileURL(path).href });
    try {
      await client.execute("PRAGMA busy_timeout=0");
      await client.execute("PRAGMA foreign_keys=ON");
      const version = Number((await client.execute("PRAGMA user_version")).rows[0]?.user_version);
      const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")).rows.map((row) => String(row.name));
      if ((version === 0 && tables.length !== 0)
        || (version === 1 && tables.join(",") !== "correlations,epochs,events,journal_meta,journal_migrations,operations")
        || (version === 2 && tables.join(",") !== "correlations,delivery_trails,epochs,events,journal_meta,journal_migrations,operations")
        || ![0, 1, 2].includes(version)) throw new Error("Unsupported diagnostic schema");
      // Refuse existing non-journal databases before any persistent PRAGMA or DDL.
      await client.execute("PRAGMA journal_mode=WAL");
      if (version === 0) await client.batch(VERSION_ONE, "write");
      const migrations = (await client.execute("SELECT version FROM journal_migrations ORDER BY version")).rows;
      if (migrations.length !== (version === 2 ? 2 : 1) || migrations[0]?.version !== 1
        || (version === 2 && migrations[1]?.version !== 2)) throw new Error("Unsupported diagnostic migration history");
      if (version < 2) await client.batch(DELIVERY_SCHEMA, "write");
      await client.batch([
        { sql: "UPDATE epochs SET closed_at=?,closure='observer_lost' WHERE closed_at IS NULL", args: [now] },
        { sql: "INSERT INTO epochs(epoch,started_at) VALUES(?,?)", args: [epoch, now] },
        { sql: `INSERT INTO journal_meta(singleton,epoch,clean,gap) VALUES(1,?,0,0)
          ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,clean=0,
          gap=CASE WHEN journal_meta.clean=0 OR journal_meta.gap=1 THEN 1 ELSE 0 END,
          delivery_gap=CASE WHEN journal_meta.clean=0 OR journal_meta.delivery_gap=1 THEN 1 ELSE 0 END`, args: [epoch] },
      ], "write");
      const metadata = (await client.execute("SELECT epoch,gap,delivery_gap FROM journal_meta WHERE singleton=1")).rows[0];
      if (metadata?.epoch !== epoch) throw new Error("Diagnostic epoch superseded");
      const journal = new DiagnosticJournal(client, epoch, metadata.gap === 1, metadata.delivery_gap === 1);
      await journal.delivery.recover(now);
      // Fence older writers before reconciling. This is observation loss, not lifecycle recovery.
      const pending = await client.execute("SELECT id FROM operations WHERE outcome='pending' LIMIT 129");
      if (pending.rows.length > DIAGNOSTIC_LIMITS.tracked) throw new Error("Diagnostic active capacity exceeded");
      for (const row of pending.rows) {
        const record = await journal.load(String(row.id));
        if (!record || record.recorderEpoch === epoch) continue;
        record.outcome = "unknown";
        record.closedAt = now;
        record.observedAt = now;
        record.recordingGap = true;
        record.revision++;
        record.lastSequence++;
        if (record.events.length >= DIAGNOSTIC_LIMITS.events) { record.events.pop(); record.eventsDropped++; }
        record.events.push({ sequence: record.lastSequence, observedAt: now, elapsedMs: record.elapsedMs,
          source: "agent_host", stage: "observer_lost", result: "unknown", reasonCode: "observer_lost" });
        await journal.persist(record, true);
      }
      await journal.prune(now);
      for (const suffix of ["-wal", "-shm", "-journal"]) await privateFile(`${path}${suffix}`, false);
      return journal;
    } catch (error) { client.close(); throw error; }
  }

  async put(input: unknown): Promise<boolean> {
    return this.persist(diagnosticRecord(input));
  }

  private async persist(record: DiagnosticRecord, recovery = false): Promise<boolean> {
    record = diagnosticRecord(record);
    const encoded = JSON.stringify({ ...record, events: [] });
    if (Buffer.byteLength(JSON.stringify(record)) > DIAGNOSTIC_LIMITS.snapshotBytes) throw new Error("Diagnostic snapshot too large");
    if (!recovery && record.recorderEpoch !== this.epoch) return false;
    const pending = await this.client.execute({ sql: "SELECT count(*) AS count FROM operations WHERE outcome='pending' AND id<>?", args: [record.operationId] });
    if (record.outcome === "pending" && Number(pending.rows[0]?.count) >= DIAGNOSTIC_LIMITS.tracked) return false;
    const nonce = randomUUID();
    const correlation = record.correlations;
    const privateArgs = [correlation?.sourceBinding?.id ?? null, correlation?.sourceBinding?.generation ?? null,
      correlation?.targetBinding?.id ?? null, correlation?.targetBinding?.generation ?? null,
      correlation?.trigger?.messageId ?? null, correlation?.trigger?.sequence ?? null, correlation?.cleanupHistoryId ?? null];
    const args = [record.operationId, record.recorderEpoch, record.revision, nonce, record.workspaceId, record.conversationId,
      record.participantIdentityId, record.parentOperationId ?? null, record.action, record.outcome, record.closedAt ?? null, encoded, this.epoch, ...privateArgs];
    const statements: InStatement[] = [{
      sql: `INSERT INTO operations(id,epoch,revision,write_nonce,workspace_id,conversation_id,participant_id,parent_id,action,outcome,closed_at,snapshot)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT epoch FROM journal_meta WHERE singleton=1)=?
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,write_nonce=excluded.write_nonce,outcome=excluded.outcome,closed_at=excluded.closed_at,snapshot=excluded.snapshot
        WHERE operations.epoch=excluded.epoch AND operations.revision<excluded.revision
        AND operations.workspace_id=excluded.workspace_id AND operations.conversation_id=excluded.conversation_id
        AND operations.participant_id=excluded.participant_id AND operations.parent_id IS excluded.parent_id
        AND operations.action=excluded.action
        AND (json_extract(operations.snapshot,'$.bulk.targets') IS NULL OR
          (json_extract(operations.snapshot,'$.bulk.targets')=json_extract(excluded.snapshot,'$.bulk.targets')
            ${["completed", "started", "stopped", "skipped", "failed", "unknown", "childrenUnrecorded"].map((key) => `AND json_extract(operations.snapshot,'$.bulk.${key}')<=json_extract(excluded.snapshot,'$.bulk.${key}')`).join(" ")}))
        AND (json_extract(operations.snapshot,'$.bulkTarget') IS NULL OR json_extract(operations.snapshot,'$.bulkTarget') IS json_extract(excluded.snapshot,'$.bulkTarget'))
        AND (operations.outcome='pending' OR (operations.outcome=excluded.outcome AND operations.closed_at IS excluded.closed_at))
        AND NOT EXISTS(SELECT 1 FROM correlations c WHERE c.operation_id=operations.id AND (
          (c.source_binding_id IS NOT NULL AND (c.source_binding_id IS NOT ? OR c.source_generation IS NOT ?)) OR
          (c.target_binding_id IS NOT NULL AND (c.target_binding_id IS NOT ? OR c.target_generation IS NOT ?)) OR
          (c.trigger_message_id IS NOT NULL AND (c.trigger_message_id IS NOT ? OR c.trigger_sequence IS NOT ?)) OR
          (c.cleanup_history_id IS NOT NULL AND c.cleanup_history_id IS NOT ?)))`, args,
    }];
    const valid = `EXISTS(SELECT 1 FROM operations WHERE id=? AND epoch=? AND write_nonce=?
      AND (SELECT epoch FROM journal_meta WHERE singleton=1)=?)`;
    const gate = [record.operationId, record.recorderEpoch, nonce, this.epoch];
    statements.push({ sql: `DELETE FROM events WHERE operation_id=? AND ${valid}`, args: [record.operationId, ...gate] });
    for (const event of record.events) statements.push({
      sql: `INSERT INTO events(operation_id,sequence,payload) SELECT ?,?,? WHERE ${valid}`,
      args: [record.operationId, event.sequence, JSON.stringify(event), ...gate],
    });
    statements.push({ sql: `DELETE FROM correlations WHERE operation_id=? AND ${valid}`, args: [record.operationId, ...gate] });
    if (correlation) statements.push({
      sql: `INSERT INTO correlations(operation_id,source_binding_id,source_generation,target_binding_id,target_generation,trigger_message_id,trigger_sequence,cleanup_history_id)
        SELECT ?,?,?,?,?,?,?,? WHERE ${valid}`,
      args: [record.operationId, ...privateArgs, ...gate],
    });
    // Duplicate snapshots must not rewrite events after a stale upsert. Only a newer revision wins.
    const existing = (await this.client.execute({ sql: "SELECT revision,epoch FROM operations WHERE id=?", args: [record.operationId] })).rows[0];
    if (existing && (existing.epoch !== record.recorderEpoch || Number(existing.revision) >= record.revision)) return false;
    const result = await this.client.batch(statements, "write");
    if (result[0]?.rowsAffected) { await this.prune(record.observedAt); return true; }
    return false;
  }

  private async load(id: string): Promise<DiagnosticRecord | undefined> {
    const row = (await this.client.execute({ sql: "SELECT snapshot FROM operations WHERE id=?", args: [id] })).rows[0];
    if (!row) return undefined;
    const events = (await this.client.execute({ sql: "SELECT payload FROM events WHERE operation_id=? ORDER BY sequence", args: [id] })).rows.map((event) => JSON.parse(String(event.payload)));
    return diagnosticRecord({ ...JSON.parse(String(row.snapshot)), events });
  }

  private async summary(record: DiagnosticRecord, cutoff: string) {
    const summary = diagnosticSummary(record);
    // IDs are not capabilities: only publish retained, exact-scope relations.
    if (summary.parentOperationId) {
      const parent = (await this.client.execute({
        sql: `SELECT id FROM operations WHERE id=? AND workspace_id=? AND conversation_id=?
          AND json_extract(snapshot,'$.action')=? AND (outcome='pending' OR closed_at>?)`,
        args: [summary.parentOperationId, record.workspaceId, record.conversationId,
          record.action === "start" || record.action === "resume" ? "bulk_start" : record.action === "stop" ? "bulk_stop" : "", cutoff],
      })).rows[0];
      if (!parent) delete summary.parentOperationId;
    }
    if (summary.relatedOperationId) {
      const related = (await this.client.execute({
        sql: `SELECT id FROM operations WHERE id=? AND workspace_id=? AND conversation_id=? AND participant_id=?
          AND (outcome='pending' OR closed_at>?)`,
        args: [summary.relatedOperationId, record.workspaceId, record.conversationId, record.participantIdentityId, cutoff],
      })).rows[0];
      if (!related) delete summary.relatedOperationId;
    }
    if (summary.bulk) {
      // Counts survive pruning; never infer that a missing child expired or cascade into it.
      const retained = (await this.client.execute({
        sql: `SELECT count(DISTINCT participant_id) AS count FROM operations WHERE parent_id=? AND workspace_id=? AND conversation_id=?
          AND json_extract(snapshot,'$.bulkTarget') IS NOT NULL AND (outcome='pending' OR closed_at>?)`,
        args: [record.operationId, record.workspaceId, record.conversationId, cutoff],
      })).rows[0];
      summary.bulk.childrenUnavailable = Math.max(0, summary.bulk.completed - Number(retained?.count ?? 0));
    }
    return summary;
  }

  async history(scope: DiagnosticScope, cursor?: string, now = new Date().toISOString()): Promise<DiagnosticHistory> {
    const cutoff = new Date(Date.parse(now) - DIAGNOSTIC_LIMITS.days * 86_400_000).toISOString();
    let upper: number, before: number;
    if (cursor !== undefined) {
      if (!/^\d{1,16}:\d{1,16}$/.test(cursor)) throw new DiagnosticQueryError();
      [upper, before] = cursor.split(":").map(Number) as [number, number];
      if (!Number.isSafeInteger(upper) || !Number.isSafeInteger(before) || upper < 1 || before < 1 || before > upper + 1) throw new DiagnosticQueryError();
    } else {
      const max = (await this.client.execute({ sql: "SELECT max(ordinal) AS maximum FROM operations WHERE workspace_id=? AND conversation_id=? AND participant_id=? AND (outcome='pending' OR closed_at>?)", args: [scope.workspaceId, scope.conversationId, scope.participantIdentityId, cutoff] })).rows[0]?.maximum;
      upper = Number(max ?? 0); before = upper + 1;
    }
    const rows = (await this.client.execute({
      sql: "SELECT ordinal,snapshot FROM operations WHERE workspace_id=? AND conversation_id=? AND participant_id=? AND ordinal<=? AND ordinal<? AND (outcome='pending' OR closed_at>?) ORDER BY ordinal DESC LIMIT 51",
      args: [scope.workspaceId, scope.conversationId, scope.participantIdentityId, upper, before, cutoff],
    })).rows;
    const page = rows.slice(0, DIAGNOSTIC_LIMITS.page);
    return {
      operations: await Promise.all(page.map((row) => this.summary(diagnosticRecord(JSON.parse(String(row.snapshot))), cutoff))),
      ...(rows.length > DIAGNOSTIC_LIMITS.page ? { nextCursor: `${upper}:${page.at(-1)!.ordinal}` } : {}),
      coverage: "available", recordingGap: this.recordingGap,
      retention: { days: DIAGNOSTIC_LIMITS.days, terminalLimit: DIAGNOSTIC_LIMITS.terminal, eventLimit: DIAGNOSTIC_LIMITS.events },
    };
  }

  async detail(scope: DiagnosticScope, id: string, now = new Date().toISOString()): Promise<DiagnosticDetail | undefined> {
    const cutoff = new Date(Date.parse(now) - DIAGNOSTIC_LIMITS.days * 86_400_000).toISOString();
    const row = (await this.client.execute({
      sql: `SELECT o.id FROM operations o WHERE o.id=? AND o.workspace_id=? AND o.conversation_id=?
        AND (o.participant_id=? OR (json_extract(o.snapshot,'$.action') IN ('bulk_start','bulk_stop') AND EXISTS(
          SELECT 1 FROM operations child WHERE child.parent_id=o.id AND child.workspace_id=o.workspace_id
          AND child.conversation_id=o.conversation_id AND child.participant_id=?
          AND ((json_extract(o.snapshot,'$.action')='bulk_start' AND json_extract(child.snapshot,'$.action') IN ('start','resume'))
            OR (json_extract(o.snapshot,'$.action')='bulk_stop' AND json_extract(child.snapshot,'$.action')='stop'))
          AND (child.outcome='pending' OR child.closed_at>?)))) AND (o.outcome='pending' OR o.closed_at>?)`,
      args: [id, scope.workspaceId, scope.conversationId, scope.participantIdentityId, scope.participantIdentityId, cutoff, cutoff],
    })).rows[0];
    if (!row) return undefined;
    const record = await this.load(id);
    return record && { operation: await this.summary(record, cutoff), events: record.events, recordingGap: this.recordingGap };
  }

  /** Internal exact-turn lookup. Callers must authorize the scope; never match by time/session alone. */
  async correlated(scope: DiagnosticScope, reference: DiagnosticTurnReference, now = new Date().toISOString()): Promise<string[]> {
    if (![reference.bindingId, reference.triggerMessageId].every((id) => /^[a-zA-Z0-9_-]{1,256}$/.test(id))
      || (reference.operationId !== undefined && !/^[a-zA-Z0-9_-]{1,256}$/.test(reference.operationId))
      || !Number.isSafeInteger(reference.generation) || reference.generation < 1
      || !Number.isSafeInteger(reference.triggerSequence) || reference.triggerSequence < 1) throw new DiagnosticQueryError();
    const cutoff = new Date(Date.parse(now) - DIAGNOSTIC_LIMITS.days * 86_400_000).toISOString();
    const rows = (await this.client.execute({
      sql: `SELECT o.id FROM operations o JOIN correlations c ON c.operation_id=o.id
        WHERE o.workspace_id=? AND o.conversation_id=? AND o.participant_id=?
        AND c.source_binding_id=? AND c.source_generation=? AND c.trigger_message_id=? AND c.trigger_sequence=?
        AND (? IS NULL OR o.id=?) AND (o.outcome='pending' OR o.closed_at>?) ORDER BY o.ordinal DESC LIMIT 50`,
      args: [scope.workspaceId, scope.conversationId, scope.participantIdentityId, reference.bindingId, reference.generation, reference.triggerMessageId, reference.triggerSequence, reference.operationId ?? null, reference.operationId ?? null, cutoff],
    })).rows;
    return rows.map((row) => String(row.id));
  }

  async prune(now: string): Promise<void> {
    await this.delivery.prune(now);
    const cutoff = new Date(Date.parse(now) - DIAGNOSTIC_LIMITS.days * 86_400_000).toISOString();
    await this.client.batch([{
      sql: `DELETE FROM operations WHERE id IN (SELECT id FROM operations WHERE outcome<>'pending'
        AND (closed_at<=? OR ordinal IN (SELECT ordinal FROM operations WHERE outcome<>'pending'
          ORDER BY closed_at DESC,ordinal DESC LIMIT -1 OFFSET 1000)) ORDER BY ordinal LIMIT 100)
        AND (SELECT epoch FROM journal_meta WHERE singleton=1)=?`, args: [cutoff, this.epoch],
    }, {
      sql: `DELETE FROM epochs WHERE ordinal IN (SELECT ordinal FROM epochs WHERE epoch<>?
        AND NOT EXISTS(SELECT 1 FROM operations WHERE operations.epoch=epochs.epoch)
        AND (started_at<=? OR ordinal NOT IN (SELECT ordinal FROM epochs ORDER BY ordinal DESC LIMIT 128))
        ORDER BY ordinal LIMIT 100) AND (SELECT epoch FROM journal_meta WHERE singleton=1)=?`,
      args: [this.epoch, cutoff, this.epoch],
    }], "write");
  }

  async markGap() {
    this.gap = true;
    await this.client.execute({ sql: "UPDATE journal_meta SET gap=1 WHERE singleton=1 AND epoch=?", args: [this.epoch] });
  }

  async close(clean = true) {
    if (this.client.closed) return;
    try {
      if (clean) await this.client.batch([
        { sql: "UPDATE journal_meta SET clean=1 WHERE singleton=1 AND epoch=?", args: [this.epoch] },
        { sql: "UPDATE epochs SET closed_at=?,closure='clean' WHERE epoch=? AND (SELECT epoch FROM journal_meta WHERE singleton=1)=?", args: [new Date().toISOString(), this.epoch, this.epoch] },
      ], "write");
    } finally { this.client.close(); }
  }
}
