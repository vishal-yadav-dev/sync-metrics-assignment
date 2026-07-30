import type { NormalizedRecord, RecordType, Source } from '../core/normalized';
import type { CursorKind } from '../sync/cursor';

export type { NormalizedRecord, RecordType, Source };

export interface FetchResult {
  records: NormalizedRecord[];
  next_cursor: string | null; // null when fully drained
}

export type SyncMode = 'incremental' | 'full';

export interface SourceAdapter {
  readonly source: Source;
  readonly record_type: RecordType;
  // Which kind of cursor this source stores, so the runner never hardcodes per-source rules.
  readonly cursor_kind: CursorKind;

  // Incremental fetch from cursor. Throws StaleCursorError on provider staleness signal.
  // MUST drain all pages internally; next_cursor is the fresh sync token, never a page token.
  fetchIncremental(cursor: string | null): Promise<FetchResult>;

  // Full backfill from the beginning. MUST drain all pages internally and return the complete
  // record set in one FetchResult, with next_cursor being the fresh sync token. runBackfill
  // calls this once and trusts it returned everything — a partial fetchFull is a silent sync gap.
  fetchFull(cursor: string | null): Promise<FetchResult>;
}

// Thrown by any adapter on its provider-specific staleness signal (410, rejected query,
// bad starting_after). Caught by runner -> invalidate cursor -> full re-run.
export class StaleCursorError extends Error {
  constructor(
    public readonly source: string,
    public readonly reason: string,
  ) {
    super(`stale cursor for ${source}: ${reason}`);
    this.name = 'StaleCursorError';
  }
}
