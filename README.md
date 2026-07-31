# Multi-Source Sync & Metrics Service

## Overview

A multi-source sync pipeline that ingests Google Calendar events and Stripe payments through a single `SourceAdapter` interface into one normalized Postgres schema, paired with a metrics service that computes collected revenue from that schema. Every write — whether from a scheduled sync, a manual trigger, or a re-run — goes through one idempotent upsert path, so duplicates are impossible and out-of-order updates never overwrite newer data. Both metrics endpoints are backed by a single pure function, so the summary and the day-by-day breakdown cannot drift apart.

**Live at [https://multi-source-sync-service.onrender.com](https://multi-source-sync-service.onrender.com)**

> **Cold start:** the service runs on Render's free tier and sleeps when idle. The first request after a period of inactivity takes **30–50 seconds**. Subsequent requests are fast.

---

## Live endpoints

### `GET /health`

```bash
curl https://multi-source-sync-service.onrender.com/health
```

```json
{ "ok": true }
```

### `POST /sync`

Runs both sources and returns a per-source run summary.

```bash
curl -X POST https://multi-source-sync-service.onrender.com/sync
```

```json
{
  "summaries": [
    {
      "source": "gcal",
      "record_type": "event",
      "mode": "incremental",
      "status": "ok",
      "inserted": 0,
      "updated": 0,
      "skipped": 6,
      "errors": 0
    },
    {
      "source": "stripe",
      "record_type": "payment",
      "mode": "incremental",
      "status": "ok",
      "inserted": 0,
      "updated": 0,
      "skipped": 4,
      "errors": 0
    }
  ]
}
```

`skipped` means the row was already present and unchanged — running this repeatedly is a no-op by design. `status` is `ok`, `stale` (a stale cursor triggered a full backfill), or `error`. `mode` reports what actually ran, so `{ "mode": "full", "status": "stale" }` identifies a reactive backfill.

### `GET /records`

All synced data grouped by source, with the three most recent records each. This is the quickest way to confirm multi-source ingestion, including sources that produce no revenue.

```bash
curl https://multi-source-sync-service.onrender.com/records
```

```json
{
  "total_records": 10,
  "by_source": [
    {
      "source": "gcal",
      "total": 6,
      "record_types": [{ "record_type": "event", "count": 6 }],
      "recent": [
        {
          "id": "07a9e4601415571ef64b2107e1c5536bed67065187d7f62643372d11e5f6acd3",
          "source_id": "1cqn6h6ee4se7nhetang3ig4nd",
          "status_raw": "confirmed",
          "occurred_at": "2026-08-06T11:30:00.000Z"
        },
        {
          "id": "2455fd9908e53790deffa728865517ea319b8694ff004b4f90bf516c7baa08c7",
          "source_id": "2q5k8udlava6ucoasgrms7f8lj",
          "status_raw": "cancelled",
          "occurred_at": "2026-08-05T06:00:00.000Z"
        }
      ]
    },
    {
      "source": "stripe",
      "total": 4,
      "record_types": [{ "record_type": "payment", "count": 4 }],
      "recent": [
        {
          "id": "ba5c557cc18e253cde6a3ef5deacf6e54ddc5ffb6ce3a5237de6cd3d7836d825",
          "source_id": "pi_3Tz1n82L8uMiNUBO0aCqDxYw",
          "status_raw": "requires_payment_method",
          "occurred_at": "2026-07-30T21:47:02.000Z"
        },
        {
          "id": "73d5acf9dfdbaaded5235a69367fdab56e879ebd27d054e90eb49c1f4b02e53b",
          "source_id": "pi_3Tz1mB2L8uMiNUBO1NlX5Rnh",
          "status_raw": "succeeded",
          "occurred_at": "2026-07-30T21:46:03.000Z"
        }
      ]
    }
  ]
}
```

The `status_raw` values show the allow-list doing real work: `cancelled` and `requires_payment_method` are stored verbatim and correctly excluded from revenue, while `succeeded` counts. Google Calendar contributes six events and zero revenue — it can only ever appear here, never in `/metrics`.

### `GET /metrics/summary?from&to`

Collected revenue per currency.

```bash
curl "https://multi-source-sync-service.onrender.com/metrics/summary?from=2026-07-01&to=2026-07-31"
```

```json
[{ "currency": "usd", "total_cents": 19000 }]
```

### `GET /metrics/breakdown?from&to`

The same revenue, day by day. For every currency, `total_cents` from `/metrics/summary` always equals the sum of these buckets.

```bash
curl "https://multi-source-sync-service.onrender.com/metrics/breakdown?from=2026-07-01&to=2026-07-31"
```

```json
[
  {
    "currency": "usd",
    "by_day": [{ "date": "2026-07-30", "total_cents": 19000 }]
  }
]
```

`from` and `to` accept a bare `YYYY-MM-DD` (the `to` day is included in full) or a complete ISO 8601 timestamp.

---

## Running locally

Requires **Node 22+** and a Postgres database.

```bash
git clone <repository-url>
cd multi-source-sync-service
npm install
```

Create a `.env` from the template:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | Postgres connection string. TLS is enabled automatically for non-local hosts. |
| `STRIPE_SECRET_KEY` | **yes** | Test-mode key (`sk_test_…`). |
| `GOOGLE_CLIENT_EMAIL` | for gcal | Service account email. |
| `GOOGLE_PRIVATE_KEY` | for gcal | Single line, double-quoted, with literal `\n` escapes. |
| `GOOGLE_CALENDAR_ID` | for gcal | The calendar shared with the service account. Unset uses `primary`, which is empty for a service account. |
| `PORT` | no | Defaults to `3000`. Leave unset on Render, which injects its own. |
| `HUBSPOT_TOKEN` | no | Unused in this submission — see limitations. |
| `STRIPE_WEBHOOK_SECRET` | no | Unused in this submission — see limitations. |

Config is validated by zod at boot ([`src/config/env.ts`](src/config/env.ts)). A missing or malformed value fails immediately with a message naming the variable, rather than surfacing later as a confusing runtime error.

Apply migrations, then start:

```bash
npm run migrate
npm run dev
```

```bash
curl localhost:3000/health
curl -X POST localhost:3000/sync
```

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch-mode server via tsx |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run migrate` | Apply migrations (local) |
| `npm run migrate:prod` | Apply migrations from `dist/` |
| `npm run typecheck` | `tsc --noEmit` across src, tests, and scripts |
| `npm test` | Vitest |

Two smoke scripts hit each provider directly, bypassing HTTP:

```bash
npx tsx scripts/try-gcal.ts <calendar-id>
npx tsx scripts/try-stripe.ts
```

---

## Architecture & key design decisions

```
sources/{gcal,stripe}  ──▶  sync/runner  ──▶  sync/upsert  ──▶  synced_records
   (SourceAdapter)          (isolation,      (THE write path)         │
                             fallback)                                ▼
                                                          metrics/revenue ──▶ /metrics/*
```

### Idempotency

Identity is a composite natural key — `hash(source ␟ record_type ␟ source_id)` — stored as the primary key. It never changes when content changes, so the same object arriving from any entry point, any number of times, collapses to one row. The delimiter is `\x1f` (unit separator) rather than a colon, because provider ids legitimately contain colons.

`content_hash` does the opposite job. It is a hash of the normalized payload with object keys sorted at every depth, so payloads differing only in key order hash identically. Writes are a single guarded statement:

```sql
insert into synced_records (...) values (...)
on conflict (idempotency_key) do update set ...
where excluded.content_hash <> synced_records.content_hash
  and coalesce(excluded.source_updated_at, 'epoch'::timestamptz)
      >= coalesce(synced_records.source_updated_at, 'epoch'::timestamptz);
```

Two guarantees fall out of that `WHERE` clause. Unchanged content performs **no write at all** — a re-run or duplicate webhook is a true no-op, which is what makes scheduled full backfills cheap. And a replay carrying an older `source_updated_at` cannot clobber newer data, so out-of-order delivery is safe.

`content_hash` deliberately excludes `source_updated_at`: that field is the ordering guard, not content, so a provider bumping its modified timestamp without changing anything is not treated as a change. One consequence worth knowing: `last_seen_at` records the last *modification*, not the last sighting.

### Fault isolation

Two independent levels, because they fail differently:

- **Per source** — each adapter runs in its own `Promise.allSettled` slot. One provider being down, slow, or returning garbage cannot block the other.
- **Per record** — mapping and writing each record is individually caught, and failures are skipped and logged. One malformed payload costs one record, not the whole batch.

The distinction is visible in a run summary: a per-record failure reports `status: "ok"` with `errors > 0`, while a source-level failure reports `status: "error"` with all counts at zero.

### Stale-cursor fallback

Adapters never handle their own recovery — they only signal. Each throws `StaleCursorError` on its provider-specific staleness signal (Google returns `410 Gone` for an expired `syncToken`; Stripe returns a `400` naming `starting_after`). The runner catches it, invalidates that cursor, and immediately re-runs **that one source** in full. Re-landing already-seen rows costs nothing because the upsert guard makes it a no-op.

A fatal error that is *not* staleness is handled deliberately differently: the cursor is left intact and **no backfill runs**, so the next run retries from the same point. Treating an outage as a resync would hide a real failure behind a full re-fetch that appears to succeed.

Staleness detection is narrow on purpose. Stripe returns `400` for many reasons, so only a `400` whose `param` is `starting_after` counts — any other `400` propagates as a real error rather than silently triggering a resync.

### Metrics: one source of truth

Status words live in exactly one place, [`src/core/status.ts`](src/core/status.ts), as an **allow-list**:

```ts
const COLLECTED_STATUSES = new Set(["paid", "succeeded", "completed"]);
```

An allow-list rather than an exclusion list means an unrecognized status returns `false` and fails closed — a new provider status can never be silently counted as revenue. `status_raw` is stored verbatim from the provider and no other module interprets it. The SQL filter binds its placeholders from this same set, so the words are never spelled a second time in a query.

`computeRevenue()` is the only place revenue is computed, and both endpoints call it. The query returns per-day, per-currency sums only — there is no total in the SQL. The summary total is derived in code as the sum of the daily buckets, so the two endpoints are structurally incapable of disagreeing. Revenue is grouped by currency and never summed across currencies.

---

## Tradeoffs & known limitations

- **Two of three sources implemented.** Google Calendar and Stripe are complete. HubSpot would follow the identical `SourceAdapter` pattern with no changes to the runner, upsert path, or schema — the pipeline is source-agnostic by construction. Deferred for time, not for any structural reason.
- **Sync is synchronous.** `POST /sync` runs the job inline and returns the summary. At scale this belongs in a queued background job with the endpoint returning a job id.
- **Stripe incremental cursor direction.** Stripe lists newest-first, and `starting_after` paginates toward *older* records. Brand-new payments are therefore not surfaced by a later incremental run; a scheduled full sync covers them. Surfacing them incrementally would use `ending_before` with a newest-id watermark, or a `created` timestamp cursor.
- **No FX conversion.** Revenue is reported per-currency and never consolidated. Cross-currency summation is deliberately impossible in `computeRevenue`.
- **No rate limiting or retry-with-backoff** on outbound provider calls. Unnecessary at this data volume; production would add exponential backoff on `429` responses.
- **Full result sets are held in memory.** Each adapter drains all pages in one call. Fine for sample data; production would stream and checkpoint pages.
- **Webhooks not implemented.** They would land through the same `upsert.ts` with signature verification, requiring no changes to the write path.

---

## Testing

10 tests across three suites, run against a real Postgres database.

```bash
npm test
```

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/upsert.test.ts` | 3 | Idempotency: the same record twice yields one row; a newer version updates in place; a stale version does not overwrite newer data |
| `tests/runner.test.ts` | 3 | Reactive backfill on `StaleCursorError`; fatal-error isolation between sources with the cursor preserved; per-record skip-and-log |
| `tests/revenue.test.ts` | 4 | Reconciliation over random ranges, no cross-currency summation, non-allow-list statuses contribute zero, status classification |

The reconciliation test is property-based: over 25 random date ranges it asserts that for every currency the summary total equals the sum of the breakdown buckets, and independently compares the SQL result against an expectation computed in TypeScript from the fixtures. A divergent second computation would fail immediately.

Test data is namespaced by `source_id` prefix and, for the runner suite, by fake source names, so suites cannot interfere with each other or with real sync state.

---

## AI usage

This project was built using Claude. I used the Claude chat interface to design and lock the architecture (documented in [CLAUDE.md](CLAUDE.md)), then used Claude Code (the CLI in VS Code) as the builder — implementing the project module by module against that spec, reviewing and pushing back on each piece before committing. The incremental commit history reflects this review-as-you-go workflow.

Key decisions I directed and reviewed:

- Idempotency via a composite natural key plus `content_hash` and a `source_updated_at` ordering guard, so duplicates are impossible and out-of-order updates never overwrite newer data.
- The stale-vs-fatal fallback distinction: a stale cursor triggers a full backfill, while a fatal error leaves the cursor intact and does not, so an outage is never mistaken for a resync.
- Metrics as an allow-list (not an exclusion list) with a single `computeRevenue` function backing both endpoints, so summary and breakdown cannot diverge.
- Per-currency revenue with no cross-currency summation.

---

## Sources & references

- [Stripe Node SDK](https://github.com/stripe/stripe-node) — [PaymentIntents list API](https://docs.stripe.com/api/payment_intents/list), [pagination](https://docs.stripe.com/api/pagination)
- [googleapis](https://github.com/googleapis/google-api-nodejs-client) — [Calendar API `events.list`](https://developers.google.com/calendar/api/v3/reference/events/list), [incremental sync](https://developers.google.com/calendar/api/guides/sync)
- [Neon](https://neon.tech/docs) — serverless Postgres
- [Render](https://render.com/docs) — deployment
