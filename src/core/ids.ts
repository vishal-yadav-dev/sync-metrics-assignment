import { createHash } from "node:crypto";
import type { NormalizedRecord, RecordType, Source } from "./normalized";

// Unit separator: provider ids can contain colons, so a colon delimiter would be ambiguous.
const DELIM = "\x1f";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function idempotencyKey(
  source: Source,
  recordType: RecordType,
  sourceId: string,
): string {
  return sha256([source, recordType, sourceId].join(DELIM));
}

// Sorts object keys at every depth so two payloads differing only in key order hash alike.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(record: NormalizedRecord): string {
  return sha256(
    JSON.stringify(
      canonicalize({
        source: record.source,
        source_id: record.source_id,
        record_type: record.record_type,
        occurred_at: record.occurred_at,
        status_raw: record.status_raw,
        amount_cents: record.amount_cents,
        currency: record.currency,
        data: record.data,
      }),
    ),
  );
}
