import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedRecord } from "../src/core/normalized";
import { isCollected } from "../src/core/status";
import { db } from "../src/db/client";
import { computeRevenue } from "../src/metrics/revenue";
import { upsertRecord } from "../src/sync/upsert";

const PREFIX = "vitest-revenue-";

// Seeded in 2031 so rows from the other suites (all dated 2026) can never fall inside a
// queried range, even when vitest runs the files in parallel.
interface Fixture {
  id: string;
  day: string;
  currency: string;
  amount: number;
  status: string;
}

const FIXTURES: Fixture[] = [
  {
    id: "a",
    day: "2031-03-01",
    currency: "usd",
    amount: 1000,
    status: "succeeded",
  },
  { id: "b", day: "2031-03-01", currency: "usd", amount: 500, status: "paid" },
  {
    id: "c",
    day: "2031-03-02",
    currency: "usd",
    amount: 2500,
    status: "completed",
  },
  {
    id: "d",
    day: "2031-03-05",
    currency: "usd",
    amount: 750,
    status: "SUCCEEDED",
  },
  {
    id: "e",
    day: "2031-03-01",
    currency: "eur",
    amount: 700,
    status: "succeeded",
  },
  {
    id: "f",
    day: "2031-03-03",
    currency: "eur",
    amount: 300,
    status: "succeeded",
  },
  // Not on the allow-list: must contribute zero everywhere.
  {
    id: "x",
    day: "2031-03-02",
    currency: "usd",
    amount: 99999,
    status: "requires_payment_method",
  },
  {
    id: "y",
    day: "2031-03-03",
    currency: "usd",
    amount: 88888,
    status: "failed",
  },
  {
    id: "z",
    day: "2031-03-04",
    currency: "eur",
    amount: 77777,
    status: "canceled",
  },
];

const DAYS = [
  "2031-02-27",
  "2031-02-28",
  "2031-03-01",
  "2031-03-02",
  "2031-03-03",
  "2031-03-04",
  "2031-03-05",
  "2031-03-06",
  "2031-03-07",
];

function toRecord(f: Fixture): NormalizedRecord {
  return {
    source: "stripe",
    source_id: `${PREFIX}${f.id}`,
    record_type: "payment",
    occurred_at: `${f.day}T12:00:00.000Z`,
    status_raw: f.status,
    amount_cents: f.amount,
    currency: f.currency,
    data: { id: f.id },
    source_updated_at: `${f.day}T12:00:00.000Z`,
  };
}

// Independent expectation built in JS from the fixtures, so the SQL is checked against
// something that shares no code with it beyond isCollected.
function expected(from: string, to: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const f of FIXTURES) {
    if (f.day < from || f.day > to) {
      continue;
    }
    if (!isCollected(f.status)) {
      continue;
    }
    const days = out.get(f.currency) ?? new Map<string, number>();
    days.set(f.day, (days.get(f.day) ?? 0) + f.amount);
    out.set(f.currency, days);
  }
  return out;
}

async function cleanup(): Promise<void> {
  await db("synced_records").where("source_id", "like", `${PREFIX}%`).del();
}

beforeAll(async () => {
  await cleanup();
  for (const f of FIXTURES) await upsertRecord(toRecord(f));
});

afterAll(async () => {
  await cleanup();
  await db.destroy();
});

describe("computeRevenue", () => {
  it("reconciles summary totals against breakdown buckets for random ranges", async () => {
    for (let i = 0; i < 25; i += 1) {
      const a = DAYS[Math.floor(Math.random() * DAYS.length)] as string;
      const b = DAYS[Math.floor(Math.random() * DAYS.length)] as string;
      const [from, to] = a <= b ? [a, b] : [b, a];

      const revenue = await computeRevenue({ from, to });

      for (const currency of revenue) {
        // The invariant that breaks loudly if anyone adds a separate SUM query.
        const summed = currency.by_day.reduce((s, d) => s + d.total_cents, 0);
        expect(
          summed,
          `total_cents != sum(by_day) for ${currency.currency} in ${from}..${to}`,
        ).toBe(currency.total_cents);
      }

      const want = expected(from, to);
      expect(
        new Set(revenue.map((c) => c.currency)),
        `currencies for ${from}..${to}`,
      ).toEqual(new Set(want.keys()));

      for (const currency of revenue) {
        const wantDays = want.get(currency.currency);
        expect(
          Object.fromEntries(
            currency.by_day.map((d) => [d.date, d.total_cents]),
          ),
          `by_day for ${currency.currency} in ${from}..${to}`,
        ).toEqual(Object.fromEntries(wantDays ?? []));
      }
    }
  });

  it("never sums across currencies", async () => {
    const revenue = await computeRevenue({
      from: "2031-03-01",
      to: "2031-03-05",
    });
    const usd = revenue.find((c) => c.currency === "usd");
    const eur = revenue.find((c) => c.currency === "eur");

    expect(usd?.total_cents).toBe(1000 + 500 + 2500 + 750);
    expect(eur?.total_cents).toBe(700 + 300);
    expect(revenue).toHaveLength(2);
  });

  it("gives non-allow-list statuses zero weight", async () => {
    // 2031-03-04 holds only a 'canceled' eur row, so the whole day must be absent.
    expect(
      await computeRevenue({ from: "2031-03-04", to: "2031-03-04" }),
    ).toEqual([]);

    // 2031-03-02 mixes a 'completed' 2500 with a 'requires_payment_method' 99999.
    const mixed = await computeRevenue({
      from: "2031-03-02",
      to: "2031-03-02",
    });
    expect(mixed).toEqual([
      {
        currency: "usd",
        total_cents: 2500,
        by_day: [{ date: "2031-03-02", total_cents: 2500 }],
      },
    ]);
  });

  it("classifies each status word stored by this suite", async () => {
    // Scoped to this suite's rows: a global enumeration would depend on whether the other
    // suites' rows exist yet, which is a race when vitest runs files in parallel.
    const rows = await db<{ status_raw: string | null }>("synced_records")
      .distinct("status_raw")
      .where("source_id", "like", `${PREFIX}%`)
      .whereNotNull("status_raw");

    const stored = rows
      .map((r) => r.status_raw)
      .filter((s): s is string => s !== null);

    expect(new Set(stored.filter(isCollected))).toEqual(
      new Set(["succeeded", "paid", "completed", "SUCCEEDED"]),
    );
    expect(new Set(stored.filter((s) => !isCollected(s)))).toEqual(
      new Set(["requires_payment_method", "failed", "canceled"]),
    );
  });
});
