import type { RecordType, Source } from "../core/normalized";
import { db, type Queryable } from "../db/client";

export type CursorKind = "timestamp" | "token" | "object_id";
export type CursorStatus = "ok" | "stale" | "error";

export interface CursorRow {
  source: string;
  record_type: string;
  cursor_value: string | null;
  cursor_kind: CursorKind;
  last_full_sync_at: Date | null;
  last_run_at: Date | null;
  last_status: CursorStatus | null;
}

interface CursorKey {
  source: Source;
  record_type: RecordType;
}

export async function readCursor(
  key: CursorKey,
  conn: Queryable = db,
): Promise<CursorRow | null> {
  const row = await conn<CursorRow>("sync_cursors").where(key).first();
  return row ?? null;
}

// Every writer upserts: the first run for a source has no row yet.
async function writeCursor(
  key: CursorKey,
  kind: CursorKind,
  changes: Record<string, unknown>,
  conn: Queryable,
): Promise<void> {
  await conn("sync_cursors")
    .insert({ ...key, cursor_kind: kind, last_run_at: db.fn.now(), ...changes })
    .onConflict(["source", "record_type"])
    .merge(Object.keys({ last_run_at: null, ...changes }));
}

export async function advanceCursor(
  key: CursorKey,
  kind: CursorKind,
  value: string | null,
  conn: Queryable = db,
): Promise<void> {
  await writeCursor(key, kind, { cursor_value: value, last_status: "ok" }, conn);
}

// Staleness clears the cursor so the next incremental run bootstraps instead of replaying
// a token the provider has already rejected.
export async function invalidateCursor(
  key: CursorKey,
  kind: CursorKind,
  conn: Queryable = db,
): Promise<void> {
  await writeCursor(key, kind, { cursor_value: null, last_status: "stale" }, conn);
}

// cursor_value is deliberately absent from the changes: a fatal error must leave the last
// good cursor in place so the next run retries from there.
export async function markCursorError(
  key: CursorKey,
  kind: CursorKind,
  conn: Queryable = db,
): Promise<void> {
  await writeCursor(key, kind, { last_status: "error" }, conn);
}

// last_full_sync_at is what mode.ts reads for the proactive 24h backfill decision.
export async function stampFullSync(
  key: CursorKey,
  kind: CursorKind,
  value: string | null,
  conn: Queryable = db,
): Promise<void> {
  await writeCursor(
    key,
    kind,
    { cursor_value: value, last_status: "ok", last_full_sync_at: db.fn.now() },
    conn,
  );
}
