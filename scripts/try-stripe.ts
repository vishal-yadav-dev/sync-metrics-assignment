// Smoke test: usage `npx tsx scripts/try-stripe.ts`
import { StripeAdapter } from "../src/sources/stripe/adapter";

async function main(): Promise<void> {
  const result = await new StripeAdapter().fetchFull(null);

  console.log(`records:     ${result.records.length}`);
  console.log(`next_cursor: ${result.next_cursor ?? "null"}`);
  console.log("\nfirst normalized record:");
  console.log(JSON.stringify(result.records[0] ?? null, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
