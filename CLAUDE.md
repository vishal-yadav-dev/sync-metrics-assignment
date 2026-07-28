# Build Instructions for Claude Code

- Build in small pieces, one module at a time. Do NOT scaffold the whole project in one go.
- After each piece, stop and tell me the exact command to run/test it. Wait for me to confirm before continuing.
- Write a test for each core piece (upsert idempotency, stale-cursor fallback, revenue reconciliation) and show it passing.
- Keep dependencies minimal: express, pg, dotenv, zod, vitest. Do not add libraries without asking.
- TypeScript strict mode. No `any` unless justified in a comment.
- Never invent env vars or credentials. Read them from src/config/env.ts only.
- The hash delimiter in core/ids.ts must be \x1f (not a colon — provider IDs can contain colons).
- Store status words verbatim in status_raw. Only core/status.ts is allowed to judge collected-ness.
- Explain any non-obvious decision in a one-line comment so I can review it


# Overview

One repo, two problems. Three sources (HubSpot, Google Calendar, Stripe test mode) ingested through a single SourceAdapter interface (incremental + full) into one normalized schema. All writes go through one idempotent upsert path, whether triggered by the sync job or an inbound webhook. Metrics are computed by one pure function that both endpoints call.

# Folder Structure
src/
  config/
    env.ts                 # zod-validated env, fail-fast on boot
  db/
    client.ts              # pg pool
    migrations/            # ordered .sql files
  core/
    normalized.ts          # canonical record type all sources map INTO
    status.ts              # THE allow-list + isCollected() — single source of truth
    ids.ts                 # idempotency-key + content-hash derivation
  sources/
    types.ts               # SourceAdapter interface, StaleCursorError
    hubspot/{adapter.ts,map.ts}
    gcal/{adapter.ts,map.ts}
    stripe/{adapter.ts,map.ts}
  sync/
    runner.ts              # runs adapters (allSettled), fault isolation, reactive fallback
    cursor.ts              # read / advance / invalidate cursors
    upsert.ts              # THE idempotent write path
    backfill.ts            # full-fetch execution
    mode.ts                # shouldFullSync() — proactive-backfill decision
  metrics/
    revenue.ts             # computeRevenue() — the one pure function
    routes.ts              # /summary and /breakdown
  webhooks/
    routes.ts              # inbound webhooks -> upsert.ts
    verify.ts              # per-provider signature verification
  http/
    server.ts
    routes.ts
  jobs/
    sync-job.ts            # cron entrypoint; decides mode per source, calls runner

# Load-bearing rules:

Webhooks and the sync job write through the exact same upsert.ts. Two entry points, one write function.
Storage never interprets status words. status_raw is stored verbatim; only core/status.ts judges collected-ness.
sync-job.ts decides mode; runner.ts executes it and still applies reactive fallback on StaleCursorError.
DB Schema
synced_records
sql
create table synced_records (
  idempotency_key   text primary key,        -- generated: hash(source:record_type:source_id)
  source            text not null,           -- 'hubspot' | 'gcal' | 'stripe'
  source_id         text not null,           -- provider's own object id
  record_type       text not null,           -- 'contact' | 'event' | 'payment'

  occurred_at       timestamptz,             -- business-relevant timestamp
  status_raw        text,                    -- provider's original status word, UNTOUCHED
  amount_cents      bigint,                  -- null for non-payment records
  currency          text,                    -- ISO 4217, lowercased; null if no amount
  data              jsonb not null,          -- full normalized payload

  source_updated_at timestamptz,             -- provider last-modified; ordering guard
  content_hash      text not null,           -- hash of normalized payload
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()  -- last MODIFICATION, not last sighting
);

create unique index synced_records_natural_key
  on synced_records (source, source_id, record_type);
create index synced_records_type_time  on synced_records (record_type, occurred_at);
create index synced_records_revenue    on synced_records (record_type, currency, occurred_at);
create index synced_records_status     on synced_records (status_raw);

Idempotency key strategy. idempotency_key = hash(source + ':' + record_type + ':' + source_id) — stable identity, unchanged by content changes. Same object from any entry point (webhook, incremental, full backfill), any number of times, collapses to one row.

content_hash does the opposite job: on upsert, if incoming content_hash == stored, the guarded UPDATE does not fire at all — unchanged content is a true no-op, with no write of any kind; if different, update in place. Never a new row for a known object. Consequence: last_seen_at reflects the last time the record was modified, not the last time it was seen. A row re-landed unchanged by a backfill keeps its existing last_seen_at.

content_hash deliberately excludes source_updated_at: that field is the ordering guard, not content, so a provider bumping its last-modified timestamp without changing anything is not treated as a change.

Write is a single statement, guarded so a replayed older version never clobbers a newer one:

sql
insert into synced_records (...) values (...)
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
      >= coalesce(synced_records.source_updated_at, 'epoch'::timestamptz);

This makes scheduled backfill free: re-landing seen rows is a no-op by construction.

sync_cursors
sql
create table sync_cursors (
  source            text not null,
  record_type       text not null,
  cursor_value      text,                    -- opaque: timestamp | syncToken | object_id
  cursor_kind       text not null,           -- 'timestamp' | 'token' | 'object_id'
  last_full_sync_at timestamptz,             -- drives proactive 24h backfill
  last_run_at       timestamptz,
  last_status       text,                    -- 'ok' | 'stale' | 'error'
  primary key (source, record_type)
);
# Cursors, Staleness, Backfill

