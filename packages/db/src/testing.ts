import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb } from './client';
import { migrate } from './migrate';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://hub:hub@localhost:5434/hub';

/**
 * Creates a throwaway, fully migrated database for one test file.
 * Call `drop()` in afterAll.
 */
export async function createTestDb() {
  const name = `hub_test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const handle = createDb(url.toString(), { max: 5 });
  return {
    ...handle,
    url: url.toString(),
    async drop() {
      await handle.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    },
  };
}
