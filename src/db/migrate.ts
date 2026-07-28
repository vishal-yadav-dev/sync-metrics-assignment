import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './client';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function migrate(): Promise<void> {
  try {
    await db.raw(`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const rows = await db<{ filename: string }>('schema_migrations').select('filename');
    const applied = new Set(rows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip   ${file}`);
        continue;
      }

      // Postgres DDL is transactional, so a failed migration leaves nothing behind.
      await db.transaction(async (trx) => {
        await trx.raw(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        await trx('schema_migrations').insert({ filename: file });
      });
      console.log(`apply  ${file}`);
    }
  } finally {
    await db.destroy();
  }
}

migrate().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
