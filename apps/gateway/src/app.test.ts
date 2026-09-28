import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Connector, VerifyResult, WebhookRequest } from '@hub/connectors';
import { createGmailConnector, createPubSubVerifier, FakeGmailStore } from '@hub/connectors/gmail';
import { accounts, events, subscriptions, users } from '@hub/db';
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
    // The Gmail connector may name the source (`mail`); either way it is passed through.
    expect(jobs.map((j) => j.data)).toContainEqual(
      expect.objectContaining({
        accountId: workA,
        eventId: rows.find((e) => e.accountId === workA)!.id,
        reason: 'webhook',
      }),
    );
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
            return { ok: true, events: [], reply: { body: { challenge: 'c' } } };
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

describe('gateway: routing, secrets and handshakes (generic connectors)', () => {
  let result: VerifyResult = { ok: true, events: [] };
  let seen: WebhookRequest | undefined;
  let gw: ReturnType<typeof buildGateway>;
  let slackA: string;
  let slackB: string;
  let msAccount: string;
  let msOther: string;
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');

  beforeAll(async () => {
    const fake = (provider: Provider) =>
      ({
        ...gmail,
        provider,
        verifyWebhook: async (req: WebhookRequest) => {
          seen = req;
          return result;
        },
      }) as Connector;
    const byProvider: Partial<Record<Provider, Connector>> = {
      slack: fake('slack'),
      microsoft: fake('microsoft'),
    };
    gw = buildGateway({
      db: t.db,
      enqueue: async (name, data) => {
        if (failEnqueue) throw new Error('redis down');
        jobs.push({ name, data });
      },
      getConnector: (p) => byProvider[p],
    });
    const [u1, u2] = await t.db
      .insert(users)
      .values([{ email: 'gw-a@example.com' }, { email: 'gw-b@example.com' }])
      .returning();
    const base = { nickname: 'Acme', color: '#1F6F6B', status: 'live' };
    const rows = await t.db
      .insert(accounts)
      .values([
        {
          ...base,
          provider: 'slack',
          userId: u1!.id,
          externalId: 'T1:U1',
          routeKeys: ['T1'],
          createdAt: new Date('2026-01-01'),
        },
        {
          ...base,
          provider: 'slack',
          userId: u2!.id,
          externalId: 'T1:U2',
          routeKeys: ['T1', 'E9'],
          createdAt: new Date('2026-02-01'),
        },
        { ...base, provider: 'slack', userId: u2!.id, externalId: 'T2:U2', routeKeys: ['T2'] },
        { ...base, provider: 'microsoft', userId: u1!.id, externalId: 'tenant:alex' },
        { ...base, provider: 'microsoft', userId: u2!.id, externalId: 'tenant:sam' },
      ])
      .returning();
    [slackA, slackB, , msAccount, msOther] = rows.map((r) => r.id) as string[] as [
      string,
      string,
      string,
      string,
      string,
    ];
    await t.db.insert(subscriptions).values([
      {
        accountId: msAccount!,
        kind: 'mail',
        externalSubId: 'graph-sub-1',
        meta: { secretHash: sha('s3cret') },
      },
      { accountId: msAccount!, kind: 'teams', externalSubId: 'graph-sub-2', enabled: false },
      { accountId: msOther!, kind: 'mail', externalSubId: 'graph-sub-3' },
    ]);
  });
  afterAll(async () => {
    await gw.close();
  });
  beforeEach(() => {
    result = { ok: true, events: [] };
    seen = undefined;
  });

  const hook = (url: string, body: unknown = {}, method: 'POST' | 'GET' = 'POST') =>
    gw.inject({
      method,
      url,
      ...(method === 'POST'
        ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }
        : {}),
    });
  const syncJobs = () => jobs.filter((j) => j.name === QUEUES.sync).map((j) => j.data);
  const storedEvents = () => t.db.select().from(events);

  it('routes by route key to every account holding it, with the source', async () => {
    result = {
      ok: true,
      events: [{ providerEventId: 'Ev1', routeKey: 'T1', source: 'messages', payload: {} }],
    };
    const r = await hook('/hooks/slack', { type: 'event_callback' });
    expect(r.statusCode).toBe(204);
    const rows = await storedEvents();
    expect(rows.map((e) => [e.accountId, e.providerEventId]).sort()).toEqual(
      [
        [slackA, 'slack:Ev1'],
        [slackB, `slack:Ev1:${slackB}`],
      ].sort(),
    );
    expect(syncJobs()).toEqual([
      {
        accountId: slackA,
        source: 'messages',
        eventId: rows.find((e) => e.accountId === slackA)!.id,
        reason: 'webhook',
      },
      {
        accountId: slackB,
        source: 'messages',
        eventId: rows.find((e) => e.accountId === slackB)!.id,
        reason: 'webhook',
      },
    ]);
    // Redelivery is deduped for both accounts.
    await hook('/hooks/slack', { type: 'event_callback' });
    expect(await storedEvents()).toHaveLength(2);
    expect(syncJobs()).toHaveLength(2);
  });

  it('routes by external account id, and never across providers', async () => {
    result = {
      ok: true,
      events: [{ providerEventId: 'x1', externalAccountId: 'tenant:alex', payload: {} }],
    };
    await hook('/hooks/microsoft');
    expect(syncJobs()).toEqual([
      { accountId: msAccount, eventId: expect.any(String), reason: 'webhook' },
    ]);
    jobs.length = 0;
    result = {
      ok: true,
      events: [{ providerEventId: 'x2', externalAccountId: 'tenant:alex', payload: {} }],
    };
    await hook('/hooks/slack');
    expect(syncJobs()).toEqual([]);
  });

  it('routes by subscription id to its account and source, checking the shared secret', async () => {
    const ev = (id: string, extra: object) => ({
      ok: true as const,
      events: [{ providerEventId: id, externalSubId: 'graph-sub-1', payload: {}, ...extra }],
    });
    result = ev('n1', { subscriptionSecret: 's3cret' });
    expect((await hook('/hooks/microsoft')).statusCode).toBe(204);
    expect(syncJobs()).toEqual([
      { accountId: msAccount, source: 'mail', eventId: expect.any(String), reason: 'webhook' },
    ]);

    // Wrong or missing secret: dropped, nothing stored or enqueued, and nothing leaks.
    jobs.length = 0;
    for (const extra of [{ subscriptionSecret: 'wrong' }, {}]) {
      result = ev(`n-bad-${Object.keys(extra).length}`, extra);
      const r = await hook('/hooks/microsoft');
      expect(r.statusCode).toBe(204);
      expect(r.body).toBe('');
    }
    expect(await storedEvents()).toHaveLength(1);
    expect(syncJobs()).toEqual([]);

    // A subscription without a stored hash refuses a secret it can't check.
    result = {
      ok: true,
      events: [
        {
          providerEventId: 'n3',
          externalSubId: 'graph-sub-3',
          subscriptionSecret: 's3cret',
          payload: {},
        },
      ],
    };
    await hook('/hooks/microsoft');
    expect(syncJobs()).toEqual([]);
    // ...but accepts events without one.
    result = {
      ok: true,
      events: [{ providerEventId: 'n4', externalSubId: 'graph-sub-3', payload: {} }],
    };
    await hook('/hooks/microsoft');
    expect(syncJobs()).toEqual([
      { accountId: msOther, source: 'mail', eventId: expect.any(String), reason: 'webhook' },
    ]);
  });

  it('checks the secret against the source subscription when routed by account', async () => {
    const ev = (id: string, secret: string) => ({
      ok: true as const,
      events: [
        {
          providerEventId: id,
          externalAccountId: 'tenant:alex',
          source: 'mail',
          subscriptionSecret: secret,
          payload: {},
        },
      ],
    });
    result = ev('s1', 'nope');
    await hook('/hooks/microsoft');
    expect(syncJobs()).toEqual([]);
    result = ev('s2', 's3cret');
    await hook('/hooks/microsoft');
    expect(syncJobs()).toEqual([
      { accountId: msAccount, source: 'mail', eventId: expect.any(String), reason: 'webhook' },
    ]);
  });

  it('refuses account-routed events without a secret when the source registered one', async () => {
    result = {
      ok: true,
      events: [
        { providerEventId: 'ns1', externalAccountId: 'tenant:alex', source: 'mail', payload: {} },
      ],
    };
    await hook('/hooks/microsoft');
    expect(syncJobs()).toEqual([]);
  });

  it('skips a disabled source when routed by account', async () => {
    result = {
      ok: true,
      events: [
        { providerEventId: 'ds1', externalAccountId: 'tenant:alex', source: 'teams', payload: {} },
      ],
    };
    await hook('/hooks/microsoft');
    expect(syncJobs()).toEqual([]);
  });

  it('ignores disabled sources and unknown subscriptions', async () => {
    result = {
      ok: true,
      events: [
        { providerEventId: 'd1', externalSubId: 'graph-sub-2', payload: {} },
        { providerEventId: 'd2', externalSubId: 'graph-sub-404', payload: {} },
        { providerEventId: 'd3', routeKey: 'T-unknown', payload: {} },
      ],
    };
    expect((await hook('/hooks/microsoft')).statusCode).toBe(204);
    expect(await storedEvents()).toHaveLength(0);
    expect(syncJobs()).toEqual([]);
  });

  it('echoes handshakes: text/plain validation tokens and JSON challenges', async () => {
    result = {
      ok: true,
      events: [],
      reply: { body: 'token-123', contentType: 'text/plain' },
    };
    const graph = await gw.inject({
      method: 'POST',
      url: '/hooks/microsoft/mail?validationToken=token-123',
    });
    expect(graph.statusCode).toBe(200);
    expect(graph.headers['content-type']).toMatch(/^text\/plain/);
    expect(graph.body).toBe('token-123');
    expect(seen).toMatchObject({
      method: 'POST',
      channel: 'mail',
      query: { validationToken: 'token-123' },
    });

    result = { ok: true, events: [], reply: { body: { challenge: 'abc' } } };
    const slack = await hook('/hooks/slack', { type: 'url_verification', challenge: 'abc' });
    expect(slack.statusCode).toBe(200);
    expect(slack.headers['content-type']).toMatch(/^application\/json/);
    expect(slack.json()).toEqual({ challenge: 'abc' });
    expect(seen!.channel).toBeNull();

    // Only the reply's body is sent, with its status: a plain 200 (Notion verification).
    result = { ok: true, events: [], reply: { status: 200, body: '' } };
    const plain = await hook('/hooks/slack', { verification_token: 'v' });
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toBe('');

    result = { ok: true, events: [], reply: { status: 202, body: 'ok' } };
    const get = await hook('/hooks/slack/verify?x=1&x=2', undefined, 'GET');
    expect(get.statusCode).toBe(202);
    expect(seen).toMatchObject({ method: 'GET', channel: 'verify', query: { x: '1' } });
  });

  it('passes form bodies parsed, with the raw body', async () => {
    result = { ok: true, events: [] };
    const raw = 'payload=%7B%22a%22%3A1%7D&token=t';
    await gw.inject({
      method: 'POST',
      url: '/hooks/slack',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: raw,
    });
    expect(seen!.rawBody).toBe(raw);
    expect(seen!.body).toEqual({ payload: '{"a":1}', token: 't' });
  });

  it('unknown and unimplemented providers are 404 on every route', async () => {
    for (const url of ['/hooks/nope', '/hooks/github', '/hooks/github/x']) {
      expect((await hook(url)).statusCode).toBe(404);
    }
  });

  it('enqueue failure rolls back the event for routed events too', async () => {
    result = {
      ok: true,
      events: [{ providerEventId: 'rb1', routeKey: 'T2', payload: {} }],
    };
    failEnqueue = true;
    expect((await hook('/hooks/slack')).statusCode).toBe(500);
    expect(await storedEvents()).toHaveLength(0);
    failEnqueue = false;
    expect((await hook('/hooks/slack')).statusCode).toBe(204);
    const [row] = await storedEvents();
    expect(
      (await t.db.select().from(accounts).where(eq(accounts.id, row!.accountId!)))[0]!.externalId,
    ).toBe('T2:U2');
  });
});

describe('gateway request logging', () => {
  it('never logs the query string (providers put shared secrets there)', async () => {
    const lines: string[] = [];
    const rec =
      () =>
      (...args: unknown[]) =>
        void lines.push(JSON.stringify(args));
    const logger = {
      level: 'info',
      info: rec(),
      warn: rec(),
      error: rec(),
      debug: rec(),
      fatal: rec(),
      trace: rec(),
      silent: () => {},
      child() {
        return logger;
      },
    } as unknown as Parameters<typeof buildGateway>[0]['logger'];
    const gw = buildGateway({
      db: t.db,
      enqueue: async () => {},
      getConnector: () => undefined,
      logger,
    });
    await gw.inject({
      method: 'POST',
      url: '/hooks/atlassian?sub=atl_1&t=very-secret-value',
      payload: {},
    });
    await gw.close();
    const all = lines.join('\n');
    expect(all).toContain('/hooks/:provider');
    expect(all).not.toContain('very-secret-value');
    expect(all).not.toContain('t=');
  });
});
