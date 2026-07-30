// Smoke test: usage `npx tsx scripts/try-gcal.ts <calendarId>`
import { GcalAdapter } from "../src/sources/gcal/adapter";

const calendarId = process.argv[2] ?? "primary";

async function main(): Promise<void> {
  const result = await new GcalAdapter(calendarId).fetchFull(null);

  console.log(`calendar:    ${calendarId}`);
  console.log(`records:     ${result.records.length}`);
  console.log(
    `next_cursor: ${result.next_cursor === null ? "null" : `${result.next_cursor.slice(0, 20)}… (syncToken)`}`,
  );
  console.log("\nfirst normalized record:");
  console.log(JSON.stringify(result.records[0] ?? null, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
