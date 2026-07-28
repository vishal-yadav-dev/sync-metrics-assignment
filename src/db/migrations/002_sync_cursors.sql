create table sync_cursors (
  source            text not null,
  record_type       text not null,
  cursor_value      text,                    -- opaque: timestamp | syncToken | object_id
  cursor_kind       text not null,           -- 'timestamp' | 'token' | 'object_id'
  last_full_sync_at timestamptz,             -- drives proactive 24h backfill
  last_run_at       timestamptz,
  last_status       text,                    -- 'ok' | 'stale' | 'error'
  primary key (source, record_type)
);
