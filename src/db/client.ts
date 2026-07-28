import knexFactory, { type Knex } from 'knex';
import { env } from '../config/env';

// knex ignores sslmode in the connection string, so decide TLS here. Default is on:
// hosted Postgres requires it, and only localhost or an explicit sslmode=disable opts out.
const { hostname, searchParams } = new URL(env.DATABASE_URL);
const sslDisabled =
  searchParams.get('sslmode') === 'disable' || hostname === 'localhost' || hostname === '127.0.0.1';

export const db: Knex = knexFactory({
  client: 'pg',
  connection: {
    connectionString: env.DATABASE_URL,
    ...(sslDisabled ? {} : { ssl: { rejectUnauthorized: true } }),
  },
  pool: { min: 0, max: 10 },
});

// Anything that can run a query: the pool itself or a transaction handle.
export type Queryable = Knex | Knex.Transaction;
