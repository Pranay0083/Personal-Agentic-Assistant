import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RetryableError, type Connector, type OAuthTokens } from '@hub/connectors';
import { accounts, auditLog, events, itemBodies, items, subscriptions } from '@hub/db';
import { itemBodyContext, open } from '@hub/server/secrets';
import { QUEUES } from '@hub/shared/queues';
import { createHarness, PERSONAL, WORK, type Harness } from '../lib/testing';
import { lockKey, runSync } from './index';

const PERSONAL_ID = '00000000-0000-4000-8000-000000000999';

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
});

const itemsOf = (accountId: string) =>
  h.db.select().from(items).where(eq(items.accountId, accountId));
const accountRow = async (id: string) =>
  (await h.db.select().from(accounts).where(eq(accounts.id, id)))[0]!;

describe('sync worker', () => {
  it('syncs two Gmail accounts of one user, tagging each item with its account', async () => {
    const user = await h.createUser();
    const work = await h.connectAccount(user.id, WORK, { status: 'connecting' });
    const personal = await h.connectAccount(user.id, PERSONAL, { status: 'connecting' });

    // First sync: creates the watch and sets the starting cursor, imports nothing.
    for (const a of [work, personal]) {
      const r = await runSync(h.deps, { accountId: a.id, reason: 'manual' });
      expect(r).toMatchObject({ status: 'ok', inserted: 0 });
    }
    expect((await accountRow(work.id)).syncCursor).toBe(String(h.store.mailbox(WORK)!.historyId));
    const subs = await h.db.select().from(subscriptions);
    expect(subs.map((s) => [s.accountId, s.kind]).sort()).toEqual(
      [
        [work.id, 'gmail.watch'],
        [personal.id, 'gmail.watch'],
      ].sort(),
    );

    h.store.appendMessage(WORK, {
      from: 'priya@company.example',
      fromName: 'Priya',
      subject: 'Slides by Thursday?',
      body: 'Can you send the slides by Thursday?',
    });
    h.store.appendMessage(PERSONAL, {
      from: 'sam@gmail.example',
      subject: 'Dinner?',
      body: 'Saturday at 7?',
    });

    const [ev] = await h.db
      .insert(events)
      .values({
        accountId: work.id,
        provider: 'gmail',
        providerEventId: 'gmail:test-1',
        payload: {},
      })
      .returning();
    expect(
      await runSync(h.deps, { accountId: work.id, eventId: ev!.id, reason: 'webhook' }),
    ).toMatchObject({
      status: 'ok',
      inserted: 1,
    });
    expect(await runSync(h.deps, { accountId: personal.id, reason: 'webhook' })).toMatchObject({
      status: 'ok',
      inserted: 1,
    });

    const w = await itemsOf(work.id);
    const p = await itemsOf(personal.id);
    expect(w.map((i) => i.title)).toEqual(['Slides by Thursday?']);
    expect(p.map((i) => i.title)).toEqual(['Dinner?']);
    expect(w[0]!.authorAddress).toBe('priya@company.example');
    expect(w[0]!.url).toContain(encodeURIComponent(WORK));

    const triage = h.jobsFor(QUEUES.agents);
    expect(triage.map((j) => j.data)).toEqual([
      { agent: 'triage', itemId: w[0]!.id },
      { agent: 'triage', itemId: p[0]!.id },
    ]);
    expect(triage[0]!.opts.jobId).toBe(`triage:${w[0]!.id}`);
    expect(h.live.filter((l) => l.event.type === 'item.created').map((l) => l.event)).toEqual([
      { type: 'item.created', itemId: w[0]!.id, accountId: work.id },
      { type: 'item.created', itemId: p[0]!.id, accountId: personal.id },
    ]);
    expect(h.live.every((l) => l.userId === user.id)).toBe(true);

    const wa = await accountRow(work.id);
    expect(wa.status).toBe('live');
    expect(wa.lastSyncedAt).not.toBeNull();
    expect((await h.db.select().from(events).where(eq(events.id, ev!.id)))[0]!.status).toBe(
      'processed',
    );

    const audits = await h.db.select().from(auditLog).where(eq(auditLog.principal, 'system:sync'));
    expect(audits.length).toBeGreaterThanOrEqual(4);
    const last = audits.find(
      (a) =>
        a.target === `account:${work.id}` && (a.details as { inserted?: number }).inserted === 1,
    )!;
    expect(last.details).toMatchObject({
      outcome: 'ok',
      fetched: 1,
      inserted: 1,
      reason: 'webhook',
    });
    expect(JSON.stringify(audits)).not.toContain('Slides by Thursday');

    // Idempotent re-sync: replay history from the old cursor. No duplicates, no new triage.
    h.jobs.length = 0;
    const before = String(h.store.mailbox(WORK)!.historyId - 1);
    await h.db.update(accounts).set({ syncCursor: before }).where(eq(accounts.id, work.id));
    const again = await runSync(h.deps, { accountId: work.id, reason: 'catchup' });
    expect(again).toMatchObject({ status: 'ok', fetched: 1, inserted: 0, updated: 1 });
    expect(await itemsOf(work.id)).toHaveLength(1);
    expect(h.jobsFor(QUEUES.agents)).toHaveLength(0);
  });

  it('applies account filters (promotions off, sent toggle, labels)', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, PERSONAL, {
      filters: { sent: false, labels: ['Label_77'] },
    });
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    h.store.appendMessage(PERSONAL, {
      from: 'deals@shop.example',
      subject: 'Sale',
      body: 'x',
      labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
    });
    h.store.appendMessage(PERSONAL, {
      from: 'n@social.example',
      subject: 'Social',
      body: 'x',
      labelIds: ['INBOX', 'CATEGORY_SOCIAL'],
    });
    h.store.appendMessage(PERSONAL, {
      from: PERSONAL,
      subject: 'Sent',
      body: 'x',
      labelIds: ['SENT'],
    });
    h.store.appendMessage(PERSONAL, {
      from: 'c@client.example',
      subject: 'Clients label',
      body: 'x',
      labelIds: ['Label_77'],
    });
    h.store.appendMessage(PERSONAL, { from: 'f@x.example', subject: 'Inbox', body: 'x' });
    const r = await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
    expect(r).toMatchObject({ status: 'ok', fetched: 5, inserted: 2, skipped: 3 });
    expect((await itemsOf(a.id)).map((i) => i.title).sort()).toEqual(['Clients label', 'Inbox']);
  });

  it('encrypts bodies into item_bodies with 90-day expiry; no plaintext body in the DB', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK);
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    const marker = 'ZEBRA-7731-CONFIDENTIAL';
    const body = `${'Quarterly numbers follow. '.repeat(20)}The code word is ${marker}.`;
    h.store.appendMessage(WORK, { from: 'cfo@company.example', subject: 'Numbers', body });
    await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
    const [item] = await itemsOf(a.id);
    expect(item!.bodyRef).not.toBeNull();
    const [b] = await h.db.select().from(itemBodies).where(eq(itemBodies.id, item!.bodyRef!));
    expect(b!.accountId).toBe(a.id);
    const days = (b!.expiresAt!.getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
    expect((await open(h.keys, b!, itemBodyContext(a.id))).toString('utf8')).toBe(body);
    // Bound to the account: the same envelope does not open as another account's body.
    await expect(open(h.keys, b!, itemBodyContext(PERSONAL_ID))).rejects.toThrow();

    const dump = await h.db.execute(
      sql`select (select coalesce(json_agg(i), '[]') from items i)::text || (select coalesce(json_agg(b), '[]') from item_bodies b)::text || (select coalesce(json_agg(e), '[]') from events e)::text || (select coalesce(json_agg(l), '[]') from audit_log l)::text as all`,
    );
    const text = String((dump as unknown as { all: string }[])[0]!.all);
    // Positive control: the dump really contains the rows (title is stored in the clear).
    expect(text).toContain('"title":"Numbers"');
    expect(text).toContain(b!.ciphertext);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(
      'Quarterly numbers follow. Quarterly numbers follow. Quarterly numbers follow. Quarterly numbers follow. Quarterly numbers follow. Quarterly numbers follow.',
    );
  });

  it('404 history → cursor reset, status importing and a backfill job', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK, { backfillDays: 7 });
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    h.store.expireHistory(WORK);
    h.jobs.length = 0;
    const r = await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
    expect(r).toEqual({ status: 'resync', days: 7 });
    const row = await accountRow(a.id);
    expect(row.status).toBe('importing');
    expect(row.syncCursor).toBe(String(h.store.mailbox(WORK)!.historyId));
    expect(h.jobsFor(QUEUES.backfill).map((j) => j.data)).toEqual([{ accountId: a.id, days: 7 }]);
    expect(h.live.some((l) => l.event.type === 'account.updated')).toBe(true);
  });

  it('revoked token → status reconnect and account.updated, no retry', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, PERSONAL);
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    h.store.setRevoked(PERSONAL, true);
    try {
      expect(await runSync(h.deps, { accountId: a.id, reason: 'webhook' })).toEqual({
        status: 'reconnect',
      });
    } finally {
      h.store.setRevoked(PERSONAL, false);
    }
    expect((await accountRow(a.id)).status).toBe('reconnect');
    expect(h.live).toContainEqual({
      userId: user.id,
      event: { type: 'account.updated', accountId: a.id },
    });
    expect(h.lock.held.size).toBe(0);
  });

  it('re-encrypts refreshed tokens via saveTokens', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK);
    const old = await h.secrets.getJson<OAuthTokens>(a.tokenRef!);
    await h.secrets.replace(a.tokenRef!, JSON.stringify({ ...old, expiresAt: Date.now() - 1000 }));
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    const now = await h.secrets.getJson<OAuthTokens>(a.tokenRef!);
    expect(now.accessToken).not.toBe(old.accessToken);
    expect(now.refreshToken).toBe(old.refreshToken);
    expect(now.expiresAt).toBeGreaterThan(Date.now());
  });

  it('never loses a webhook that arrives mid-sync: the waiting job defers, the holder runs again', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK);
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    h.store.appendMessage(WORK, { from: 'a@x.example', subject: 'first', body: '1' });
    const real = h.gmail;
    let calls = 0;
    const wrapped: Connector = {
      ...real,
      fetchDelta: async (ctx) => {
        const res = await real.fetchDelta(ctx);
        if (calls++ === 0) {
          // A second email + webhook land after we read history but before we finish.
          h.store.appendMessage(WORK, { from: 'b@x.example', subject: 'second', body: '2' });
          expect(await runSync(h.deps, { accountId: a.id, reason: 'webhook' })).toEqual({
            status: 'deferred',
          });
        }
        return res;
      },
    };
    h.setConnector(wrapped);
    try {
      const r = await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
      expect(r).toMatchObject({ status: 'ok', runs: 2, inserted: 2 });
    } finally {
      h.setConnector(real);
    }
    expect((await itemsOf(a.id)).map((i) => i.title).sort()).toEqual(['first', 'second']);
    expect(h.lock.held.has(lockKey(a.id))).toBe(false);
  });

  it('retryable provider errors propagate (BullMQ backs off) and release the lock', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK);
    const real = h.gmail;
    h.setConnector({
      ...real,
      fetchDelta: async () => {
        throw new RetryableError('gmail', 'gmail responded 429', {
          status: 429,
          retryAfterMs: 1000,
        });
      },
    });
    try {
      await expect(runSync(h.deps, { accountId: a.id, reason: 'webhook' })).rejects.toBeInstanceOf(
        RetryableError,
      );
    } finally {
      h.setConnector(real);
    }
    expect(h.lock.held.size).toBe(0);
    expect((await accountRow(a.id)).status).toBe('live');
  });

  it('skips paused and disconnected accounts', async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK, { status: 'disconnected' });
    expect(await runSync(h.deps, { accountId: a.id, reason: 'webhook' })).toEqual({
      status: 'skipped',
      reason: 'status disconnected',
    });
  });
});
