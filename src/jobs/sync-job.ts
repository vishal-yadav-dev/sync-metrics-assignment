import { env } from "../config/env";
import { GcalAdapter } from "../sources/gcal/adapter";
import { StripeAdapter } from "../sources/stripe/adapter";
import { runSync, type SourceRunSummary } from "../sync/runner";

// A null stored cursor bootstraps a full drain on the first run, and a StaleCursorError
// still triggers the runner's reactive backfill.
export async function runSyncJob(): Promise<SourceRunSummary[]> {
  return runSync([
    { adapter: new GcalAdapter(env.GOOGLE_CALENDAR_ID), mode: "incremental" },
    { adapter: new StripeAdapter(), mode: "incremental" },
  ]);
}
