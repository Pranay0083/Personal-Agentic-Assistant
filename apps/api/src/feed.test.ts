import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, auditLog, briefs, itemBodies, items, proposals, tasks } from '@hub/db';
import { seal, itemBodyContext } from '@hub/server/secrets';
import { setup, type TestEnv } from './test-helpers';

let env: TestEnv;
let token: string;
let userId: string;
let auth: Record<string, string>;
let work: string;
let personal: string;

beforeAll(async () => {
  env = await setup();
  ({ token, userId, auth } = await env.signIn('feed@example.com'));
  work = (await env.connectGmail(token, 'feed@company.com')).accountId;
  personal = (await env.connectGmail(token, 'feed@gmail.com')).accountId;
  // 25 items across two accounts; several share a timestamp to exercise the id tiebreak.
  const base = new Date('2026-09-28T08:00:00.000Z').getTime();
  await env.t.db.insert(items).values(
    Array.from({ length: 25 }, (_, i) => ({
      accountId: i % 2 === 0 ? work : personal,
      kind: i % 5 === 0 ? 'event' : 'email',
      externalId: `m${i}`,
      title: `Message ${i}`,
      summary: i === 3 ? 'Quarterly budget review due Friday' : `summary ${i}`,
      bucket: i % 3 === 0 ? 'needs_you' : 'fyi',
      receivedAt: new Date(base - Math.floor(i / 3) * 60_000),
    })),
  );
});
afterAll(() => env.close());

type ItemsBody = {
  items: { id: string; accountId: string; kind: string; bucket: string }[];
  nextCursor: string | null;
  counts: { all: number; needsYou: number };
};

describe('items', () => {
  it('pages with a keyset cursor without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await env.app.inject({
        url: `/items?limit=7${cursor ? `&cursor=${cursor}` : ''}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ItemsBody;
      expect(body.counts).toEqual({ all: 25, needsYou: 9 });
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toHaveLength(25);
    expect((await env.app.inject({ url: '/items?cursor=garbage', headers: auth })).statusCode).toBe(
      400,
    );
  });

  it('filters by account, kind and bucket', async () => {
    const byAccount = (
      await env.app.inject({ url: `/items?accountId=${work}&limit=100`, headers: auth })
    ).json() as ItemsBody;
    expect(byAccount.items).toHaveLength(13);
    expect(byAccount.items.every((i) => i.accountId === work)).toBe(true);
    expect(byAccount.counts.all).toBe(13);

    const events = (
      await env.app.inject({ url: '/items?kind=event', headers: auth })
    ).json() as ItemsBody;
    expect(events.items).toHaveLength(5);
    expect(events.items.every((i) => i.kind === 'event')).toBe(true);

    const needs = (
      await env.app.inject({ url: '/items?bucket=needs_you&limit=100', headers: auth })
    ).json() as ItemsBody;
    expect(needs.items).toHaveLength(9);
    expect(needs.counts).toEqual({ all: 25, needsYou: 9 });

    expect((await env.app.inject({ url: '/items?kind=fax', headers: auth })).statusCode).toBe(400);
  });

  it('returns the decrypted body to the owner and audits item.read', async () => {
    const envelope = await seal(env.keys, 'Hello, the full body', itemBodyContext(work));
    const [body] = await env.t.db
      .insert(itemBodies)
      .values({ accountId: work, ...envelope })
      .returning();
    const [item] = await env.t.db
      .insert(items)
      .values({
        accountId: work,
        kind: 'email',
        externalId: 'with-body',
        bodyRef: body!.id,
        receivedAt: env.now(),
      })
      .returning();
    const res = await env.app.inject({ url: `/items/${item!.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ item: { id: item!.id }, body: 'Hello, the full body' });
    const audit = await env.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'item.read')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.principal).toBe('user');
    expect(JSON.stringify(audit[0])).not.toContain('Hello');
    expect((await env.app.inject({ url: '/items/not-a-uuid', headers: auth })).statusCode).toBe(
      404,
    );
  });
});

