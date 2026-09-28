import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MissingScopeError,
  RetryableError,
  type Connector,
  type OAuthTokens,
} from '@hub/connectors';
import { accounts, auditLog, events, itemBodies, items, subscriptions } from '@hub/db';
import { itemBodyContext, open } from '@hub/server/secrets';
import { QUEUES } from '@hub/shared/queues';
import {
  createHarness,
  fakeTwoSourceConnector,
  PERSONAL,
  WORK,
  type Harness,
} from '../lib/testing';
import { lockKey, MAX_DELTA_PAGES, runSync } from './index';

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
const sourceOf = async (accountId: string, kind = 'mail') =>
  (
    await h.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.kind, kind)))
  )[0];
const cursorOf = async (accountId: string, kind = 'mail') =>
  (await sourceOf(accountId, kind))?.cursor ?? null;

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
    expect(await cursorOf(work.id)).toBe(String(h.store.mailbox(WORK)!.historyId));
    // The deprecated account column is left alone.
    expect((await accountRow(work.id)).syncCursor).toBeNull();
    const subs = await h.db.select().from(subscriptions);
    expect(subs.map((s) => [s.accountId, s.kind]).sort()).toEqual(
      [
        [work.id, 'mail'],
        [personal.id, 'mail'],
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
    await h.db
      .update(subscriptions)
      .set({ cursor: before })
      .where(and(eq(subscriptions.accountId, work.id), eq(subscriptions.kind, 'mail')));
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
    expect(await cursorOf(a.id)).toBe(String(h.store.mailbox(WORK)!.historyId));
    expect(h.jobsFor(QUEUES.backfill).map((j) => j.data)).toEqual([
      { accountId: a.id, days: 7, source: 'mail' },
    ]);
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

describe('sync worker: Gmail rows migrated to the mail source', () => {
  it("uses the migrated row's cursor and watch instead of subscribing again", async () => {
    const user = await h.createUser();
    const a = await h.connectAccount(user.id, WORK);
    const cursor = String(h.store.mailbox(WORK)!.historyId);
    // What migration 0002 leaves behind: the old watch renamed to `mail`, carrying the cursor.
    await h.db.insert(subscriptions).values({
      accountId: a.id,
      kind: 'mail',
      externalSubId: 'projects/hub-fake/topics/gmail',
      expiresAt: new Date(Date.now() + 5 * 86400_000),
      cursor,
    });
    h.store.appendMessage(WORK, { from: 'm@x.example', subject: 'After migration', body: 'x' });
    const r = await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
    expect(r).toMatchObject({ status: 'ok', inserted: 1 });
    expect((await itemsOf(a.id)).map((i) => i.title)).toEqual(['After migration']);
    const row = await sourceOf(a.id);
    expect(row!.cursor).toBe(String(h.store.mailbox(WORK)!.historyId));
    expect(row!.meta).toEqual({});
  });
});

describe('sync worker: multi-source connector', () => {
  const fake = fakeTwoSourceConnector();
  beforeAll(() => h.addConnector(fake.connector));

  const newAccount = async (extra = {}) => {
    const user = await h.createUser();
    return h.addAccount(user.id, 'microsoft', `ms-${Math.random().toString(36).slice(2)}`, extra);
  };
  const titles = async (accountId: string) =>
    (await itemsOf(accountId)).map((i) => [i.kind, i.title]).sort();

  it('keeps an independent cursor and subscription per source', async () => {
    const a = await newAccount();
    expect(await runSync(h.deps, { accountId: a.id, reason: 'manual' })).toMatchObject({
      status: 'ok',
      inserted: 0,
    });
    const mail = (await sourceOf(a.id, 'mail'))!;
    const files = (await sourceOf(a.id, 'files'))!;
    expect(mail.externalSubId).toMatch(/^sub-/);
    expect(mail.expiresAt).not.toBeNull();
    expect(mail.meta).toMatchObject({ secretHash: 'a'.repeat(64) });
    // No push for files: the row only holds the cursor.
    expect(files).toMatchObject({ externalSubId: null, expiresAt: null, cursor: '0' });
    expect(files.meta).toHaveProperty('subscribedAt');
    // Default-off sources get no row.
    expect(await sourceOf(a.id, 'extra')).toBeUndefined();

    fake.add(a.externalId, 'mail', 'm1');
    fake.add(a.externalId, 'mail', 'm2');
    fake.add(a.externalId, 'mail', 'm3');
    fake.add(a.externalId, 'files', 'f1');
    const filesCursor = await cursorOf(a.id, 'files');

    // A mail-only job pages through mail (hasMore) and leaves files untouched.
    const r = await runSync(h.deps, { accountId: a.id, source: 'mail', reason: 'webhook' });
    expect(r).toMatchObject({ status: 'ok', fetched: 3, inserted: 3 });
    expect(await titles(a.id)).toEqual([
      ['email', 'm1'],
      ['email', 'm2'],
      ['email', 'm3'],
    ]);
    expect(await cursorOf(a.id, 'files')).toBe(filesCursor);
    expect(fake.callsFor(a.id, 'fetchDelta').filter((c) => c.source === 'mail')).toHaveLength(3);

    // An all-sources job picks up files; mail has nothing new.
    const all = await runSync(h.deps, { accountId: a.id, reason: 'catchup' });
    expect(all).toMatchObject({ status: 'ok', fetched: 1, inserted: 1 });
    expect(await titles(a.id)).toContainEqual(['file', 'f1']);
    expect(await cursorOf(a.id, 'files')).not.toBe(filesCursor);

    const audit = (
      await h.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.target, `account:${a.id}`))
    )
      .map((x) => x.details as { sources?: Record<string, unknown> })
      .filter((d) => d.sources);
    expect(Object.keys(audit.at(-1)!.sources!).sort()).toEqual(['files', 'mail']);
    // Items were normalized with their source.
    expect(
      (await itemsOf(a.id)).every((i) => (i.labels as string[])[0]!.startsWith('fake:source:')),
    ).toBe(true);
  });

  it('a disabled source is unsubscribed, marked disabled and no longer synced', async () => {
    const a = await newAccount();
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    await h.db
      .update(accounts)
      .set({ filters: { sources: { mail: false } } })
      .where(eq(accounts.id, a.id));
    fake.add(a.externalId, 'mail', 'hidden');
    fake.add(a.externalId, 'files', 'visible');

    const r = await runSync(h.deps, { accountId: a.id, reason: 'catchup' });
    expect(r).toMatchObject({ status: 'ok', inserted: 1 });
    expect(await titles(a.id)).toEqual([['file', 'visible']]);
    expect(fake.callsFor(a.id, 'unsubscribe')).toEqual([
      { op: 'unsubscribe', accountId: a.id, source: 'mail' },
    ]);
    const mail = (await sourceOf(a.id, 'mail'))!;
    expect(mail).toMatchObject({ enabled: false, externalSubId: null, expiresAt: null });
    expect(mail.meta).toEqual({});

    // A webhook for the disabled source does nothing, and unsubscribe isn't repeated.
    const before = fake.callsFor(a.id).length;
    await runSync(h.deps, { accountId: a.id, source: 'mail', reason: 'webhook' });
    expect(
      fake
        .callsFor(a.id)
        .slice(before)
        .map((c) => c.op),
    ).toEqual([]);

    // Turning it back on re-subscribes and resumes from the kept cursor.
    await h.db.update(accounts).set({ filters: {} }).where(eq(accounts.id, a.id));
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    expect(await sourceOf(a.id, 'mail')).toMatchObject({ enabled: true });
    expect((await sourceOf(a.id, 'mail'))!.externalSubId).toMatch(/^sub-/);
    expect(await titles(a.id)).toContainEqual(['email', 'hidden']);
  });

  it('a failing source does not block the others; the job still fails for a retry', async () => {
    const a = await newAccount();
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    fake.add(a.externalId, 'files', 'still here');
    fake.fail('mail');
    try {
      await expect(runSync(h.deps, { accountId: a.id, reason: 'webhook' })).rejects.toThrow(
        'fake source down',
      );
    } finally {
      fake.fail('mail', false);
    }
    expect(await titles(a.id)).toEqual([['file', 'still here']]);
    expect(h.lock.held.size).toBe(0);
  });

  it('a source job that finds the account flagged dirty syncs every source', async () => {
    const a = await newAccount();
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    fake.add(a.externalId, 'files', 'flagged');
    await h.lock.markDirty(lockKey(a.id));
    await runSync(h.deps, { accountId: a.id, source: 'mail', reason: 'webhook' });
    expect(await titles(a.id)).toEqual([['file', 'flagged']]);
  });

  it('bounds fetchDelta pages per run and finishes the rest in another run', async () => {
    const a = await newAccount();
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    const n = MAX_DELTA_PAGES * 2 + 3;
    for (let i = 0; i < n; i++) fake.add(a.externalId, 'mail', `bulk-${i}`);
    const r = await runSync(h.deps, { accountId: a.id, source: 'mail', reason: 'webhook' });
    expect(r).toMatchObject({ status: 'ok', runs: 2, inserted: n });
  });
});

