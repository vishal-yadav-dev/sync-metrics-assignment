import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyKey } from '../src/core/ids';
import type { NormalizedRecord } from '../src/core/normalized';
import { db } from '../src/db/client';
import { upsertRecord } from '../src/sync/upsert';

const SOURCE_ID = 'vitest-upsert-pi_1';
const KEY = idempotencyKey('stripe', 'payment', SOURCE_ID);

function record(overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    source: 'stripe',
    source_id: SOURCE_ID,
    record_type: 'payment',
    occurred_at: '2026-07-01T00:00:00.000Z',
    status_raw: 'succeeded',
    amount_cents: 1000,
    currency: 'usd',
    data: { id: SOURCE_ID, status: 'succeeded' },
    source_updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

// Counts on the natural key, not the primary key, so a duplicate row would actually show up.
async function countRows(): Promise<number> {
  const [row] = await db('synced_records')
    .where({ source: 'stripe', source_id: SOURCE_ID, record_type: 'payment' })
    .count<{ count: string }[]>('* as count');
  return Number(row?.count ?? 0);
}

async function storedRow(): Promise<{ status_raw: string; amount_cents: string }> {
  const row = await db('synced_records')
    .where({ idempotency_key: KEY })
    .first<{ status_raw: string; amount_cents: string }>();
  if (row === undefined) throw new Error('expected a stored row');
  return row;
}

beforeEach(async () => {
  await db('synced_records').where({ idempotency_key: KEY }).del();
});

afterAll(async () => {
  await db('synced_records').where({ idempotency_key: KEY }).del();
  await db.destroy();
});

describe('upsertRecord', () => {
  it('collapses the same record upserted twice into one row', async () => {
    expect(await upsertRecord(record())).toBe('inserted');
    expect(await upsertRecord(record())).toBe('skipped');
    expect(await countRows()).toBe(1);
  });

  it('updates in place when a newer version arrives', async () => {
    await upsertRecord(record());

    const outcome = await upsertRecord(
      record({
        status_raw: 'refunded',
        amount_cents: 2000,
        data: { id: SOURCE_ID, status: 'refunded' },
        source_updated_at: '2026-07-02T00:00:00.000Z',
      }),
    );

    expect(outcome).toBe('updated');
    const row = await storedRow();
    expect(row.status_raw).toBe('refunded');
    expect(Number(row.amount_cents)).toBe(2000);
    expect(await countRows()).toBe(1);
  });

  it('does not let a stale version overwrite a newer one', async () => {
    await upsertRecord(record({ source_updated_at: '2026-07-02T00:00:00.000Z' }));

    const outcome = await upsertRecord(
      record({
        status_raw: 'pending',
        amount_cents: 500,
        data: { id: SOURCE_ID, status: 'pending' },
        source_updated_at: '2026-07-01T00:00:00.000Z', // older than what is stored
      }),
    );

    expect(outcome).toBe('skipped');
    const row = await storedRow();
    expect(row.status_raw).toBe('succeeded');
    expect(Number(row.amount_cents)).toBe(1000);
    expect(await countRows()).toBe(1);
  });
});
