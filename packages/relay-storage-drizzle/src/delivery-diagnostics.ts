import type { Client } from "@libsql/client";
import { DELIVERY_LIMITS, deliveryRecord, deliveryScope, deliverySummary, deliveryDetail, type DeliveryRecord, type DeliveryScope, type DeliveryHistory, type DeliveryDetail } from "@minu/channels-relay";

export const DELIVERY_SCHEMA = [
  "ALTER TABLE journal_meta ADD COLUMN delivery_gap INTEGER NOT NULL DEFAULT 0",
  `CREATE TABLE delivery_trails (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL,
    revision INTEGER NOT NULL, scope_key TEXT NOT NULL, trigger_id TEXT NOT NULL, trigger_sequence INTEGER NOT NULL,
    outcome TEXT NOT NULL, closed_at TEXT, snapshot TEXT NOT NULL)`,
  "CREATE INDEX delivery_scope ON delivery_trails(scope_key,ordinal)",
  "CREATE INDEX delivery_retention ON delivery_trails(outcome,closed_at,ordinal)",
  "INSERT INTO journal_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", "PRAGMA user_version=2",
];
const scopeKey = (scope: DeliveryScope) => JSON.stringify(deliveryScope(scope));
/** Separate indexed collection/capacity inside the optional journal, not Relay authority storage. */
export class DeliveryJournal {
  constructor(private client: Client, private epoch: string, public recordingGap: boolean) {}
  async markGap() {
    this.recordingGap = true;
    await this.client.execute({ sql: "UPDATE journal_meta SET delivery_gap=1 WHERE singleton=1 AND epoch=?", args: [this.epoch] });
  }
  async recover(now: string) {
    const pending = await this.client.execute("SELECT snapshot FROM delivery_trails WHERE outcome='pending' LIMIT 129");
    if (pending.rows.length > DELIVERY_LIMITS.tracked) throw new Error("Delivery diagnostic capacity exceeded");
    for (const row of pending.rows) {
      const record = deliveryRecord(JSON.parse(String(row.snapshot)));
      record.outcome = "unknown"; record.closedAt = now; record.observedAt = now; record.recordingGap = true;
      record.revision++; record.lastSequence++;
      if (record.events.length === DELIVERY_LIMITS.events) { record.events.pop(); record.eventsDropped++; }
      record.events.push({ sequence: record.lastSequence, stage: "observer_lost", observedAt: now, elapsedMs: record.events.at(-1)?.elapsedMs ?? 0 });
      await this.client.execute({ sql: `UPDATE delivery_trails SET outcome='unknown',closed_at=?,revision=?,snapshot=? WHERE id=?
        AND outcome='pending' AND (SELECT epoch FROM journal_meta WHERE singleton=1)=?`, args: [now, record.revision, JSON.stringify(deliveryRecord(record)), record.trailId, this.epoch] });
      await this.markGap();
    }
    await this.prune(now);
  }
  async put(input: unknown): Promise<boolean> {
    const record = deliveryRecord(input);
    if (record.epoch !== this.epoch) return false;
    const pending = await this.client.execute({ sql: "SELECT count(*) AS count FROM delivery_trails WHERE outcome='pending' AND id<>?", args: [record.trailId] });
    if (record.outcome === "pending" && Number(pending.rows[0]?.count) >= DELIVERY_LIMITS.tracked) return false;
    const result = await this.client.execute({ sql: `INSERT INTO delivery_trails(id,epoch,revision,scope_key,trigger_id,trigger_sequence,outcome,closed_at,snapshot)
      SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT epoch FROM journal_meta WHERE singleton=1)=?
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,outcome=excluded.outcome,closed_at=excluded.closed_at,snapshot=excluded.snapshot
      WHERE delivery_trails.epoch=excluded.epoch AND delivery_trails.revision<excluded.revision AND delivery_trails.outcome='pending'
      AND delivery_trails.scope_key=excluded.scope_key AND delivery_trails.trigger_id=excluded.trigger_id AND delivery_trails.trigger_sequence=excluded.trigger_sequence`,
      args: [record.trailId, record.epoch, record.revision, scopeKey(record), record.triggerId, record.triggerSequence, record.outcome, record.closedAt ?? null, JSON.stringify(record), this.epoch] });
    if (result.rowsAffected) await this.prune(record.observedAt);
    return result.rowsAffected > 0;
  }
  async history(scope: DeliveryScope, cursor?: string, now = new Date().toISOString()): Promise<DeliveryHistory> {
    let upper: number, before: number;
    if (cursor !== undefined) {
      if (!/^\d{1,16}:\d{1,16}$/.test(cursor)) throw new Error("Invalid delivery cursor");
      [upper, before] = cursor.split(":").map(Number) as [number, number];
      if (!Number.isSafeInteger(upper) || !Number.isSafeInteger(before) || upper < 1 || before < 1 || before > upper + 1) throw new Error("Invalid delivery cursor");
    } else {
      upper = Number((await this.client.execute({ sql: "SELECT max(ordinal) AS maximum FROM delivery_trails WHERE scope_key=?", args: [scopeKey(scope)] })).rows[0]?.maximum ?? 0);
      before = upper + 1;
    }
    const cutoff = new Date(Date.parse(now) - DELIVERY_LIMITS.days * 86400000).toISOString();
    const rows = (await this.client.execute({ sql: `SELECT ordinal,snapshot FROM delivery_trails WHERE scope_key=? AND ordinal<=? AND ordinal<?
      AND (outcome='pending' OR closed_at>?) ORDER BY ordinal DESC LIMIT 51`, args: [scopeKey(scope), upper, before, cutoff] })).rows;
    const page = rows.slice(0, DELIVERY_LIMITS.page);
    return { trails: page.map(row => deliverySummary(deliveryRecord(JSON.parse(String(row.snapshot))))), recordingGap: this.recordingGap,
      ...(rows.length > DELIVERY_LIMITS.page ? { nextCursor: `${upper}:${page.at(-1)!.ordinal}` } : {}) };
  }
  async detail(scope: DeliveryScope, id: string, now = new Date().toISOString()): Promise<DeliveryDetail | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new Error("Invalid delivery selection");
    const cutoff = new Date(Date.parse(now) - DELIVERY_LIMITS.days * 86400000).toISOString();
    const row = (await this.client.execute({ sql: "SELECT snapshot FROM delivery_trails WHERE id=? AND scope_key=? AND (outcome='pending' OR closed_at>?)", args: [id, scopeKey(scope), cutoff] })).rows[0];
    return row && deliveryDetail(deliveryRecord(JSON.parse(String(row.snapshot))));
  }
  async prune(now: string) {
    const cutoff = new Date(Date.parse(now) - DELIVERY_LIMITS.days * 86400000).toISOString();
    await this.client.execute({ sql: `DELETE FROM delivery_trails WHERE id IN (SELECT id FROM delivery_trails WHERE outcome<>'pending'
      AND (closed_at<=? OR ordinal IN (SELECT ordinal FROM delivery_trails WHERE outcome<>'pending' ORDER BY closed_at DESC,ordinal DESC LIMIT -1 OFFSET 1000))
      ORDER BY ordinal LIMIT 256) AND (SELECT epoch FROM journal_meta WHERE singleton=1)=?`, args: [cutoff, this.epoch] });
  }
}
