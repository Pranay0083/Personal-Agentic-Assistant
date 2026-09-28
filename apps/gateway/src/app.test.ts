import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connector, WebhookRequest } from '@hub/connectors';
import { createGmailConnector, createPubSubVerifier, FakeGmailStore } from '@hub/connectors/gmail';
import { accounts, events, users } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import type { Provider } from '@hub/shared';
import { QUEUES } from '@hub/shared/queues';
import { buildGateway, type GatewayDeps } from './app';

const AUD = 'https://gw.example/hooks/gmail';
const SA = 'push@hub-dev.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const body = b64u({
    iss: 'https://accounts.google.com',
    aud: AUD,
    email: SA,
    email_verified: true,
    iat: now,
    exp: now + 600,
    ...claims,
  });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`;
}

const push = (email: string, messageId: string, historyId = 1006) => ({
  message: {
    data: Buffer.from(JSON.stringify({ emailAddress: email, historyId })).toString('base64'),
    messageId,
    publishTime: '2026-09-28T10:15:30.123Z',
  },
  subscription: 'projects/hub-dev/subscriptions/gmail-push',
});

let t: Awaited<ReturnType<typeof createTestDb>>;
const jobs: { name: string; data: unknown }[] = [];
let failEnqueue = false;
let gmail: Connector;
let app: ReturnType<typeof buildGateway>;
let workA: string;
let workB: string;

beforeAll(async () => {
  t = await createTestDb();
  gmail = createGmailConnector({
    config: { fake: false, pubsubAudience: AUD, pubsubServiceAccount: SA },
    fakeStore: FakeGmailStore.memory(),
    verifier: createPubSubVerifier({
      audience: AUD,
      serviceAccountEmail: SA,
      getCerts: async () => ({ k1: publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
    }),
  }) as Connector;
  const deps: GatewayDeps = {
    db: t.db,
    enqueue: async (name, data) => {
      if (failEnqueue) throw new Error('redis down');
      jobs.push({ name, data });
    },
    getConnector: (p: Provider) => (p === 'gmail' ? gmail : undefined),
  };
  app = buildGateway(deps);
  const [u1, u2] = await t.db
    .insert(users)
    .values([{ email: 'one@example.com' }, { email: 'two@example.com' }])
    .returning();
  const base = { provider: 'gmail', nickname: 'Work', color: '#1F6F6B', status: 'live' };
  const rows = await t.db
    .insert(accounts)
    .values([
      {
        ...base,
        userId: u1!.id,
        externalId: 'alex@company.example',
        createdAt: new Date('2026-01-01'),
      },
      {
        ...base,
        userId: u2!.id,
        externalId: 'alex@company.example',
        createdAt: new Date('2026-02-01'),
      },
      { ...base, userId: u1!.id, externalId: 'alex.personal@gmail.example' },
    ])
    .returning();
  [workA, workB] = rows.map((r) => r.id) as [string, string];
});

afterAll(async () => {
  await app.close();
  await t.drop();
});

beforeEach(async () => {
  jobs.length = 0;
  failEnqueue = false;
  await t.db.delete(events);
});

const post = (
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${jwt()}` },
  provider = 'gmail',
) =>
  app.inject({
    method: 'POST',
    url: `/hooks/${provider}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

describe('gateway /hooks/:provider', () => {
  it('healthz', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('dedupes: the same push twice → one event per account, one sync job each', async () => {
    const r1 = await post(push('alex@company.example', 'm-1'));
    const r2 = await post(push('alex@company.example', 'm-1'));
    expect([r1.statusCode, r2.statusCode]).toEqual([204, 204]);
    const rows = await t.db.select().from(events);
    // One address, two users: both accounts get the event.
    expect(rows.map((e) => [e.accountId, e.providerEventId]).sort()).toEqual(
      [
        [workA, 'gmail:m-1'],
        [workB, `gmail:m-1:${workB}`],
      ].sort(),
    );
    expect(rows[0]!.payload).toMatchObject({ historyId: '1006', messageId: 'm-1' });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.name === QUEUES.sync)).toBe(true);
    expect(jobs.map((j) => j.data)).toContainEqual({
      accountId: workA,
      eventId: rows.find((e) => e.accountId === workA)!.id,
      reason: 'webhook',
    });
  });

  it('matches the address case-insensitively', async () => {
    await post(push('Alex.Personal@Gmail.example', 'm-case'));
    expect(jobs).toHaveLength(1);
  });

  it('unknown account → 204, nothing stored or enqueued', async () => {
    const r = await post(push('nobody@example.com', 'm-2'));
    expect(r.statusCode).toBe(204);
    expect(await t.db.select().from(events)).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it('bad signature → 401, nothing stored', async () => {
    const tampered = jwt().replace(/\.[^.]+$/, '.AAAA');
    const variants: Record<string, string>[] = [
      { authorization: `Bearer ${tampered}` },
      { authorization: `Bearer ${jwt({ aud: 'x' })}` },
      {},
    ];
    for (const headers of variants) {
      const r = await post(push('alex@company.example', 'm-3'), headers);
      expect(r.statusCode).toBe(401);
      expect(r.body).not.toContain('Bearer');
    }
    expect(await t.db.select().from(events)).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it('unknown or unimplemented provider → 404', async () => {
    expect((await post({}, {}, 'nope')).statusCode).toBe(404);
    expect((await post({}, {}, 'slack')).statusCode).toBe(404);
  });

  it('enqueue failure → 500 and the event is rolled back so the retry is not deduped away', async () => {
    failEnqueue = true;
    const r = await post(push('alex.personal@gmail.example', 'm-4'));
    expect(r.statusCode).toBe(500);
    expect(await t.db.select().from(events)).toHaveLength(0);
    failEnqueue = false;
    expect((await post(push('alex.personal@gmail.example', 'm-4'))).statusCode).toBe(204);
    expect(jobs).toHaveLength(1);
  });

  it('passes the raw body and headers to the connector', async () => {
    let seen: WebhookRequest | undefined;
    const spy = buildGateway({
      db: t.db,
      enqueue: async () => {},
      getConnector: () =>
        ({
          ...gmail,
          verifyWebhook: async (req: WebhookRequest) => {
            seen = req;
            return { ok: true, events: [], reply: { challenge: 'c' } };
          },
        }) as Connector,
    });
    const raw = '{"type":"url_verification",  "challenge":"c"}';
    const r = await spy.inject({
      method: 'POST',
      url: '/hooks/slack',
      headers: { 'content-type': 'application/json', 'x-sig': 'v0=abc' },
      payload: raw,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ challenge: 'c' });
    expect(seen!.rawBody).toBe(raw);
    expect(seen!.headers['x-sig']).toBe('v0=abc');
    expect(seen!.body).toEqual({ type: 'url_verification', challenge: 'c' });
    await spy.close();
  });
});
