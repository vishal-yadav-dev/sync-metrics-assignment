import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  NormalizedRecord,
  RecordType,
  Source,
} from "../src/core/normalized";
import { db } from "../src/db/client";
import {
  type FetchResult,
  type SourceAdapter,
  StaleCursorError,
} from "../src/sources/types";
import { advanceCursor, type CursorRow, readCursor } from "../src/sync/cursor";
import { runSync } from "../src/sync/runner";

const PREFIX = "vitest-runner-";

// sync_cursors.source is plain text; only the TS union restricts it to real providers.
// Fake names keep the suite off the real gcal/event and stripe/payment cursor rows.
const asSource = (name: string): Source => name as Source;

const FAKE_GCAL = {
  source: asSource("test-gcal"),
  record_type: "event" as RecordType,
};
const FAKE_STRIPE = {
  source: asSource("test-stripe"),
  record_type: "payment" as RecordType,
};

interface FakeBehaviour {
  incremental?: () => Promise<FetchResult>;
  full?: () => Promise<FetchResult>;
}

class FakeAdapter implements SourceAdapter {
  readonly cursor_kind = "token" as const;
  incrementalCalls = 0;
  fullCalls = 0;

  constructor(
    readonly source: Source,
    readonly record_type: RecordType,
    private readonly behaviour: FakeBehaviour,
  ) {}

  async fetchIncremental(_cursor: string | null): Promise<FetchResult> {
    this.incrementalCalls += 1;
    if (!this.behaviour.incremental)
      throw new Error("incremental unconfigured");
    return this.behaviour.incremental();
  }

  async fetchFull(_cursor: string | null): Promise<FetchResult> {
    this.fullCalls += 1;
    if (!this.behaviour.full) throw new Error("full unconfigured");
    return this.behaviour.full();
  }
}

function rec(
  key: { source: Source; record_type: RecordType },
  id: string,
  overrides: Partial<NormalizedRecord> = {},
): NormalizedRecord {
  return {
    ...key,
    source_id: `${PREFIX}${id}`,
    occurred_at: "2026-07-01T00:00:00.000Z",
    status_raw: "confirmed",
    amount_cents: null,
    currency: null,
    data: { id },
    source_updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

async function storedIds(): Promise<string[]> {
  const rows = await db<{ source_id: string }>("synced_records")
    .where("source_id", "like", `${PREFIX}%`)
    .orderBy("source_id")
    .select("source_id");
  return rows.map((r) => r.source_id);
}

async function cleanup(): Promise<void> {
  await db("synced_records").where("source_id", "like", `${PREFIX}%`).del();
  await db("sync_cursors")
    .whereIn("source", [FAKE_GCAL.source, FAKE_STRIPE.source])
    .del();
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.destroy();
});

describe("runSync", () => {
  it("falls back to a full backfill when the cursor is stale", async () => {
    // Captured inside fetchFull, which runs after invalidateCursor — the only moment the
    // cleared cursor is observable, since stampFullSync overwrites it straight after.
    const duringBackfill: (CursorRow | null)[] = [];

    await advanceCursor(FAKE_GCAL, "token", "expired-token");

    const adapter = new FakeAdapter(FAKE_GCAL.source, FAKE_GCAL.record_type, {
      incremental: () => {
        throw new StaleCursorError(
          FAKE_GCAL.source,
          "syncToken expired (410 Gone)",
        );
      },
      full: async () => {
        duringBackfill.push(await readCursor(FAKE_GCAL));
        return {
          records: [rec(FAKE_GCAL, "full-1"), rec(FAKE_GCAL, "full-2")],
          next_cursor: "fresh-token",
        };
      },
    });

    const [summary] = await runSync([{ adapter, mode: "incremental" }]);

    expect(summary).toMatchObject({
      source: FAKE_GCAL.source,
      mode: "full",
      status: "stale",
      inserted: 2,
      updated: 0,
      skipped: 0,
      errors: 0,
    });

    expect(duringBackfill[0]?.cursor_value).toBeNull();
    expect(duringBackfill[0]?.last_status).toBe("stale");

    expect(adapter.fullCalls).toBe(1);
    expect(await storedIds()).toEqual([`${PREFIX}full-1`, `${PREFIX}full-2`]);

    const after = await readCursor(FAKE_GCAL);
    expect(after?.cursor_value).toBe("fresh-token");
    expect(after?.last_full_sync_at).not.toBeNull();
  });

  it("isolates a fatal source failure from a healthy source", async () => {
    await advanceCursor(FAKE_STRIPE, "token", "keep-me");

    const failing = new FakeAdapter(
      FAKE_STRIPE.source,
      FAKE_STRIPE.record_type,
      {
        incremental: () => {
          throw new Error("provider 500");
        },
        full: async () => ({
          records: [rec(FAKE_STRIPE, "never")],
          next_cursor: "x",
        }),
      },
    );

    const healthy = new FakeAdapter(FAKE_GCAL.source, FAKE_GCAL.record_type, {
      incremental: async () => ({
        records: [rec(FAKE_GCAL, "ok-1"), rec(FAKE_GCAL, "ok-2")],
        next_cursor: "gcal-token",
      }),
    });

    const summaries = await runSync([
      { adapter: failing, mode: "incremental" },
      { adapter: healthy, mode: "incremental" },
    ]);

    const stripeRun = summaries.find((s) => s.source === FAKE_STRIPE.source);
    const gcalRun = summaries.find((s) => s.source === FAKE_GCAL.source);

    expect(stripeRun).toMatchObject({
      status: "error",
      mode: "incremental",
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      error: "provider 500",
    });
    expect(gcalRun).toMatchObject({ status: "ok", inserted: 2, errors: 0 });

    // No backfill on a non-stale failure: that would mask an outage as a resync.
    expect(failing.fullCalls).toBe(0);

    // Cursor survives so the next run retries from the same point.
    const stripeCursor = await readCursor(FAKE_STRIPE);
    expect(stripeCursor?.cursor_value).toBe("keep-me");
    expect(stripeCursor?.last_status).toBe("error");

    // The healthy source ran to completion regardless.
    expect(await storedIds()).toEqual([`${PREFIX}ok-1`, `${PREFIX}ok-2`]);
    expect((await readCursor(FAKE_GCAL))?.cursor_value).toBe("gcal-token");
  });

  it("skips a single unwritable record without aborting its batch", async () => {
    const adapter = new FakeAdapter(FAKE_GCAL.source, FAKE_GCAL.record_type, {
      incremental: async () => ({
        records: [
          rec(FAKE_GCAL, "good-1"),
          // Postgres rejects this timestamptz, so the write throws for this row only.
          rec(FAKE_GCAL, "bad", { occurred_at: "not-a-timestamp" }),
          rec(FAKE_GCAL, "good-2"),
        ],
        next_cursor: "tok",
      }),
    });

    const [summary] = await runSync([{ adapter, mode: "incremental" }]);

    expect(summary).toMatchObject({
      status: "ok",
      mode: "incremental",
      inserted: 2,
      errors: 1,
    });
    expect(await storedIds()).toEqual([`${PREFIX}good-1`, `${PREFIX}good-2`]);
  });
});