Two independent triggers for full mode, one execution path:

Proactive (sync/mode.ts, called by sync-job.ts): shouldFullSync = now - last_full_sync_at >= 24h. The all-source safety net; catches anything incremental detection missed, within a day. Cheap because writes are idempotent.
Reactive (sync/runner.ts): adapter throws StaleCursorError → invalidate that cursor → re-run that one source in full, now.

# Per-provider stale detection:

Google Calendar — syncToken. Google returns 410 Gone on expiry → catch → StaleCursorError → full (re-issues fresh token). Cleanest case.
Stripe — starting_after object id. Invalid/deleted cursor → 400 → StaleCursorError → full from top. (Also reachable via webhook through the same upsert; webhook signature verified in verify.ts.)
HubSpot — hs_lastmodifieddate watermark via Search API. Declare stale on any of: (1) Search API rejects the query (400/validation, non-transient 401/403); (2) watermark null/missing where one is expected; (3) now - cursor_value > 7 days (stays clear of the Search API's 10k-result pagination ceiling). All three checkable, no heuristics; the 24h backfill backstops any miss.
SourceAdapter Interface
typescript
// sources/types.ts

export type RecordType = 'contact' | 'event' | 'payment';

export interface NormalizedRecord {
  source: 'hubspot' | 'gcal' | 'stripe';
  source_id: string;
  record_type: RecordType;
  occurred_at: string | null;        // ISO 8601
  status_raw: string | null;         // verbatim from provider
  amount_cents: number | null;
  currency: string | null;           // ISO 4217, lowercased
  data: Record<string, unknown>;     // full normalized payload
  source_updated_at: string | null;  // ISO 8601, provider last-modified
}

export interface FetchResult {
  records: NormalizedRecord[];
  next_cursor: string | null;        // null when fully drained
}

export type SyncMode = 'incremental' | 'full';

export interface SourceAdapter {
  readonly source: 'hubspot' | 'gcal' | 'stripe';
  readonly record_type: RecordType;

  // Incremental fetch from cursor. Throws StaleCursorError on provider staleness signal.
  fetchIncremental(cursor: string | null): Promise<FetchResult>;

  // Full backfill from the beginning. Paginates via returned next_cursor.
  fetchFull(cursor: string | null): Promise<FetchResult>;
}

// Thrown by any adapter on its provider-specific staleness signal (410, rejected
// query, bad starting_after). Caught by runner -> invalidate cursor -> full re-run.
export class StaleCursorError extends Error {
  constructor(
    public readonly source: string,
    public readonly reason: string,
  ) {
    super(`stale cursor for ${source}: ${reason}`);
  }
}

Runner contract: iterate fetchIncremental/fetchFull until next_cursor === null, upserting each page through upsert.ts. Each source runs in its own Promise.allSettled slot (source-level isolation); each record maps in a try/catch that skips-and-logs unmappable payloads (record-level isolation). One source down or returning garbage never blocks the other two.

Metrics

Allow-list, single source of truth (core/status.ts):

typescript
const COLLECTED_STATUSES = new Set(['paid', 'succeeded', 'completed']);

export function isCollected(statusRaw: string | null): boolean {
  return statusRaw != null && COLLECTED_STATUSES.has(statusRaw.toLowerCase());
}

Allow-list, not exclusion: unknown/new status words return false (fail-closed). Nothing outside this file knows status words.

One computation, per-currency (metrics/revenue.ts):

typescript
export interface CurrencyRevenue {
  currency: string;
  total_cents: number;
  by_day: { date: string; total_cents: number }[];   // date = 'YYYY-MM-DD' (UTC)
}

// The ONLY place revenue is computed. Both endpoints call this.
// total_cents is DEFINED as sum(by_day) per currency — no independent total path.
// Never sums across currencies.
export function computeRevenue(
  range: { from: string; to: string },
): Promise<CurrencyRevenue[]>;
Filters to record_type = 'payment' AND isCollected(status_raw).
Groups by currency; never sums across them (documented: no FX conversion, per-currency reporting).
total_cents is sum(by_day.total_cents) inside this function — there is no second code path.

Endpoints (metrics/routes.ts), both backed by the single call:

GET /metrics/summary?from&to → per-currency { currency, total_cents }.
GET /metrics/breakdown?from&to → per-currency { currency, by_day }.

Invariants that catch a divergent second computation:

Runtime + unit: for every currency, total_cents === sum(by_day.total_cents). Breaks loudly if anyone later "optimizes" summary with a separate SUM.
CI test: enumerate every distinct status_raw in the DB; assert each is explicitly classified by isCollected. A new unclassified status word fails CI instead of silently dropping revenue.

# Known Limitations (documented, intentional)
Stripe as polled source, not authoritative webhook + reconciliation. Webhooks land through the same idempotent upsert; signatures verified. Production would treat Stripe webhooks as authoritative and poll only to reconcile.
No FX conversion. Revenue reported per-currency, never consolidated. Cross-currency summation is deliberately impossible in computeRevenue.