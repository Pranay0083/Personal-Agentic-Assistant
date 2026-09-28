import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, inArray } from 'drizzle-orm';
import {
  accessRequests,
  accounts,
  auditLog,
  briefs,
  itemBodies,
  items,
  subscriptions,
} from '@hub/db';
import { itemBodyContext, seal } from '@hub/server/secrets';
import { QUEUES } from '@hub/shared/queues';
import { createHarness, PERSONAL, WORK, type Harness } from '../lib/testing';
import {
  catchupSync,
  dailyBriefs,
  expireGrants,
  localClock,
  purgeExpiredBodies,
  renewSubscriptions,
  runSchedulerTask,
  SCHEDULES,
} from './index';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.drop();
});
beforeEach(() => {
  h.jobs.length = 0;
  h.live.length = 0;
  h.setNow(null);
});

describe('renew-subscriptions', () => {
  it('renews watches expiring within 48h, subscribes live accounts without one, keeps cursors', async () => {
    const user = await h.createUser();
    const expiring = await h.connectAccount(user.id, WORK, { syncCursor: '1000' });
    const missing = await h.connectAccount(user.id, PERSONAL);
    const u2 = await h.createUser();
    const fresh = await h.connectAccount(u2.id, WORK, { syncCursor: '1000' });
    const paused = await h.connectAccount(u2.id, PERSONAL, { status: 'paused' });
    const soon = new Date(Date.now() + 24 * 3600_000);
    const later = new Date(Date.now() + 5 * 86400_000);
    await h.db.insert(subscriptions).values([
      { accountId: expiring.id, kind: 'gmail.watch', expiresAt: soon },
      { accountId: fresh.id, kind: 'gmail.watch', expiresAt: later },
    ]);

    const r = await renewSubscriptions(h.deps);
    expect(r).toEqual({ renewed: 1, subscribed: 1, reconnect: 0, failed: 0, unchanged: 1 });

    const subs = await h.db.select().from(subscriptions);
    const exp = (id: string) => subs.find((s) => s.accountId === id)?.expiresAt?.getTime() ?? 0;
    expect(exp(expiring.id)).toBeGreaterThan(Date.now() + 6 * 86400_000);
    expect(exp(missing.id)).toBeGreaterThan(Date.now() + 6 * 86400_000);
    expect(exp(fresh.id)).toBe(later.getTime());
    expect(subs.find((s) => s.accountId === paused.id)).toBeUndefined();

    const rows = await h.db.select().from(accounts);
    expect(rows.find((a) => a.id === expiring.id)!.syncCursor).toBe('1000');
    expect(rows.find((a) => a.id === missing.id)!.syncCursor).toBe(
      String(h.store.mailbox(PERSONAL)!.historyId),
    );
  });

  it('marks accounts with revoked tokens as reconnect', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, PERSONAL);
    h.store.setRevoked(PERSONAL, true);
    try {
      const r = await renewSubscriptions(h.deps);
      expect(r.reconnect).toBeGreaterThanOrEqual(1);
    } finally {
      h.store.setRevoked(PERSONAL, false);
    }
    expect((await h.db.select().from(accounts).where(eq(accounts.id, a.id)))[0]!.status).toBe(
      'reconnect',
    );
  });
});

describe('catchup-sync', () => {
  it('enqueues one catch-up sync per live account per slot', async () => {
    const live = (await h.db.select().from(accounts)).filter((a) => a.status === 'live');
    h.setNow(new Date('2026-09-28T10:07:00Z'));
    const r = await catchupSync(h.deps);
    expect(r.enqueued).toBe(live.length);
    const jobs = h.jobsFor(QUEUES.sync);
    expect(
      jobs
        .map((j) => j.data)
        .sort((a, b) => String(a.accountId).localeCompare(String(b.accountId))),
    ).toEqual(
      live
        .map((a) => ({ accountId: a.id, reason: 'catchup' }))
        .sort((a, b) => a.accountId.localeCompare(b.accountId)),
    );
    const slot = Math.floor(new Date('2026-09-28T10:07:00Z').getTime() / 900_000);
    expect(jobs[0]!.opts.jobId).toMatch(new RegExp(`^catchup-[0-9a-f-]+-${slot}$`));
  });
});

