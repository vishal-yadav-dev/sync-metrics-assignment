import type Stripe from "stripe";
import type { NormalizedRecord } from "../../core/normalized";

// Expandable fields arrive as either an id string or the full object.
function refId(ref: string | { id: string } | null | undefined): string | null {
  if (ref == null) return null;
  return typeof ref === "string" ? ref : ref.id;
}

// Throws on an unusable payload; the caller catches per-record and skips-and-logs.
export function mapPaymentIntent(intent: Stripe.PaymentIntent): NormalizedRecord {
  if (!intent.id) throw new Error("stripe payment intent has no id");

  // PaymentIntents carry no updated timestamp, so created serves as the ordering guard too.
  const created = new Date(intent.created * 1000).toISOString();

  return {
    source: "stripe",
    source_id: intent.id,
    record_type: "payment",
    occurred_at: created,
    status_raw: intent.status, // verbatim; only core/status.ts may judge it
    amount_cents: intent.amount,
    currency: intent.currency.toLowerCase(),
    source_updated_at: created,
    // Keys are always present (null, never undefined) so JSON.stringify cannot drop one
    // and shift content_hash for what is really the same payment.
    data: {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      amount_received: intent.amount_received ?? null,
      amount_capturable: intent.amount_capturable ?? null,
      currency: intent.currency.toLowerCase(),
      description: intent.description ?? null,
      customer: refId(intent.customer),
      payment_method: refId(intent.payment_method),
      payment_method_types: intent.payment_method_types ?? [],
      capture_method: intent.capture_method ?? null,
      livemode: intent.livemode,
      created,
      canceled_at:
        intent.canceled_at == null
          ? null
          : new Date(intent.canceled_at * 1000).toISOString(),
      cancellation_reason: intent.cancellation_reason ?? null,
      last_payment_error_code: intent.last_payment_error?.code ?? null,
    },
  };
}
