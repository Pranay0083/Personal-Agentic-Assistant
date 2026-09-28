import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

export async function migrate(url = process.env.DATABASE_URL) {
  const { db, sql, close } = createDb(url, { max: 1 });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await drizzleMigrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