describe('sync worker: ungranted source', () => {
  it('a source failing with MissingScopeError is skipped without failing the job', async () => {
    const fake = fakeTwoSourceConnector();
    h.addConnector({
      ...fake.connector,
      fetchDelta: async (ctx) => {
        if (ctx.source === 'files') throw new MissingScopeError('microsoft', ['Files.Read']);
        return fake.connector.fetchDelta(ctx);
      },
    });
    try {
      const user = await h.createUser();
      const a = await h.addAccount(user.id, 'microsoft', 'scope-ms-1');
      await runSync(h.deps, { accountId: a.id, reason: 'manual' });
      fake.add(a.externalId, 'mail', 'granted');
      const r = await runSync(h.deps, { accountId: a.id, reason: 'catchup' });
      expect(r).toMatchObject({ status: 'ok', inserted: 1 });
    } finally {
      h.addConnector(fake.connector);
    }
  });
});

describe('sync worker: changed items, reconnect and identity events', () => {
  const fake = fakeTwoSourceConnector();
  beforeAll(() => h.addConnector(fake.connector));
  const newAccount = async () => {
    const user = await h.createUser();
    return h.addAccount(user.id, 'microsoft', `chg-${Math.random().toString(36).slice(2)}`);
  };
  const addEvent = async (accountId: string, payload: Record<string, unknown>) =>
    (
      await h.db
        .insert(events)
        .values({
          accountId,
          provider: 'microsoft',
          providerEventId: `microsoft:${Math.random()}`,
          payload,
        })
        .returning()
    )[0]!;

  it('refreshes and re-triages an item only when its title, body or status changes', async () => {
    const a = await newAccount();
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    const rid = fake.add(a.externalId, 'mail', 'PR: add login');
    await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
    const [item] = await itemsOf(a.id);
    const firstBody = item!.bodyRef!;
    expect(h.jobsFor(QUEUES.agents).map((j) => j.opts.jobId)).toEqual([`triage:${item!.id}`]);

    // A non-status label change (read) is not a content change: no triage churn.
    h.jobs.length = 0;
    fake.edit(a.externalId, 'mail', rid, { read: true });
    expect(await runSync(h.deps, { accountId: a.id, reason: 'webhook' })).toMatchObject({
      updated: 1,
      changed: 0,
    });
    expect(h.jobsFor(QUEUES.agents)).toHaveLength(0);
    expect((await itemsOf(a.id))[0]!.labels).toContain('READ');

    // New title: refreshed, body re-sealed, item.updated, triage again under a new job id.
    fake.edit(a.externalId, 'mail', rid, { title: 'PR: add login (v2)' });
    expect(await runSync(h.deps, { accountId: a.id, reason: 'webhook' })).toMatchObject({
      changed: 1,
    });
    const [v2] = await itemsOf(a.id);
    expect(v2!.id).toBe(item!.id);
    expect(v2!.title).toBe('PR: add login (v2)');
    expect(v2!.bodyRef).not.toBe(firstBody);
    expect(await h.db.select().from(itemBodies).where(eq(itemBodies.id, firstBody))).toHaveLength(
      0,
    );
    expect(
      (
        await open(
          h.keys,
          (await h.db.select().from(itemBodies).where(eq(itemBodies.id, v2!.bodyRef!)))[0]!,
          itemBodyContext(a.id),
        )
      ).toString(),
    ).toBe('PR: add login (v2) (body)');
    const retriage = h.jobsFor(QUEUES.agents);
    expect(retriage).toHaveLength(1);
    expect(retriage[0]!.data).toEqual({ agent: 'triage', itemId: item!.id });
    expect(String(retriage[0]!.opts.jobId)).toMatch(new RegExp(`^triage-${item!.id}-[0-9a-f]{8}$`));
    expect(h.live).toContainEqual({
      userId: a.userId,
      event: { type: 'item.updated', itemId: item!.id },
    });

    // A status change counts too; replaying the same version does not.
    h.jobs.length = 0;
    fake.edit(a.externalId, 'mail', rid, { status: 'merged' });
    await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
    expect(h.jobsFor(QUEUES.agents)).toHaveLength(1);
    await h.db
      .update(subscriptions)
      .set({ cursor: '0' })
      .where(and(eq(subscriptions.accountId, a.id), eq(subscriptions.kind, 'mail')));
    h.jobs.length = 0;
    await runSync(h.deps, { accountId: a.id, reason: 'catchup' });
    expect(h.jobsFor(QUEUES.agents)).toHaveLength(0);
  });

  it('items stored before content hashing get a baseline, not a re-triage', async () => {
    const a = await newAccount();
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    const rid = fake.add(a.externalId, 'mail', 'Old item');
    await h.db.insert(items).values({
      accountId: a.id,
      kind: 'email',
      externalId: `mail:${rid}`,
      title: 'Old item, older title',
      labels: ['fake:source:mail'],
      receivedAt: new Date(),
    });
    h.jobs.length = 0;
    await runSync(h.deps, { accountId: a.id, reason: 'webhook' });
    expect(h.jobsFor(QUEUES.agents)).toHaveLength(0);
    const [row] = await itemsOf(a.id);
    expect((row!.labels as string[]).some((l) => l.startsWith('hub:content:'))).toBe(true);
  });

  it('payload.reconnect marks the account reconnect without calling the provider', async () => {
    const a = await newAccount();
    await runSync(h.deps, { accountId: a.id, reason: 'manual' });
    const ev = await addEvent(a.id, { reconnect: true, reason: 'tokens_revoked' });
    const before = fake.callsFor(a.id).length;
    const r = await runSync(h.deps, { accountId: a.id, eventId: ev.id, reason: 'webhook' });
    expect(r).toEqual({ status: 'reconnect' });
    expect(fake.callsFor(a.id).length).toBe(before);
    expect((await accountRow(a.id)).status).toBe('reconnect');
    expect((await h.db.select().from(events).where(eq(events.id, ev.id)))[0]!.status).toBe(
      'processed',
    );
    expect(h.live).toContainEqual({
      userId: a.userId,
      event: { type: 'account.updated', accountId: a.id },
    });
  });

  it.each([{ renew: true }, { resubscribe: true }, { lifecycle: 'expirationReminder' }])(
    'lifecycle payload %o renews push subscriptions now',
    async (payload) => {
      let renewed = 0;
      const withRenew: Connector = {
        ...fake.connector,
        renew: async (ctx) => {
          renewed++;
          return fake.connector.renew(ctx);
        },
      };
      h.addConnector(withRenew);
      try {
        const a = await newAccount();
        await runSync(h.deps, { accountId: a.id, reason: 'manual' });
        await h.db
          .update(subscriptions)
          .set({ externalSubId: 'sub-1' })
          .where(eq(subscriptions.accountId, a.id));
        const before = renewed;
        const ev = await addEvent(a.id, payload);
        await runSync(h.deps, { accountId: a.id, eventId: ev.id, reason: 'webhook' });
        expect(renewed).toBeGreaterThan(before);
        const [e] = await h.db.select().from(events).where(eq(events.id, ev.id));
        expect(e!.status).toBe('processed');
      } finally {
        h.addConnector(fake.connector);
      }
    },
  );

  it('payload.refreshRouteKeys refreshes route keys and meta through the connector', async () => {
    let calls = 0;
    const withRefresh: Connector = {
      ...fake.connector,
      refreshIdentity: async () => {
        calls++;
        return { routeKeys: ['inst-1', 'inst-2', 'inst-1'], meta: { needsInstall: false } };
      },
    };
    h.addConnector(withRefresh);
    try {
      const a = await newAccount();
      await h.db
        .update(accounts)
        .set({ routeKeys: ['inst-1'], meta: { needsInstall: true, login: 'alex' } })
        .where(eq(accounts.id, a.id));
      await runSync(h.deps, { accountId: a.id, reason: 'manual' });
      expect(calls).toBe(0);
      const ev = await addEvent(a.id, { refreshRouteKeys: true });
      await runSync(h.deps, { accountId: a.id, eventId: ev.id, reason: 'webhook' });
      expect(calls).toBe(1);
      const row = await accountRow(a.id);
      expect(row.routeKeys).toEqual(['inst-1', 'inst-2']);
      expect(row.meta).toEqual({ needsInstall: false, login: 'alex' });
      await runSync(h.deps, { accountId: a.id, reason: 'catchup' });
      expect(calls).toBe(1);
    } finally {
      h.addConnector(fake.connector);
    }
  });
});
