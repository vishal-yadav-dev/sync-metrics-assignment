import type { SourceAdapter } from "../sources/types";
import { stampFullSync } from "./cursor";
import { type UpsertCounts, upsertMany } from "./upsert";

// Full-fetch execution, shared by a scheduled backfill and the runner's reactive fallback.
export async function runBackfill(adapter: SourceAdapter): Promise<UpsertCounts> {
  const { source, record_type, cursor_kind } = adapter;

  // One call, per the fetchFull contract in sources/types.ts: it drains every page itself.
  const result = await adapter.fetchFull(null);
  const counts = await upsertMany(result.records);

  // Cursor is saved only after the records land: a crash mid-write leaves the old cursor,
  // and the next run re-fetches rather than skipping the gap.
  await stampFullSync({ source, record_type }, cursor_kind, result.next_cursor);

  return counts;
}
