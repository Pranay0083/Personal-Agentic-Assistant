import { describe, expect, it, vi } from 'vitest';
import { ReconnectRequiredError, RetryableError } from '../errors';
import { fixture, MemoryStore, mockFetch } from '../lib/fake';
import type { FetchFn } from '../lib/http';
import type { ConnectorContext, WebhookRequest } from '../types';
import { flattenPage } from './blocks';
import { createNotionClient } from './client';
import { NOTION_VERSION } from './config';
import { createNotionConnector, parseNotionCursor } from './connector';
import { editFakePage, seedFakeNotion, type FakeNotionState } from './fake';
import type { NotionRecord } from './normalize';
import { notionSignature, verifyNotionWebhook } from './webhook';

const f = <T = unknown>(name: string) => fixture<T>(import.meta.url, name);

const PAGE_A = '153104cd-477e-809d-8dc4-ff2d96ae3090';
const PAGE_B = '2a8b04cd-477e-80aa-9c11-00aa11bb22cc';
const PRIYA = '556a1abf-4f08-40c6-878a-75890d2a88ba';
const OWNER = 'c7c11cca-1d73-471d-9b6e-bdef51470190';
const WS = '13950b26-c203-4f3b-b97d-93ec06319565';

const children = (id: string) => `GET /v1/blocks/${id}/children`;

/** Recorded Notion responses; POST /v1/search pages on the JSON body's start_cursor. */
function notionApi(extra: Record<string, unknown> = {}) {
  const mock = mockFetch({
    [children(PAGE_A)]: {
      status: 200,
      body: (u: URL) =>
        u.searchParams.get('start_cursor') ? f('blocks-page-2.json') : f('blocks-page-1.json'),
    },
    [children('b0000000-0000-0000-0000-000000000007')]: f('blocks-nested-1.json'),
    [children('b0000000-0000-0000-0000-000000000021')]: f('blocks-nested-2.json'),
    [children(PAGE_B)]: f('blocks-empty.json'),
    [`GET /v1/users/${PRIYA}`]: f('user.json'),
    [`GET /v1/users/${OWNER}`]: {
      status: 403,
      body: { object: 'error', code: 'restricted_resource' },
    },
    ...extra,
  });
  const searches: Record<string, unknown>[] = [];
  const fetch = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/v1/search' && init?.method === 'POST' && !extra['POST /v1/search']) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      searches.push(body);
      const page = !body.start_cursor
        ? 'search-page-1.json'
        : body.start_cursor === PAGE_B
          ? 'search-page-2.json'
          : null;
      if (!page) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify(f(page)), { status: 200 });
    }
    return mock.fetch(input, init);
  }) as FetchFn;
  return { fetch, calls: mock.calls, searches };
}

const NOW = Date.parse('2026-09-28T12:00:00.000Z');

function ctx(cursor: string | null, over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    accountId: 'acc-1',
    externalId: `${WS}:${OWNER}`,
    tokens: { accessToken: 'ntn_test' },
    saveTokens: async () => {},
    source: 'pages',
    cursor,
    filters: { inbox: true, sent: true, promotions: false, labels: [], sources: {}, options: {} },
    meta: { workspaceId: WS, ownerUserId: OWNER },
    ...over,
  };
}

const connectorWith = (fetch: FetchFn, over: Parameters<typeof createNotionConnector>[0] = {}) =>
  createNotionConnector({
    config: {
      fake: false,
      clientId: 'cid',
      clientSecret: 'csecret',
      webhookVerificationToken: 'secret_key',
    },
    fetch,
    client: { minIntervalMs: 0 },
    now: () => NOW,
    overlapMs: 0,
    ...over,
  });