describe('tasks', () => {
  let agentTask: string;
  beforeAll(async () => {
    const [src] = await env.t.db.select().from(items).where(eq(items.externalId, 'm3'));
    const [t] = await env.t.db
      .insert(tasks)
      .values({
        userId,
        title: 'Review the budget',
        sourceItemId: src!.id,
        createdBy: 'agent:extractor',
        confidence: 0.9,
        dueAt: new Date('2026-10-02T17:00:00Z'),
      })
      .returning();
    agentTask = t!.id;
    await env.t.db
      .insert(tasks)
      .values({ userId, title: 'Second agent task', createdBy: 'agent:extractor' });
  });

  it('creates user tasks and lists agent tasks pending review with their source', async () => {
    const created = await env.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: auth,
      payload: { title: 'Call the bank', dueAt: '2026-09-30T09:00:00.000Z' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      title: 'Call the bank',
      createdBy: 'user',
      status: 'open',
      source: null,
    });
    expect(env.live.some((l) => l.event.type === 'task.created')).toBe(true);

    const pending = (await env.app.inject({ url: '/tasks?review=pending', headers: auth })).json()
      .tasks;
    expect(pending.map((t: { title: string }) => t.title).sort()).toEqual([
      'Review the budget',
      'Second agent task',
    ]);
    const review = pending.find((t: { id: string }) => t.id === agentTask);
    expect(review).toMatchObject({ source: 'gmail', confirmedByUser: null, confidence: 0.9 });
    expect(review.accountId).toBeTruthy();
  });

  it('confirm keeps the task; "Not a task" dismisses it', async () => {
    const ok = await env.app.inject({
      method: 'PATCH',
      url: `/tasks/${agentTask}`,
      headers: auth,
      payload: { confirmedByUser: true },
    });
    expect(ok.json()).toMatchObject({ confirmedByUser: true, status: 'open' });
    const [second] = await env.t.db
      .select()
      .from(tasks)
      .where(eq(tasks.title, 'Second agent task'));
    const no = await env.app.inject({
      method: 'PATCH',
      url: `/tasks/${second!.id}`,
      headers: auth,
      payload: { confirmedByUser: false },
    });
    expect(no.json()).toMatchObject({ confirmedByUser: false, status: 'dismissed' });
    expect(
      (await env.app.inject({ url: '/tasks?review=pending', headers: auth })).json().tasks,
    ).toEqual([]);
    expect(
      (await env.app.inject({ url: '/tasks?status=dismissed', headers: auth })).json().tasks,
    ).toHaveLength(1);
    const done = await env.app.inject({
      method: 'PATCH',
      url: `/tasks/${agentTask}`,
      headers: auth,
      payload: { status: 'done' },
    });
    expect(done.json().status).toBe('done');
    await env.app.inject({
      method: 'PATCH',
      url: `/tasks/${agentTask}`,
      headers: auth,
      payload: { status: 'open' },
    });
    const audits = await env.t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'task.rejected'));
    expect(audits).toHaveLength(1);
  });
});

describe('today', () => {
  it("returns the brief for the user's local date, needs-you items, next up and counts", async () => {
    await env.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth,
      payload: { timezone: 'Pacific/Kiritimati' },
    });
    // 10:00Z is already Sept 29 in UTC+14.
    await env.t.db.insert(briefs).values([
      { userId, date: '2026-09-28', headline: 'Yesterday', bullets: [] },
      { userId, date: '2026-09-29', headline: 'Three things today', bullets: ['a', 'b'] },
    ]);
    await env.t.db.insert(proposals).values({
      userId,
      accountId: work,
      agent: 'agent:reply',
      action: 'gmail.send',
      title: 'Reply',
      payload: {},
      idempotencyKey: 'today-1',
    });
    await env.t.db
      .update(accounts)
      .set({ lastSyncedAt: new Date('2026-09-28T09:59:00Z') })
      .where(eq(accounts.id, work));

    const res = await env.app.inject({ url: '/today', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.brief).toMatchObject({
      date: '2026-09-29',
      headline: 'Three things today',
      bullets: ['a', 'b'],
    });
    expect(body.needsYou).toHaveLength(3);
    expect(body.needsYou.every((i: { bucket: string }) => i.bucket === 'needs_you')).toBe(true);
    expect(body.nextUp[0].title).toBe('Call the bank');
    expect(body.openTaskCount).toBe(2);
    expect(body.pendingApprovals).toBe(1);
    expect(body.lastSyncedAt).toBe('2026-09-28T09:59:00.000Z');
  });
});
