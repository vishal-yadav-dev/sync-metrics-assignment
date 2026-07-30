import { collectedStatuses } from "../core/status";
import { db } from "../db/client";

export interface DayRevenue {
  date: string; // 'YYYY-MM-DD' (UTC)
  total_cents: number;
}

export interface CurrencyRevenue {
  currency: string;
  total_cents: number;
  by_day: DayRevenue[];
}

export interface DateRange {
  from: string;
  to: string;
}

// A bare 'YYYY-MM-DD' means the whole day, so `to` covers through 23:59:59.999Z. Passing a
// full ISO timestamp bypasses this and is used verbatim.
function normalize(range: DateRange): { from: string; to: string } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  return {
    from: dateOnly.test(range.from)
      ? `${range.from}T00:00:00.000Z`
      : range.from,
    to: dateOnly.test(range.to) ? `${range.to}T23:59:59.999Z` : range.to,
  };
}

interface Bucket {
  currency: string;
  date: string;
  total_cents: string; // bigint sum arrives as a string from pg
}

// The ONLY place revenue is computed. Both endpoints call this.
// total_cents is DEFINED as sum(by_day) per currency — there is no second code path.
// Never sums across currencies: no FX conversion, per-currency reporting only.
export async function computeRevenue(
  range: DateRange,
): Promise<CurrencyRevenue[]> {
  const { from, to } = normalize(range);

  // Status words come from core/status.ts; only their placeholders appear in this query.
  const statuses = collectedStatuses();
  const placeholders = statuses.map(() => "?").join(", ");

  const result = await db.raw<{ rows: Bucket[] }>(
    `
    select
      currency,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') as date,
      sum(amount_cents) as total_cents
    from synced_records
    where record_type = 'payment'
      and amount_cents is not null
      and currency is not null
      and lower(status_raw) in (${placeholders})
      and occurred_at >= ?
      and occurred_at <= ?
    group by 1, 2
    order by 1, 2
    `,
    [...statuses, from, to],
  );
  const rows = result.rows;

  const byCurrency = new Map<string, DayRevenue[]>();
  for (const row of rows) {
    const days = byCurrency.get(row.currency) ?? [];
    // Number() is safe here: cents stay well inside 2^53 for any realistic total.
    days.push({ date: row.date, total_cents: Number(row.total_cents) });
    byCurrency.set(row.currency, days);
  }

  return [...byCurrency].map(([currency, by_day]) => ({
    currency,
    total_cents: by_day.reduce((sum, day) => sum + day.total_cents, 0),
    by_day,
  }));
}