describe('notion flattenPage', () => {
  it('flattens nested blocks, rich text, to-dos, headings and lists across pages', async () => {
    const { fetch } = notionApi();
    const client = createNotionClient({ token: 't', fetch, minIntervalMs: 0 });
    const out = await flattenPage(client, PAGE_A);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(
      [
        '# Goals',
        'Ship the mobile beta2026-10-15',
        '[ ] Finalise pricing copy',
        '[x] Book the venue',
        '## Risks 2026-10-01',
        '- App review',
        '  - May take a week',
        '    > @Priya Raman Apple says 24h',
        '1. Submit build',
        '2. Announce@Alex Kim',
        '[Risks]',
        '---',
      ].join('\n'),
    );
    // Only structured user mentions count (date mentions and plain "@" text do not).
    expect(out.mentions.sort()).toEqual([OWNER, PRIYA].sort());
  });

  it('ignores mention-like text that is not a mention object', async () => {
    const { fetch } = mockFetch({
      'GET /v1/blocks/p/children': {
        object: 'list',
        results: [
          {
            object: 'block',
            id: 'x1',
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: [{ type: 'text', plain_text: `@Alex Kim ${OWNER}` }] },
          },
        ],
        next_cursor: null,
        has_more: false,
      },
    });
    const client = createNotionClient({ token: 't', fetch, minIntervalMs: 0 });
    expect((await flattenPage(client, 'p')).mentions).toEqual([]);
  });

  it('stops at the depth cap and marks the body truncated', async () => {
    const { fetch, calls } = notionApi();
    const client = createNotionClient({ token: 't', fetch, minIntervalMs: 0 });
    const out = await flattenPage(client, PAGE_A, {
      maxDepth: 1,
      maxChars: 10_000,
      maxRequests: 10,
    });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('  - May take a week');
    expect(out.text).not.toContain('Apple');
    expect(calls.some((c) => c.url.pathname.includes('000000000021'))).toBe(false);
  });

  it('caps the size and the request budget', async () => {
    const { fetch } = notionApi();
    const client = createNotionClient({ token: 't', fetch, minIntervalMs: 0 });
    const small = await flattenPage(client, PAGE_A, { maxDepth: 3, maxChars: 20, maxRequests: 10 });
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBeLessThanOrEqual(20);
    const budget = await flattenPage(client, PAGE_A, {
      maxDepth: 3,
      maxChars: 10_000,
      maxRequests: 1,
    });
    expect(budget.truncated).toBe(true);
    expect(budget.text).not.toContain('Risks');
  });
});