describe('daily-briefs', () => {
  it('enqueues a brief once local time passes briefTime, per user timezone', async () => {
    // 02:10 UTC = 07:40 in Kolkata (+05:30), 22:10 previous day in New York.
    const now = new Date('2026-09-29T02:10:00Z');
    h.setNow(now);
    const india = await h.createUser(undefined, {
      timezone: 'Asia/Kolkata',
      settings: { briefTime: '07:30' },
    });
    const ny = await h.createUser(undefined, {
      timezone: 'America/New_York',
      settings: { briefTime: '07:30' },
    });
    const early = await h.createUser(undefined, {
      timezone: 'Asia/Kolkata',
      settings: { briefTime: '08:00' },
    });
    const paused = await h.createUser(undefined, { timezone: 'Asia/Kolkata', paused: true });
    const done = await h.createUser(undefined, { timezone: 'Asia/Kolkata' });
    await h.db.insert(briefs).values({ userId: done.id, date: '2026-09-29', headline: 'h' });
    const badTz = await h.createUser(undefined, {
      timezone: 'Not/AZone',
      settings: { briefTime: '02:00' },
    });

    await dailyBriefs(h.deps);
    const jobs = h.jobsFor(QUEUES.agents);
    const byUser = new Map(jobs.map((j) => [j.data.userId, j]));
    expect(byUser.get(india.id)!.data).toEqual({
      agent: 'brief',
      userId: india.id,
      date: '2026-09-29',
    });
    expect(byUser.get(india.id)!.opts.jobId).toBe(`brief:${india.id}:2026-09-29`);
    expect(byUser.get(badTz.id)!.data.date).toBe('2026-09-29');
    for (const u of [ny, early, paused, done]) expect(byUser.has(u.id)).toBe(false);
  });

  it('computes local clocks', () => {
    expect(localClock(new Date('2026-09-29T02:10:00Z'), 'Asia/Kolkata')).toEqual({
      date: '2026-09-29',
      minutes: 460,
    });
    expect(localClock(new Date('2026-09-29T02:10:00Z'), 'America/New_York')).toEqual({
      date: '2026-09-28',
      minutes: 22 * 60 + 10,
    });
  });
});

describe('expire-grants', () => {
  it('expires pending access requests older than 24h only', async () => {
    const user = await h.createUser();
    const old = new Date(Date.now() - 25 * 3600_000);
    const [a, b, c] = await h.db
      .insert(accessRequests)
      .values([
        { userId: user.id, principal: 'mcp:claude-code', resource: 'email', createdAt: old },
        { userId: user.id, principal: 'mcp:claude-code', resource: 'email' },
        {
          userId: user.id,
          principal: 'mcp:claude-code',
          resource: 'email',
          createdAt: old,
          status: 'approved',
        },
      ])
      .returning();
    expect(await expireGrants(h.deps)).toEqual({ expired: 1 });
    const rows = await h.db.select().from(accessRequests);
    const st = (id: string) => rows.find((r) => r.id === id)!.status;
    expect([st(a!.id), st(b!.id), st(c!.id)]).toEqual(['expired', 'pending', 'approved']);
  });
});

describe('purge-expired-bodies', () => {
  it('is scheduled daily', () => {
    expect(SCHEDULES.find((x) => x.id === 'purge-expired-bodies')?.repeat.pattern).toMatch(
      /^\d+ \d+ \* \* \*$/,
    );
  });

  it('deletes expired bodies in batches, clears body_ref, audits counts per user', async () => {
    const now = new Date('2026-09-28T03:43:00Z');
    h.setNow(now);
    const past = new Date(now.getTime() - 3600_000);
    const future = new Date(now.getTime() + 86400_000);
    const u1 = await h.createUser();
    const u2 = await h.createUser();
    const a1 = await h.connectAccount(u1.id, WORK);
    const a2 = await h.connectAccount(u2.id, WORK);

    const addItem = async (accountId: string, expiresAt: Date | null, n: number) => {
      const env = await seal(h.keys, `Body ${n} SECRET`, itemBodyContext(accountId));
      const [b] = await h.db
        .insert(itemBodies)
        .values({ accountId, ...env, expiresAt })
        .returning();
      const [it] = await h.db
        .insert(items)
        .values({
          accountId,
          kind: 'email',
          externalId: `purge-${accountId}-${n}`,
          bodyRef: b!.id,
          receivedAt: now,
        })
        .returning();
      return { itemId: it!.id, bodyId: b!.id };
    };
    const expired1 = await Promise.all([0, 1, 2, 3, 4].map((n) => addItem(a1.id, past, n)));
    const expired2 = await addItem(a2.id, past, 9);
    const kept = await addItem(a1.id, future, 10);
    const noExpiry = await addItem(a2.id, null, 11);

    const out = await purgeExpiredBodies(h.deps, { batchSize: 2 });
    expect(out).toMatchObject({ deleted: 6, users: 2 });
    expect(out.batches).toBeGreaterThanOrEqual(3);

    const bodyIds = [...expired1, expired2, kept, noExpiry].map((x) => x.bodyId);
    const left = await h.db.select().from(itemBodies).where(inArray(itemBodies.id, bodyIds));
    expect(left.map((b) => b.id).sort()).toEqual([kept.bodyId, noExpiry.bodyId].sort());
    const refs = await h.db
      .select({ id: items.id, bodyRef: items.bodyRef })
      .from(items)
      .where(
        inArray(
          items.id,
          [...expired1, expired2, kept].map((x) => x.itemId),
        ),
      );
    for (const r of refs) {
      expect(r.bodyRef).toBe(r.id === kept.itemId ? kept.bodyId : null);
    }

    const audits = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'retention.bodies_purged'),
          inArray(auditLog.userId, [u1.id, u2.id]),
        ),
      );
    expect(audits.map((a) => [a.userId, a.details]).sort()).toEqual(
      [
        [u1.id, { deleted: 5 }],
        [u2.id, { deleted: 1 }],
      ].sort(),
    );
    expect(JSON.stringify(audits)).not.toContain('SECRET');

    // Nothing left to do: a second run is a no-op and writes no audit rows.
    expect(await runSchedulerTask(h.deps, { task: 'purge-expired-bodies' })).toMatchObject({
      deleted: 0,
      users: 0,
    });
  });
});
