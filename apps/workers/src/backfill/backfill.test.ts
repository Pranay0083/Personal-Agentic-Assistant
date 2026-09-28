import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accounts, items, subscriptions } from '@hub/db';
import { BackfillJob, QUEUES } from '@hub/shared/queues';
import { createHarness, PERSONAL, WORK, type Harness } from '../lib/testing';
import { BACKFILL_TRIAGE_PRIORITY, runBackfill } from './index';

let h: Harness;

beforeAll(async () => {
  // Small pages so the 4 seeded work messages span two pages.
  h = await createHarness({ backfillPageSize: 2 });
  h.store.appendMessage(WORK, {
    from: 'old@x.example',
    subject: 'Three weeks old',
    body: 'old',
    date: new Date(Date.now() - 21 * 86400_000),
  });
});
afterAll(async () => {
  await h.drop();
});
beforeEach(() => {
  h.jobs.length = 0;
  h.live.length = 0;
});

const status = async (id: string) =>
  (await h.db.select().from(accounts).where(eq(accounts.id, id)))[0]!.status;

/** Runs a backfill and every page it enqueues. */
async function drain(job: BackfillJob) {
  let pages = 0;
  const queue: BackfillJob[] = [job];
  while (queue.length) {
    const next = queue.shift()!;
    const before = h.jobs.length;
    await runBackfill(h.deps, next);
    pages++;
    for (const j of h.jobs.slice(before))
      if (j.name === QUEUES.backfill) queue.push(BackfillJob.parse(j.data));
  }
  return pages;
}

describe('backfill worker', () => {
  it('pages through the window, importing → live, triage at lower priority', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK, { status: 'connecting' });

    const first = await runBackfill(h.deps, { accountId: a.id, days: 7 });
    expect(first).toMatchObject({ status: 'page', inserted: 2 });
    expect(await status(a.id)).toBe('importing');
    expect(
      await h.db.select().from(subscriptions).where(eq(subscriptions.accountId, a.id)),
    ).toHaveLength(1);
    const next = h.jobsFor(QUEUES.backfill);
    expect(next).toHaveLength(1);
    expect(next[0]!.data).toMatchObject({
      accountId: a.id,
      days: 7,
      pageToken: expect.any(String),
    });
    expect(String(next[0]!.opts.jobId)).toMatch(/^backfill-/);

    const second = await runBackfill(h.deps, BackfillJob.parse(next[0]!.data));
    expect(second).toMatchObject({ status: 'page', inserted: 2, nextPageToken: null });
    expect(await status(a.id)).toBe('live');

    const rows = await h.db.select().from(items).where(eq(items.accountId, a.id));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.title)).not.toContain('Three weeks old');
    const triage = h.jobsFor(QUEUES.agents);
    expect(triage).toHaveLength(4);
    expect(triage.every((j) => j.opts.priority === BACKFILL_TRIAGE_PRIORITY)).toBe(true);
    expect(h.live.filter((l) => l.event.type === 'account.updated')).toHaveLength(2);
  });

  it('honours a longer window', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK);
    await drain({ accountId: a.id, days: 30 });
    const rows = await h.db.select().from(items).where(eq(items.accountId, a.id));
    expect(rows.map((r) => r.title)).toContain('Three weeks old');
    expect(rows).toHaveLength(5);
  });

  it('applies filters: promotions and social excluded by default', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, PERSONAL);
    await drain({ accountId: a.id, days: 7 });
    const rows = await h.db.select().from(items).where(eq(items.accountId, a.id));
    expect(rows.map((r) => r.title)).toEqual(['Dinner Saturday?']);
  });

  it('is idempotent: a second backfill adds no items and no triage jobs', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK);
    await drain({ accountId: a.id, days: 7 });
    h.jobs.length = 0;
    await drain({ accountId: a.id, days: 7 });
    expect(await h.db.select().from(items).where(eq(items.accountId, a.id))).toHaveLength(4);
    expect(h.jobsFor(QUEUES.agents)).toHaveLength(0);
  });

  it('marks reconnect when the token is revoked', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, PERSONAL);
    h.store.setRevoked(PERSONAL, true);
    try {
      expect(await runBackfill(h.deps, { accountId: a.id, days: 7 })).toEqual({
        status: 'reconnect',
      });
    } finally {
      h.store.setRevoked(PERSONAL, false);
    }
    expect(await status(a.id)).toBe('reconnect');
  });
});
