import { contentHash, idempotencyKey } from "../core/ids";
import type { NormalizedRecord } from "../core/normalized";
import { db, type Queryable } from "../db/client";

export type UpsertOutcome = "inserted" | "updated" | "skipped";

// knex.raw: this is a guarded ON CONFLICT the query builder cannot express.
const SQL = `
insert into synced_records (
  idempotency_key, source, source_id, record_type,
  occurred_at, status_raw, amount_cents, currency, data,
  source_updated_at, content_hash
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict (idempotency_key) do update set
  status_raw = excluded.status_raw,
  amount_cents = excluded.amount_cents,
  currency = excluded.currency,
  data = excluded.data,
  occurred_at = excluded.occurred_at,
  source_updated_at = excluded.source_updated_at,
  content_hash = excluded.content_hash,
  last_seen_at = now()
where excluded.content_hash <> synced_records.content_hash
  and coalesce(excluded.source_updated_at, 'epoch'::timestamptz)
      >= coalesce(synced_records.source_updated_at, 'epoch'::timestamptz)
returning (xmax = 0) as inserted
`;

// THE write path. Sync job and webhooks both land here; nothing else writes synced_records.
export async function upsertRecord(
  record: NormalizedRecord,
  conn: Queryable = db,
): Promise<UpsertOutcome> {
  const result = await conn.raw<{ rows: { inserted: boolean }[] }>(SQL, [
    idempotencyKey(record.source, record.record_type, record.source_id),
    record.source,
    record.source_id,
    record.record_type,
    record.occurred_at,
    record.status_raw,
    record.amount_cents,
    record.currency,
    JSON.stringify(record.data),
    record.source_updated_at,
    contentHash(record),
  ]);

  // No row back means the guard rejected the write: unchanged content, or a replay older
  // than what is stored.
  const row = result.rows[0];
  if (row === undefined) return "skipped";
  // xmax is 0 only on a fresh insert; on an update it holds the locking transaction id.
  return row.inserted ? "inserted" : "updated";
}

export interface UpsertCounts {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number; // not an upsert outcome: records that threw before producing one
}

// Record-level isolation for writes: one row that fails to persist must not abandon the
// rest of the batch. Incremental and backfill both land here.
export async function upsertMany(
  records: NormalizedRecord[],
  conn: Queryable = db,
): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

  for (const record of records) {
    try {
      counts[await upsertRecord(record, conn)] += 1;
    } catch (err) {
      counts.errors += 1;
      console.warn(
        `[upsert] ${record.source}/${record.source_id} failed:`,
        (err as Error).message,
      );
    }
  }

  return counts;
}
