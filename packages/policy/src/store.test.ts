import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, grants, policies, users } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import { allowedAccounts, can } from './store';
import { strictPersonalPolicies } from './presets';

let t: Awaited<ReturnType<typeof createTestDb>>;
let userId: string;
let otherUserId: string;
let work: string;
let personal: string;
let jira: string;

beforeAll(async () => {
  t = await createTestDb();
  const [u, o] = await t.db
    .insert(users)
    .values([{ email: 'me@example.com' }, { email: 'other@example.com' }])
    .returning();
  userId = u!.id;
  otherUserId = o!.id;
  const rows = await t.db
    .insert(accounts)
    .values([
      {
        userId,
        provider: 'gmail',
        nickname: 'Work',
        color: '#1F6F6B',
        externalId: 'me@company.com',
      },
      {
        userId,
        provider: 'gmail',
        nickname: 'Personal',
        color: '#3B5BA9',
        externalId: 'me@gmail.com',
        isPersonal: true,
      },
      {
        userId,
        provider: 'atlassian',
        nickname: 'Company',
        color: '#1F6F6B',
        externalId: 'company.atlassian.net',
      },
    ])
    .returning();
  [work, personal, jira] = rows.map((r) => r.id) as [string, string, string];
  await t.db
    .insert(policies)
    .values(strictPersonalPolicies(personal).map((r) => ({ ...r, userId })));
  // Claude Code: no Gmail unless granted.
  await t.db.insert(policies).values({
    userId,
    principal: 'mcp:claude-code',
    provider: 'gmail',
    resource: 'email',
    level: 'none',
  });
});

afterAll(async () => {
  await t.drop();
});

const code = () => ({ kind: 'mcp' as const, userId, clientId: 'claude-code' });

describe('can() against the database', () => {
  it('lets Claude Code read Jira but not Gmail', async () => {
    expect((await can(t.db, code(), jira, 'tickets', 'read')).allow).toBe(true);
    expect((await can(t.db, code(), work, 'email', 'read')).allow).toBe(false);
    expect((await can(t.db, code(), personal, 'email', 'read')).allow).toBe(false);
  });

  it('honours a temporary grant, then stops when it is revoked', async () => {
    const [g] = await t.db
      .insert(grants)
      .values({
        userId,
        principal: 'mcp:claude-code',
        accountId: work,
        scope: 'email',
        level: 'read',
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    expect(await can(t.db, code(), work, 'email', 'read')).toMatchObject({
      allow: true,
      source: 'grant',
    });
    const { eq } = await import('drizzle-orm');
    await t.db.update(grants).set({ revokedAt: new Date() }).where(eq(grants.id, g!.id));
    expect((await can(t.db, code(), work, 'email', 'read')).allow).toBe(false);
  });

  it('never allows access to another user’s account', async () => {
    const intruder = { kind: 'mcp' as const, userId: otherUserId, clientId: 'claude-code' };
    expect((await can(t.db, intruder, jira, 'tickets', 'read')).allow).toBe(false);
  });

  it('denies agents while paused', async () => {
    const { eq } = await import('drizzle-orm');
    await t.db.update(users).set({ paused: true }).where(eq(users.id, userId));
    expect(
      (await can(t.db, { kind: 'agent', userId, name: 'triage' }, work, 'email', 'read')).allow,
    ).toBe(false);
    await t.db.update(users).set({ paused: false }).where(eq(users.id, userId));
    expect(
      (await can(t.db, { kind: 'agent', userId, name: 'triage' }, work, 'email', 'read')).allow,
    ).toBe(true);
  });

  it('lists only the accounts a principal may read', async () => {
    const allowed = await allowedAccounts(t.db, code(), 'tickets', 'read');
    expect(allowed.map((a) => a.accountId)).toEqual([jira]);
    const email = await allowedAccounts(t.db, code(), 'email', 'read');
    expect(email).toEqual([]);
  });
});
