import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accounts, items, people, pushTokens, users, type Db } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import type { Logger } from '@hub/server';
import type { NotifierJob } from '@hub/shared/queues';
import { processNotification, type NotifierDeps } from './notify';
import { isQuietHours, msUntilQuietEnd } from './quiet';

describe('quiet hours', () => {
  const qh = { start: '22:00', end: '07:00' };
  it.each([
    ['2026-09-28T16:29:00Z', 'Asia/Kolkata', false], // 21:59 IST
    ['2026-09-28T16:30:00Z', 'Asia/Kolkata', true], // 22:00 IST
    ['2026-09-28T20:00:00Z', 'Asia/Kolkata', true], // 01:30 IST, after midnight
    ['2026-09-29T01:29:00Z', 'Asia/Kolkata', true], // 06:59 IST
    ['2026-09-29T01:30:00Z', 'Asia/Kolkata', false], // 07:00 IST
    ['2026-09-29T03:00:00Z', 'America/New_York', true], // 23:00 EDT
    ['2026-09-29T03:00:00Z', 'Europe/London', true], // 04:00 BST
    ['2026-09-29T03:00:00Z', 'Asia/Tokyo', false], // 12:00 JST
  ])('%s in %s → %s', (iso, tz, quiet) => {
    expect(isQuietHours(new Date(iso), tz, qh)).toBe(quiet);
  });

  it('handles windows that do not cross midnight and empty windows', () => {
    expect(
      isQuietHours(new Date('2026-09-28T13:00:00Z'), 'UTC', { start: '12:00', end: '14:00' }),
    ).toBe(true);
    expect(
      isQuietHours(new Date('2026-09-28T15:00:00Z'), 'UTC', { start: '12:00', end: '14:00' }),
    ).toBe(false);
    expect(
      isQuietHours(new Date('2026-09-28T15:00:00Z'), 'UTC', { start: '09:00', end: '09:00' }),
    ).toBe(false);
  });

  it('computes the delay until quiet hours end across midnight', () => {
    // 23:30 UTC → 07:00 UTC is 7h30m.
    expect(msUntilQuietEnd(new Date('2026-09-28T23:30:00Z'), 'UTC', qh)).toBe(7.5 * 3600_000);
    // 01:30 IST → 07:00 IST is 5h30m.
    expect(msUntilQuietEnd(new Date('2026-09-28T20:00:00Z'), 'Asia/Kolkata', qh)).toBe(
      5.5 * 3600_000,
    );
    expect(msUntilQuietEnd(new Date('2026-09-28T12:00:00Z'), 'UTC', qh)).toBe(0);
  });
});

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => t?.drop());

let userId: string;
let sent: ExpoPushMessage[][];
let tickets: (m: ExpoPushMessage[]) => ExpoPushTicket[];
let claimed: Set<string>;
let deferred: { data: NotifierJob; opts: { jobId: string; delay: number } }[];
let logs: unknown[][];
let now: Date;

function deps(fake = false): NotifierDeps {
  const log = {
    info: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
  } as unknown as Logger;
  return {
    db,
    push: fake
      ? null
      : {
          send: async (m) => {
            sent.push(m);
            return tickets(m);
          },
        },
    dedupe: {
      claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)),
      release: async (k) => {
        claimed.delete(k);
      },
    },
    enqueue: async (_q, data, opts) => {
      deferred.push({ data, opts });
    },
    now: () => now,
    log,
  };
}

const job = (over: Partial<NotifierJob> = {}): NotifierJob => ({
  userId,
  kind: 'approval',
  title: 'Draft ready',
  body: 'Reply to Meera: Q3 deck timeline',
  data: { proposalId: 'p1' },
  dedupeKey: `proposal:${randomBytes(4).toString('hex')}`,
  ...over,
});

beforeEach(async () => {
  sent = [];
  claimed = new Set();
  deferred = [];
  logs = [];
  tickets = (m) => m.map(() => ({ status: 'ok', id: 'r' }));
  now = new Date('2026-09-28T06:00:00Z'); // 11:30 IST, outside quiet hours
  const [u] = await db
    .insert(users)
    .values({
      email: `u${randomBytes(4).toString('hex')}@test.dev`,
      timezone: 'Asia/Kolkata',
      settings: { notificationsEnabled: true, vips: ['boss@acme.com'] },
    })
    .returning();
  userId = u!.id;
  await db.insert(pushTokens).values([
    { userId, token: `ExponentPushToken[${randomBytes(6).toString('hex')}]`, platform: 'ios' },
    { userId, token: `ExponentPushToken[${randomBytes(6).toString('hex')}]`, platform: 'android' },
  ]);
});

async function itemFrom(address: string) {
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      provider: 'gmail',
      nickname: 'W',
      color: '#1F6F6B',
      externalId: `me${randomBytes(3).toString('hex')}@w.dev`,
    })
    .returning();
  const [it] = await db
    .insert(items)
    .values({
      accountId: a!.id,
      kind: 'email',
      externalId: randomBytes(4).toString('hex'),
      authorAddress: address,
      receivedAt: now,
    })
    .returning();
  return it!.id;
}

