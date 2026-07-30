create table synced_records (
  idempotency_key   text primary key,        -- generated: hash(source:record_type:source_id)
  source            text not null,           -- 'hubspot' | 'gcal' | 'stripe'
  source_id         text not null,           -- provider's own object id
  record_type       text not null,           -- 'contact' | 'event' | 'payment'

  occurred_at       timestamptz,             -- business-relevant timestamp
  status_raw        text,                    -- provider's original status word, UNTOUCHED
  amount_cents      bigint,                  -- null for non-payment records
  currency          text,                    -- ISO 4217, lowercased; null if no amount
  data              jsonb not null,          -- full normalized payload

  source_updated_at timestamptz,             -- provider last-modified; ordering guard
  content_hash      text not null,           -- hash of normalized payload
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()  -- last MODIFICATION, not last sighting
);

create unique index synced_records_natural_key
  on synced_records (source, source_id, record_type);
create index synced_records_type_time  on synced_records (record_type, occurred_at);
create index synced_records_revenue    on synced_records (record_type, currency, occurred_at);
create index synced_records_status     on synced_records (status_raw);