describe('notion client rate limits', () => {
  it('waits out a 429 Retry-After and retries', async () => {
    let n = 0;
    const fetch = (async () => {
      n++;
      if (n === 1)
        return new Response(JSON.stringify(f('error-429.json')), {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      return new Response(JSON.stringify(f('blocks-empty.json')), { status: 200 });
    }) as FetchFn;
    const sleep = vi.fn(async () => {});
    const client = createNotionClient({ token: 't', fetch, minIntervalMs: 0, sleep });
    const res = await client.blockChildren('x');
    expect(res.results).toEqual([]);
    expect(n).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('gives a long Retry-After back to the queue as RetryableError', async () => {
    const { fetch } = mockFetch({
      'GET /v1/blocks/x/children': {
        status: 429,
        body: f('error-429.json'),
        headers: { 'retry-after': '120' },
      },
    });
    const client = createNotionClient({
      token: 't',
      fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    });
    const e = (await client.blockChildren('x').catch((x: unknown) => x)) as RetryableError;
    expect(e).toBeInstanceOf(RetryableError);
    expect(e.retryAfterMs).toBe(120_000);
  });

  it('spaces requests to stay near 3 per second', async () => {
    const { fetch } = mockFetch({ 'GET /v1/blocks/x/children': f('blocks-empty.json') });
    let clock = 0;
    const waits: number[] = [];
    const client = createNotionClient({
      token: 't',
      fetch,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await client.blockChildren('x');
    await client.blockChildren('x');
    await client.blockChildren('x');
    expect(waits).toEqual([350, 350]);
  });

  it('sends the pinned Notion-Version and bearer token', async () => {
    const { fetch, calls } = mockFetch({ 'GET /v1/blocks/x/children': f('blocks-empty.json') });
    await createNotionClient({ token: 'tok', fetch, minIntervalMs: 0 }).blockChildren('x');
    expect(calls[0]!.headers['notion-version']).toBe(NOTION_VERSION);
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
  });
});

describe('notion fetchDelta', () => {
  const cursor = JSON.stringify({
    t: '2026-09-28T09:00:00.000Z',
    seen: { '3c9d04cd-477e-80bb-8d22-00bb22cc33dd': '2026-09-28T09:00:00.000Z' },
  });

  it('pages search until entries are older than the cursor, then advances it', async () => {
    const api = notionApi();
    const c = connectorWith(api.fetch);
    const res = await c.fetchDelta(ctx(cursor));
    expect(api.searches).toHaveLength(2);
    expect(api.searches[0]).toMatchObject({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });
    expect(api.searches[1]!.start_cursor).toBe(PAGE_B);
    // Oldest first; the already-seen page at the cursor and the older page are skipped.
    expect(res.records.map((r) => r.page.id)).toEqual([PAGE_B, PAGE_A]);
    expect(res.hasMore).toBeUndefined();
    const next = parseNotionCursor(res.cursor!);
    expect(next.t).toBe('2026-09-28T10:05:00.000Z');
    expect(next.seen).toEqual({
      [PAGE_B]: '2026-09-28T09:30:00.000Z',
      [PAGE_A]: '2026-09-28T10:05:00.000Z',
    });

    // Same data again: nothing new, cursor unchanged.
    const again = await c.fetchDelta(ctx(res.cursor));
    expect(again.records).toHaveLength(0);
    expect(parseNotionCursor(again.cursor!).t).toBe('2026-09-28T10:05:00.000Z');
  });

  it('returns hasMore when more pages changed than one run fetches', async () => {
    const c = connectorWith(notionApi().fetch, { maxPagesPerRun: 1 });
    const res = await c.fetchDelta(ctx(cursor));
    expect(res.records.map((r) => r.page.id)).toEqual([PAGE_B]);
    expect(res.hasMore).toBe(true);
    expect(parseNotionCursor(res.cursor!).t).toBe('2026-09-28T09:30:00.000Z');
  });

  it('does not mark edits in the current minute as seen (Notion rounds edit times)', async () => {
    const c = connectorWith(notionApi().fetch, {
      now: () => Date.parse('2026-09-28T10:05:30.000Z'),
    });
    const res = await c.fetchDelta(ctx(cursor));
    expect(Object.keys(parseNotionCursor(res.cursor!).seen)).toEqual([PAGE_B]);
  });

  it('starts from now without records when there is no cursor', async () => {
    const api = notionApi();
    const res = await connectorWith(api.fetch).fetchDelta(ctx(null));
    expect(res.records).toEqual([]);
    expect(parseNotionCursor(res.cursor!).t).toBe('2026-09-28T12:00:00.000Z');
    expect(api.searches).toHaveLength(0);
  });

  it('normalizes pages: title, body, fromMe, author and labels', async () => {
    const c = connectorWith(notionApi().fetch);
    const res = await c.fetchDelta(ctx(cursor));
    const [b, a] = res.records.map((r) => c.normalize(r as NotionRecord, 'pages')!);
    expect(a).toMatchObject({
      kind: 'note',
      externalId: PAGE_A,
      title: 'Q4 launch plan',
      author: 'Priya Raman',
      authorAddress: 'priya@company.example',
      fromMe: false,
      url: 'https://www.notion.so/Q4-launch-plan-153104cd477e809d8dc4ff2d96ae3090',
    });
    // Priya edited it and it @-mentions the owner: a mention, not from me.
    expect(a!.labels).toEqual([`notion:page:${PAGE_A}`, 'notion:parent:workspace', 'hub:mention']);
    expect(a!.body).toContain('[ ] Finalise pricing copy');
    expect(a!.receivedAt.toISOString()).toBe('2026-09-28T10:05:00.000Z');
    expect(b).toMatchObject({ title: 'Weekly sync', fromMe: true, author: null, body: null });
    expect(b!.labels).toEqual([
      `notion:page:${PAGE_B}`,
      'notion:parent:database_id',
      'hub:from_me',
    ]);
  });

  it('maps 401 to reconnect', async () => {
    const c = connectorWith(
      notionApi({ 'POST /v1/search': { status: 401, body: f('error-401.json') } }).fetch,
    );
    await expect(c.fetchDelta(ctx(cursor))).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe('notion connect', () => {
  it('builds the user-owner authorize URL', () => {
    const c = connectorWith(notionApi().fetch);
    const u = new URL(
      c.connect.authUrl({ state: 's1', redirectUri: 'https://api.example/cb', access: 'read' }),
    );
    expect(u.origin + u.pathname).toBe('https://api.notion.com/v1/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'cid',
      owner: 'user',
      response_type: 'code',
      state: 's1',
      redirect_uri: 'https://api.example/cb',
    });
  });

  it('exchanges with Basic auth and a JSON body, keyed by workspace and owner', async () => {
    const { fetch, calls } = mockFetch({ 'POST /v1/oauth/token': f('token.json') });
    const c = connectorWith(fetch);
    const r = await c.connect.exchange({
      code: 'abc',
      redirectUri: 'https://api.example/cb',
      access: 'read',
    });
    expect(calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'https://api.example/cb',
    });
    expect(r.externalId).toBe(`${WS}:${OWNER}`);
    expect(r.displayName).toBe('Acme Product');
    expect(r.tokens.expiresAt).toBeUndefined();
    expect(r.tokens.refreshToken).toBeUndefined();
    expect(r.identities).toEqual([
      {
        externalId: `${WS}:${OWNER}`,
        displayName: 'Acme Product',
        routeKeys: [WS],
        meta: {
          workspaceId: WS,
          workspaceName: 'Acme Product',
          botId: '1edc05f6-2702-81b5-8408-00279347f034',
          ownerUserId: OWNER,
        },
      },
    ]);
  });

  it('refuses write access', async () => {
    const c = connectorWith(notionApi().fetch);
    expect(() =>
      c.connect.authUrl({ state: 's', redirectUri: 'https://x/cb', access: 'write' }),
    ).toThrow();
    await expect(
      c.connect.exchange({ code: 'x', redirectUri: 'https://x/cb', access: 'write' }),
    ).rejects.toThrow();
  });

  it('is configured with credentials or in fake mode only', () => {
    expect(createNotionConnector({ config: { fake: false } }).configured()).toBe(false);
    expect(
      createNotionConnector({
        config: { fake: false, clientId: 'a', clientSecret: 'b' },
      }).configured(),
    ).toBe(true);
    expect(createNotionConnector({ config: { fake: true } }).configured()).toBe(true);
  });
});

describe('notion webhooks', () => {
  const key = 'secret_key';
  const signed = (body: unknown, sig?: string): WebhookRequest => {
    const rawBody = JSON.stringify(body);
    return {
      headers:
        sig === undefined
          ? { 'x-notion-signature': notionSignature(key, rawBody) }
          : sig
            ? { 'x-notion-signature': sig }
            : {},
      body,
      rawBody,
    };
  };

  it('accepts a good signature and routes by workspace', () => {
    const r = verifyNotionWebhook(signed(f('webhook-page-content-updated.json')), { key });
    expect(r).toEqual({
      ok: true,
      events: [
        {
          providerEventId: '367cba44-b6f3-4c92-81e7-6a2e9659efd4',
          routeKey: WS,
          source: 'pages',
          payload: {
            type: 'page.content_updated',
            entityId: PAGE_A,
            entityType: 'page',
            timestamp: '2026-09-28T10:05:34.285Z',
          },
        },
      ],
    });
  });

  it('rejects a bad or missing signature', () => {
    const body = f('webhook-page-content-updated.json');
    expect(verifyNotionWebhook(signed(body, 'sha256=00'), { key }).ok).toBe(false);
    expect(verifyNotionWebhook(signed(body, ''), { key }).ok).toBe(false);
    const tampered = signed(body);
    tampered.rawBody = tampered.rawBody.replace('content_updated', 'created');
    expect(verifyNotionWebhook(tampered, { key }).ok).toBe(false);
    expect(verifyNotionWebhook(signed(body), { key: undefined }).ok).toBe(false);
  });

  it('acknowledges comment events without syncing', () => {
    expect(verifyNotionWebhook(signed(f('webhook-comment-created.json')), { key })).toEqual({
      ok: true,
      events: [],
    });
  });

  it('answers the verification handshake without logging the token', () => {
    const body = f<{ verification_token: string }>('webhook-verification.json');
    const got: string[] = [];
    const logs: string[] = [];
    const r = verifyNotionWebhook(
      { headers: {}, body, rawBody: JSON.stringify(body) },
      {
        key: undefined,
        onVerificationToken: (t) => void got.push(t),
        log: (m, fields) => logs.push(m + JSON.stringify(fields ?? {})),
      },
    );
    expect(r).toEqual({ ok: true, events: [], reply: { status: 200, body: { ok: true } } });
    expect(got).toEqual([body.verification_token]);
    expect(logs.join('\n')).toContain('NOTION_WEBHOOK_VERIFICATION_TOKEN');
    expect(logs.join('\n')).not.toContain(body.verification_token);
  });

  it('is exposed through the connector with the configured token', async () => {
    const c = connectorWith(notionApi().fetch);
    const r = await c.verifyWebhook(signed(f('webhook-page-content-updated.json')));
    expect(r.ok && r.events[0]!.routeKey).toBe(WS);
  });
});

describe('notion fake mode', () => {
  it('connects, syncs an edited page and verifies the fake-signed webhook', async () => {
    const store = new MemoryStore<FakeNotionState>(() => seedFakeNotion());
    const c = createNotionConnector({
      config: { fake: true },
      fakeStore: store,
      client: { minIntervalMs: 0 },
    });
    const url = new URL(
      c.connect.authUrl({ state: 'st', redirectUri: 'http://localhost:4000/cb', access: 'read' }),
    );
    const code = url.searchParams.get('code')!;
    expect(url.searchParams.get('state')).toBe('st');
    const ex = await c.connect.exchange({
      code,
      redirectUri: 'http://localhost:4000/cb',
      access: 'read',
    });
    const id = ex.identities![0]!;
    expect(id.routeKeys).toEqual(['ws-acme-0001']);

    const base = ctx(null, { externalId: id.externalId, tokens: ex.tokens, meta: id.meta! });
    const first = await c.fetchDelta(base);
    const edit = editFakePage(store, {
      workspaceId: 'ws-acme-0001',
      title: 'Standup',
      text: ' ship it',
      todo: true,
      mention: true,
    });
    const next = await c.fetchDelta({ ...base, cursor: first.cursor });
    const item = c.normalize(
      next.records.find((r) => r.page.id === edit.page.id)!,
      'pages',
    )!;
    expect(item).toMatchObject({
      title: 'Standup',
      body: '[ ] @Alex Kim ship it',
      author: 'Priya Raman',
      fromMe: false,
    });
    expect(item.labels).toContain('hub:mention');
    expect(item.labels).not.toContain('hub:from_me');

    const backfill = await c.backfill(base, { days: 7 });
    expect(backfill.records.length).toBeGreaterThanOrEqual(3);

    const body = {
      id: 'ev-1',
      type: 'page.created',
      workspace_id: 'ws-acme-0001',
      entity: { id: edit.page.id, type: 'page' },
    };
    const rawBody = JSON.stringify(body);
    const r = await c.verifyWebhook({
      headers: { 'x-notion-signature': notionSignature('fake-notion-token', rawBody) },
      body,
      rawBody,
    });
    expect(r.ok && r.events[0]).toMatchObject({
      providerEventId: 'ev-1',
      routeKey: 'ws-acme-0001',
    });
  });
});
