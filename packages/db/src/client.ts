import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

let shared: ReturnType<typeof createDb> | undefined;

/** Process-wide connection pool. */
export function getDb(): Db {
  shared ??= createDb();
  return shared.db;
}

export async function closeDb() {
  await shared?.close();
  shared = undefined;
}
