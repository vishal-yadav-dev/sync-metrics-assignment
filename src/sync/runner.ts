import type { RecordType, Source } from "../core/normalized";
import {
  type SourceAdapter,
  StaleCursorError,
  type SyncMode,
} from "../sources/types";
import { runBackfill } from "./backfill";
import {
  advanceCursor,
  invalidateCursor,
  markCursorError,
  readCursor,
} from "./cursor";
import { type UpsertCounts, upsertMany } from "./upsert";

export interface SyncJob {
  adapter: SourceAdapter;
  mode: SyncMode; // sync-job.ts decides this; the runner only executes it
}

export interface SourceRunSummary extends UpsertCounts {
  source: Source;
  record_type: RecordType;
  mode: SyncMode; // the mode actually executed, which staleness can upgrade to 'full'
  status: "ok" | "stale" | "error";
  error?: string;
}

// A factory, not a shared constant: every error summary gets its own counts object, so no
// later edit can mutate one summary's counts and silently change another's.
const noCounts = (): UpsertCounts => ({
  inserted: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runIncremental(
  adapter: SourceAdapter,
): Promise<SourceRunSummary> {
  const { source, record_type, cursor_kind } = adapter;
  const key = { source, record_type };

  const stored = await readCursor(key);
  const result = await adapter.fetchIncremental(stored?.cursor_value ?? null);
  const counts = await upsertMany(result.records);

  // Advanced only after the records land, so a crash mid-write re-fetches the window
  // instead of skipping it.
  await advanceCursor(key, cursor_kind, result.next_cursor);

  return { ...counts, source, record_type, mode: "incremental", status: "ok" };
}

async function runSource(job: SyncJob): Promise<SourceRunSummary> {
  const { adapter, mode } = job;
  const { source, record_type, cursor_kind } = adapter;
  const key = { source, record_type };

  try {
    if (mode === "full") {
      const counts = await runBackfill(adapter);
      return { ...counts, source, record_type, mode: "full", status: "ok" };
    }
    return await runIncremental(adapter);
  } catch (err) {
    if (err instanceof StaleCursorError) {
      try {
        // Reactive fallback: drop the rejected cursor, then re-run this ONE source in full.
        // Re-landing already-seen rows is free because the upsert guard makes it a no-op.
        await invalidateCursor(key, cursor_kind);
        const counts = await runBackfill(adapter);
        return { ...counts, source, record_type, mode: "full", status: "stale" };
      } catch (fallbackErr) {
        await markCursorError(key, cursor_kind);
        return {
          ...noCounts(),
          source,
          record_type,
          mode: "full",
          status: "error",
          error: `stale fallback failed: ${message(fallbackErr)}`,
        };
      }
    }

    // Fatal but not stale: record the failure and leave the cursor untouched so the next run
    // retries from the same point. No backfill — that would mask a real outage as a resync.
    await markCursorError(key, cursor_kind);
    return {
      ...noCounts(),
      source,
      record_type,
      mode,
      status: "error",
      error: message(err),
    };
  }
}

// Source-level isolation. runSource already swallows its own failures, so allSettled is the
// backstop for anything thrown outside that try (a cursor write failing, say): one dead
// source can never take the other two down with it.
export async function runSync(jobs: SyncJob[]): Promise<SourceRunSummary[]> {
  const settled = await Promise.allSettled(jobs.map(runSource));

  return settled.map((outcome, i) => {
    if (outcome.status === "fulfilled") return outcome.value;

    const job = jobs[i];
    // allSettled preserves input order and length; this guard is unreachable in practice.
    if (job === undefined) throw new Error("runSync: result index out of range");

    return {
      ...noCounts(),
      source: job.adapter.source,
      record_type: job.adapter.record_type,
      mode: job.mode,
      status: "error",
      error: message(outcome.reason),
    };
  });
}
