export type Source = 'hubspot' | 'gcal' | 'stripe';

export type RecordType = 'contact' | 'event' | 'payment';

export interface NormalizedRecord {
  source: Source;
  source_id: string;
  record_type: RecordType;
  occurred_at: string | null; // ISO 8601
  status_raw: string | null; // verbatim from provider
  amount_cents: number | null;
  currency: string | null; // ISO 4217, lowercased
  data: Record<string, unknown>; // full normalized payload
  source_updated_at: string | null; // ISO 8601, provider last-modified
}
