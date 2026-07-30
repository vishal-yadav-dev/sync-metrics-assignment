import { type Request, type Response, Router } from "express";
import { db } from "../db/client";

// Shared by every route: without it a rejected handler falls through to Express's default
// HTML error page instead of JSON.
export function jsonErrors(
  handler: (req: Request, res: Response) => Promise<void>,
  message = "internal error",
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error("[http]", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  };
}

const RECENT_PER_SOURCE = 3;

interface GroupRow {
  source: string;
  record_type: string;
  count: number;
}

interface RecentRow {
  source: string;
  id: string;
  source_id: string;
  status_raw: string | null;
  occurred_at: Date | null;
}

export const recordsRouter = Router();

// Inventory endpoint: proves every source landed rows, including the ones that carry no
// revenue and so never appear in /metrics.
recordsRouter.get(
  "/",
  jsonErrors(async (_req, res) => {
    const groups = await db.raw<{ rows: GroupRow[] }>(`
      select source, record_type, count(*)::int as count
      from synced_records
      group by source, record_type
      order by source, record_type
    `);

    // Window function rather than N queries, so adding a fourth source costs nothing.
    const recent = await db.raw<{ rows: RecentRow[] }>(
      `
      select source, id, source_id, status_raw, occurred_at
      from (
        select
          source,
          idempotency_key as id,
          source_id,
          status_raw,
          occurred_at,
          row_number() over (
            partition by source
            order by occurred_at desc nulls last, first_seen_at desc
          ) as rn
        from synced_records
      ) ranked
      where rn <= ?
      order by source, rn
      `,
      [RECENT_PER_SOURCE],
    );

    const bySource = new Map<
      string,
      { record_types: { record_type: string; count: number }[]; total: number }
    >();

    for (const row of groups.rows) {
      const entry = bySource.get(row.source) ?? { record_types: [], total: 0 };
      entry.record_types.push({
        record_type: row.record_type,
        count: row.count,
      });
      entry.total += row.count;
      bySource.set(row.source, entry);
    }

    res.json({
      total_records: [...bySource.values()].reduce((s, e) => s + e.total, 0),
      by_source: [...bySource].map(([source, entry]) => ({
        source,
        total: entry.total,
        record_types: entry.record_types,
        recent: recent.rows
          .filter((r) => r.source === source)
          .map(({ id, source_id, status_raw, occurred_at }) => ({
            id,
            source_id,
            status_raw,
            occurred_at,
          })),
      })),
    });
  }, "failed to read records"),
);
