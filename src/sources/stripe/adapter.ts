import Stripe from "stripe";
import { env } from "../../config/env";
import type { NormalizedRecord } from "../../core/normalized";
import {
  type FetchResult,
  type SourceAdapter,
  StaleCursorError,
} from "../types";
import { mapPaymentIntent } from "./map";

const PAGE_SIZE = 100; // Stripe's maximum

// Only a 400 naming starting_after is cursor staleness; any other 400 is a real bug and
// must not be laundered into a resync.
function isInvalidStartingAfter(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeInvalidRequestError &&
    err.statusCode === 400 &&
    err.param === "starting_after"
  );
}

export class StripeAdapter implements SourceAdapter {
  readonly source = "stripe" as const;
  readonly record_type = "payment" as const;
  readonly cursor_kind = "object_id" as const;

  private stripe: Stripe | null = null;

  private client(): Stripe {
    this.stripe ??= new Stripe(env.STRIPE_SECRET_KEY);
    return this.stripe;
  }

  async fetchIncremental(cursor: string | null): Promise<FetchResult> {
    return this.drain(cursor);
  }

  // Full backfill starts from the top by contract, so any stored cursor is ignored.
  async fetchFull(_cursor: string | null): Promise<FetchResult> {
    return this.drain(null);
  }

  // Drains every page in one call, so next_cursor is always the resume point and the runner
  // never sees pagination. Sample data is small enough to hold in memory; a production
  // version against large accounts would stream and checkpoint pages.
  private async drain(startingAfter: string | null): Promise<FetchResult> {
    const stripe = this.client();
    const records: NormalizedRecord[] = [];
    let cursor = startingAfter;
    let hasMore = true;

    while (hasMore) {
      let page: Stripe.ApiList<Stripe.PaymentIntent>;
      try {
        page = await stripe.paymentIntents.list({
          limit: PAGE_SIZE,
          ...(cursor === null ? {} : { starting_after: cursor }),
        });
      } catch (err) {
        if (isInvalidStartingAfter(err)) {
          throw new StaleCursorError(
            "stripe",
            `starting_after ${cursor} rejected (400)`,
          );
        }
        throw err;
      }

      // Record-level isolation lives here because mapping happens at this layer: one
      // unmappable intent must not take down the whole page.
      for (const intent of page.data) {
        try {
          records.push(mapPaymentIntent(intent));
        } catch (err) {
          console.warn(
            `[stripe] skipped ${intent.id ?? "(no id)"}: ${(err as Error).message}`,
          );
        }
      }

      const last = page.data.at(-1);
      // Guard on `last` too: has_more with an empty page would otherwise spin forever.
      hasMore = page.has_more && last !== undefined;
      if (last !== undefined) cursor = last.id;
    }

    // Unchanged when nothing came back, so an empty run keeps the existing watermark.
    return { records, next_cursor: cursor };
  }
}