describe('processNotification', () => {
  it('sends to every token with deep-link data', async () => {
    const out = await processNotification(deps(), job());
    expect(out).toMatchObject({ status: 'sent', tokens: 2, removed: 0 });
    expect(sent[0]).toHaveLength(2);
    expect(sent[0]![0]).toMatchObject({
      title: 'Draft ready',
      priority: 'high',
      data: { kind: 'approval', proposalId: 'p1' },
    });
  });

  it('dedupes retries so nobody is notified twice', async () => {
    const j = job();
    await processNotification(deps(), j);
    expect(await processNotification(deps(), j)).toEqual({ status: 'duplicate' });
    expect(sent).toHaveLength(1);
  });

  it('releases the dedupe claim when sending fails, so the retry sends', async () => {
    const j = job();
    const d = deps();
    const failing = { ...d, push: { send: async () => Promise.reject(new Error('expo down')) } };
    await expect(processNotification(failing, j)).rejects.toThrow('expo down');
    expect((await processNotification(d, j)).status).toBe('sent');
  });

  it('dedupes per device: a retry after a partial failure reaches only the rest', async () => {
    const j = job();
    let calls = 0;
    const d = deps();
    const flaky: NotifierDeps = {
      ...d,
      chunkSize: 1,
      push: {
        send: async (m) => {
          calls++;
          if (calls === 2) throw new Error('expo down mid-batch');
          sent.push(m);
          return tickets(m);
        },
      },
    };
    await expect(processNotification(flaky, j)).rejects.toThrow('expo down');
    expect(sent.flat()).toHaveLength(1);
    const first = sent.flat()[0]!.to;

    // The BullMQ retry: only the device that did not get it is notified.
    const out = await processNotification({ ...d, chunkSize: 1 }, j);
    expect(out).toMatchObject({ status: 'sent', tokens: 1 });
    const all = sent.flat().map((m) => m.to);
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(2);
    expect(all[0]).toBe(first);
    expect(await processNotification(d, j)).toEqual({ status: 'duplicate' });
    expect(sent.flat()).toHaveLength(2);
  });

  it('a device registered after the first send still gets it once', async () => {
    const j = job();
    await processNotification(deps(), j);
    const tok = `ExponentPushToken[${randomBytes(6).toString('hex')}]`;
    await db.insert(pushTokens).values({ userId, token: tok, platform: 'ios' });
    const again = await processNotification(deps(), j);
    expect(again).toMatchObject({ status: 'sent', tokens: 1 });
    expect(sent.at(-1)!.map((m) => m.to)).toEqual([tok]);
  });

  it('honours notificationsEnabled', async () => {
    await db
      .update(users)
      .set({ settings: { notificationsEnabled: false } })
      .where(eq(users.id, userId));
    expect(await processNotification(deps(), job())).toEqual({ status: 'disabled' });
    expect(sent).toHaveLength(0);
  });

  it('defers non-VIP notifications during quiet hours until they end', async () => {
    now = new Date('2026-09-28T20:00:00Z'); // 01:30 IST
    const j = job({ kind: 'task', title: 'New task', data: { taskId: 't1' } });
    const out = await processNotification(deps(), j);
    expect(out).toEqual({ status: 'deferred', delayMs: 5.5 * 3600_000 });
    expect(sent).toHaveLength(0);
    expect(deferred[0]!.opts.delay).toBe(5.5 * 3600_000);
    expect(deferred[0]!.opts.jobId).not.toContain(':');

    // The deferred copy goes out when it runs, without internal flags in the payload.
    now = new Date('2026-09-29T01:30:00Z');
    const again = await processNotification(deps(), deferred[0]!.data);
    expect(again.status).toBe('sent');
    expect(sent[0]![0]!.data).toEqual({ kind: 'task', taskId: 't1' });
  });

  it('lets VIP through during quiet hours and upgrades VIP tasks', async () => {
    now = new Date('2026-09-28T20:00:00Z');
    expect((await processNotification(deps(), job({ kind: 'vip' }))).status).toBe('sent');

    const itemId = await itemFrom('Boss@Acme.com');
    const out = await processNotification(
      deps(),
      job({ kind: 'task', data: { taskId: 't', itemId } }),
    );
    expect(out).toMatchObject({ status: 'sent', kind: 'vip' });

    const pid = await itemFrom('pal@acme.com');
    await db.insert(people).values({ userId, name: 'Pal', emails: ['pal@acme.com'], isVip: true });
    expect(
      await processNotification(deps(), job({ kind: 'task', data: { itemId: pid } })),
    ).toMatchObject({ kind: 'vip' });

    const other = await itemFrom('rando@acme.com');
    expect(
      (await processNotification(deps(), job({ kind: 'task', data: { itemId: other } }))).status,
    ).toBe('deferred');
  });

  it('deletes tokens reported DeviceNotRegistered', async () => {
    tickets = (m) => [
      { status: 'ok', id: 'r' },
      {
        status: 'error',
        message: 'gone',
        details: { error: 'DeviceNotRegistered', expoPushToken: String(m[1]!.to) },
      },
    ];
    const out = await processNotification(deps(), job());
    expect(out).toMatchObject({ status: 'sent', removed: 1 });
    expect(await db.select().from(pushTokens).where(eq(pushTokens.userId, userId))).toHaveLength(1);
  });

  it('PUSH_FAKE logs the title only, never the body', async () => {
    const out = await processNotification(deps(true), job({ body: 'SECRET message text' }));
    expect(out).toEqual({ status: 'sent_fake', tokens: 2, kind: 'approval' });
    expect(JSON.stringify(logs)).toContain('Draft ready');
    expect(JSON.stringify(logs)).not.toContain('SECRET');
  });

  it('no tokens → nothing to do', async () => {
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    expect(await processNotification(deps(), job())).toEqual({ status: 'no_tokens' });
  });
});
