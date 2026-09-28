import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './testing';
import { audit } from './audit';
import { auditLog, users } from './schema';

let t: Awaited<ReturnType<typeof createTestDb>>;
let userId: string;

beforeAll(async () => {
  t = await createTestDb();
  const [u] = await t.db.insert(users).values({ email: 'a@example.com' }).returning();
  userId = u!.id;
});
afterAll(() => t.drop());

describe('audit_log', () => {
  it('accepts inserts', async () => {
    await audit(t.db, { userId, principal: 'agent:triage', action: 'item.read', target: 'item:1' });
    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
  });

  it('rejects updates', async () => {
    await expect(t.db.update(auditLog).set({ action: 'tampered' })).rejects.toThrow();
  });

  it('rejects deletes outside the delete-everything job', async () => {
    await expect(t.db.delete(auditLog)).rejects.toThrow();
  });

  it('allows deletes when the job sets the session flag', async () => {
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL hub.allow_audit_delete = 'on'`);
      await tx.delete(auditLog);
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
