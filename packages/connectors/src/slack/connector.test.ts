import { AccountFilters } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import {
  ConnectorError,
  MissingScopeError,
  ReconnectRequiredError,
  RetryableError,
} from '../errors';
import { sha256Hex } from '../lib/crypto';
import { fixture, mockFetch } from '../lib/fake';
import type { ConnectorContext, OAuthTokens } from '../types';
import type { SlackConfig } from './config';
import { createSlackConnector } from './connector';
import { decodeCursor, encodeCursor } from './delta';

const NOW = 1_790_596_800_000;
const load = <T = Record<string, unknown>>(name: string) => fixture<T>(import.meta.url, name);
type Routes = Parameters<typeof mockFetch>[0];

const config: SlackConfig = {
  fake: false,
  clientId: 'cid',
  clientSecret: 'csecret',
  signingSecret: 'ssecret',
  apiBase: 'https://slack.com/api',
  authorizeUrl: 'https://slack.com/oauth/v2/authorize',
};

const writeApp: SlackConfig = {
  ...config,
  writeClientId: 'wcid',
  writeClientSecret: 'wsecret',
};

function make(
  routes: Routes,
  over: { pageSize?: number; maxPagesPerDelta?: number; config?: SlackConfig } = {},
) {
  const mock = mockFetch(routes);
  const connector = createSlackConnector({ config, fetch: mock.fetch, now: () => NOW, ...over });
  return { connector, calls: mock.calls };
}

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    accountId: 'acc-1',
    externalId: 'T0ACME0001:U0ALEX0001',
    tokens: { accessToken: 'xoxp-test' },
    saveTokens: async () => {},
    source: 'messages',
    cursor: null,
    filters: AccountFilters.parse({}),
    meta: { teamDomain: 'acme-eng' },
    ...over,
  };
}

const users: Record<string, unknown> = {
  U0PRIYA001: load('users-info-priya.json'),
  U0ALEX0001: load('users-info-alex.json'),
  U0SAMLEE01: load('users-info-sam.json'),
  U0DEPLOY01: load('users-info-bot.json'),
};
const byPage = (pages: Record<string, unknown>) => ({
  status: 200,
  body: (u: URL) => pages[u.searchParams.get('page') ?? '1'] ?? load('search-empty.json'),
});
const readRoutes = (extra: Routes = {}): Routes => ({
  'GET /api/search.messages': byPage({
    '1': load('search-page-1.json'),
    '2': load('search-page-2.json'),
  }),
  'GET /api/users.info': {
    status: 200,
    body: (u: URL) => users[u.searchParams.get('user') ?? ''] ?? load('users-info-not-found.json'),
  },
  'GET /api/users.conversations': load('users-conversations.json'),
  ...extra,
});
const FLOOR = '1790593200.000000';

describe('slack connect', () => {
  it('builds a user-scope authorize URL with read scopes only', () => {
    const { connector } = make({}, { config: writeApp });
    const u = new URL(
      connector.connect.authUrl({ state: 's1', redirectUri: 'https://api.x/cb', access: 'read' }),
    );
    expect(u.origin + u.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(u.searchParams.get('user_scope')?.split(',')).toEqual([
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
      'channels:read',
      'groups:read',
      'im:read',
      'mpim:read',
      'users:read',
      'search:read',
    ]);
    expect(u.searchParams.has('scope')).toBe(false);
    const w = new URL(
      connector.connect.authUrl({ state: 's', redirectUri: 'https://api.x/cb', access: 'write' }),
    );
    expect(w.searchParams.get('user_scope')).toBe('chat:write');
    expect(w.searchParams.get('client_id')).toBe('wcid');
    expect(u.searchParams.get('client_id')).toBe('cid');
  });

  it('offers the write consent only with a separate write app (or fake mode)', async () => {
    expect(make({}).connector.writeConfigured!()).toBe(false);
    expect(
      make({}, { config: { ...config, writeClientId: 'wcid' } }).connector.writeConfigured!(),
    ).toBe(false);
    expect(make({}, { config: writeApp }).connector.writeConfigured!()).toBe(true);
    expect(make({}, { config: { ...config, fake: true } }).connector.writeConfigured!()).toBe(true);

    const { connector, calls } = make({
      'POST /api/oauth.v2.access': load('oauth-v2-access-write.json'),
    });
    expect(() =>
      connector.connect.authUrl({ state: 's', redirectUri: 'https://api.x/cb', access: 'write' }),
    ).toThrow(ConnectorError);
    // Never falls back to the read app for a write code exchange either.
    await expect(
      connector.connect.exchange({ code: 'c', redirectUri: 'https://x/cb', access: 'write' }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(calls).toHaveLength(0);
  });

  it('exchanges the code for the user token with rotation and one identity per workspace', async () => {
    const { connector, calls } = make({
      'POST /api/oauth.v2.access': load('oauth-v2-access.json'),
      'GET /api/auth.test': load('auth-test.json'),
    });
    const r = await connector.connect.exchange({
      code: 'c0de',
      redirectUri: 'https://api.x/cb',
      access: 'read',
    });
    expect(r.tokens).toMatchObject({
      accessToken: 'xoxe.xoxp-1-test-read-token',
      refreshToken: 'xoxe-1-test-refresh',
      expiresAt: NOW + 43_200_000,
    });
    expect(r.externalId).toBe('T0ACME0001:U0ALEX0001');
    expect(r.displayName).toBe('Acme Engineering');
    expect(r.identities).toEqual([
      {
        externalId: 'T0ACME0001:U0ALEX0001',
        displayName: 'Acme Engineering',
        routeKeys: ['T0ACME0001'],
        meta: {
          teamId: 'T0ACME0001',
          teamName: 'Acme Engineering',
          teamDomain: 'acme-eng',
          userId: 'U0ALEX0001',
          grantedScopes: expect.arrayContaining(['channels:history', 'search:read']),
        },
      },
    ]);
    expect(calls[0]!.body).toContain('code=c0de');
    expect(calls[0]!.body).toContain('client_secret=csecret');
    expect(calls[1]!.headers.authorization).toBe('Bearer xoxe.xoxp-1-test-read-token');
  });

  it('rejects write scopes in a read grant and missing read scopes', async () => {
    const withWrite = load<{ authed_user: { scope: string } }>('oauth-v2-access.json');
    withWrite.authed_user.scope += ',chat:write';
    const a = make({
      'POST /api/oauth.v2.access': withWrite,
      'GET /api/auth.test': load('auth-test.json'),
    });
    await expect(
      a.connector.connect.exchange({ code: 'c', redirectUri: 'https://x/cb', access: 'read' }),
    ).rejects.toThrow(/write scopes/);

    const narrow = load<{ authed_user: { scope: string } }>('oauth-v2-access.json');
    narrow.authed_user.scope = 'channels:history,users:read';
    const b = make({ 'POST /api/oauth.v2.access': narrow });
    await expect(
      b.connector.connect.exchange({ code: 'c', redirectUri: 'https://x/cb', access: 'read' }),
    ).rejects.toBeInstanceOf(MissingScopeError);
  });

  it('accepts a chat:write grant for the write consent', async () => {
    const { connector, calls } = make(
      {
        'POST /api/oauth.v2.access': load('oauth-v2-access-write.json'),
        'GET /api/auth.test': load('auth-test.json'),
      },
      { config: writeApp },
    );
    const r = await connector.connect.exchange({
      code: 'c',
      redirectUri: 'https://x/cb',
      access: 'write',
    });
    expect(r.externalId).toBe('T0ACME0001:U0ALEX0001');
    expect(r.tokens.scope).toBe('chat:write');
    expect(calls[0]!.body).toContain('client_secret=wsecret');
  });

  it('maps an invalid code to a ConnectorError', async () => {
    const { connector } = make({
      'POST /api/oauth.v2.access': { ok: false, error: 'invalid_code' },
    });
    const e = await connector.connect
      .exchange({ code: 'bad', redirectUri: 'https://x/cb', access: 'read' })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConnectorError);
    expect(e).not.toBeInstanceOf(ReconnectRequiredError);
  });

  it('revoke calls auth.revoke and ignores an already revoked token', async () => {
    const a = make({ 'GET /api/auth.revoke': load('auth-revoke.json') });
    await a.connector.connect.revoke({ accessToken: 'xoxp-test' });
    expect(a.calls[0]!.url.pathname).toBe('/api/auth.revoke');
    const b = make({ 'GET /api/auth.revoke': load('error-token-revoked.json') });
    await expect(b.connector.connect.revoke({ accessToken: 'xoxp-test' })).resolves.toBeUndefined();
  });

  it('is configured only with client id, secret and signing secret', () => {
    expect(createSlackConnector({ config }).configured()).toBe(true);
    expect(
      createSlackConnector({ config: { ...config, signingSecret: undefined } }).configured(),
    ).toBe(false);
    expect(
      createSlackConnector({ config: { ...config, clientId: undefined, fake: true } }).configured(),
    ).toBe(true);
  });
});

describe('slack fetchDelta', () => {
  it('starts from now without calls when there is no cursor', async () => {
    const { connector, calls } = make({});
    const r = await connector.fetchDelta(ctx());
    expect(r.records).toEqual([]);
    expect(decodeCursor(r.cursor)).toEqual({ v: 1, ts: '1790596800.000000' });
    expect(calls).toHaveLength(0);
  });

  it('asks for a backfill when the cursor is unreadable', async () => {
    const { connector } = make({});
    const r = await connector.fetchDelta(ctx({ cursor: '12345' }));
    expect(r.fullResyncRequired).toBe(true);
  });

  it('pages search results newest first down to the cursor, skipping noise and unjoined channels', async () => {
    const { connector, calls } = make(readRoutes(), { pageSize: 4 });
    const r = await connector.fetchDelta(ctx({ cursor: encodeCursor({ v: 1, ts: FLOOR }) }));
    const items = r.records.map((x) => connector.normalize(x)!);
    expect(items.map((i) => i.externalId)).toEqual([
      'C0LAUNCH01:1790596700.000100',
      'D0PRIYA001:1790596600.000200',
      'C0GENERAL1:1790595000.000500',
      'G0MPIM0001:1790594000.000600',
    ]);
    expect(items[0]).toMatchObject({
      author: 'Priya',
      body: '@Alex can you confirm the checklist by Thursday? <3',
      labels: expect.arrayContaining([
        'slack:thread:1790590000.000100',
        'slack:mentions:me',
        'hub:mention',
        'slack:channel_name:launch',
      ]),
    });
    expect(items[1]!.labels).toContain('hub:dm');
    expect(items[2]!.labels).toEqual(
      expect.arrayContaining(['hub:from_me', 'slack:channel_name:general']),
    );
    expect(items[3]!.labels.filter((l) => l.startsWith('hub:'))).toEqual([]);
    expect(items[1]).toMatchObject({ title: 'DM · Priya', fromMe: false, threadId: 'D0PRIYA001' });
    expect(items[2]).toMatchObject({
      fromMe: true,
      author: 'Alex',
      body: 'Standup moved to 10:30 in #launch',
    });
    expect(items[3]).toMatchObject({ author: 'Sam Lee', title: 'Group DM' });
    expect(r.hasMore).toBeUndefined();
    expect(decodeCursor(r.cursor)?.ts).toBe('1790596700.000100');

    const searches = calls.filter((c) => c.url.pathname === '/api/search.messages');
    expect(searches.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(searches[0]!.url.searchParams.get('query')).toBe('after:2026-09-26');
    expect(searches[0]!.url.searchParams.get('sort')).toBe('timestamp');
    expect(searches[0]!.url.searchParams.get('sort_dir')).toBe('desc');
    // users.info is cached per call: one lookup per distinct user.
    const lookups = calls
      .filter((c) => c.url.pathname === '/api/users.info')
      .map((c) => c.url.searchParams.get('user'));
    expect(new Set(lookups).size).toBe(lookups.length);
    expect(calls.filter((c) => c.url.pathname === '/api/users.conversations')).toHaveLength(1);
  });

  it('resumes a long scan across calls (hasMore) without skipping anything', async () => {
    const { connector } = make(readRoutes(), { pageSize: 4, maxPagesPerDelta: 1 });
    const first = await connector.fetchDelta(ctx({ cursor: encodeCursor({ v: 1, ts: FLOOR }) }));
    expect(first.hasMore).toBe(true);
    const c1 = decodeCursor(first.cursor)!;
    expect(c1.ts).toBe(FLOOR);
    expect(c1.scan).toEqual({ top: '1790596700.000100', below: '1790596400.000400', page: 2 });
    expect(first.records.map((x) => x.message.ts)).toEqual([
      '1790596700.000100',
      '1790596600.000200',
    ]);

    const second = await connector.fetchDelta(ctx({ cursor: first.cursor }));
    expect(second.hasMore).toBeUndefined();
    expect(second.records.map((x) => x.message.ts)).toEqual([
      '1790595000.000500',
      '1790594000.000600',
    ]);
    const c2 = decodeCursor(second.cursor)!;
    expect(c2).toMatchObject({ ts: '1790596700.000100' });
    expect(c2.scan).toBeUndefined();
  });

  it('rescans the overlap window and returns only late-indexed messages', async () => {
    const first = make(readRoutes(), { pageSize: 4 });
    const r1 = await first.connector.fetchDelta(ctx({ cursor: encodeCursor({ v: 1, ts: FLOOR }) }));
    const late = load<{ messages: { matches: Record<string, unknown>[] } }>('search-page-1.json');
    const lateMatch = {
      ...late.messages.matches[1]!,
      ts: '1790596650.000900',
      permalink: 'https://acme-eng.slack.com/archives/D0PRIYA001/p1790596650000900',
    };
    late.messages.matches = [late.messages.matches[0]!, lateMatch, late.messages.matches[1]!];
    (late.messages as unknown as { paging: { pages: number } }).paging.pages = 1;
    const second = make(readRoutes({ 'GET /api/search.messages': byPage({ '1': late }) }));
    const r2 = await second.connector.fetchDelta(ctx({ cursor: r1.cursor }));
    expect(r2.records.map((x) => x.message.ts)).toEqual(['1790596650.000900']);
  });

  it('applies the Scope options: mentions only, DMs off', async () => {
    const mentions = make(readRoutes(), { pageSize: 4 });
    const r = await mentions.connector.fetchDelta(
      ctx({
        cursor: encodeCursor({ v: 1, ts: FLOOR }),
        filters: AccountFilters.parse({ options: { channels: 'mentions' } }),
      }),
    );
    expect(r.records.map((x) => x.channel.id)).toEqual(['C0LAUNCH01', 'D0PRIYA001', 'G0MPIM0001']);
    // No membership lookup needed when only mentions are read.
    expect(mentions.calls.some((c) => c.url.pathname === '/api/users.conversations')).toBe(false);

    const noDms = make(readRoutes(), { pageSize: 4 });
    const r2 = await noDms.connector.fetchDelta(
      ctx({
        cursor: encodeCursor({ v: 1, ts: FLOOR }),
        filters: AccountFilters.parse({ options: { dms: false } }),
      }),
    );
    expect(r2.records.map((x) => x.channel.id)).toEqual(['C0LAUNCH01', 'C0GENERAL1']);
  });

  it('maps HTTP 429 with Retry-After to RetryableError', async () => {
    const { connector } = make({
      'GET /api/search.messages': {
        status: 429,
        headers: { 'retry-after': '30' },
        body: load('error-ratelimited.json'),
      },
    });
    const e = await connector
      .fetchDelta(ctx({ cursor: encodeCursor({ v: 1, ts: FLOOR }) }))
      .then(() => null)
      .catch((x: unknown) => x as RetryableError);
    expect(e).toBeInstanceOf(RetryableError);
    expect(e?.retryAfterMs).toBe(30_000);
  });

  it('maps ok:false errors: ratelimited → retry, invalid_auth/token_revoked → reconnect', async () => {
    const cur = encodeCursor({ v: 1, ts: FLOOR });
    for (const [name, type] of [
      ['error-ratelimited.json', RetryableError],
      ['error-invalid-auth.json', ReconnectRequiredError],
      ['error-token-revoked.json', ReconnectRequiredError],
    ] as const) {
      const { connector } = make({ 'GET /api/search.messages': load(name) });
      const e = await connector
        .fetchDelta(ctx({ cursor: cur }))
        .then(() => null)
        .catch((x: unknown) => x as Error);
      expect(e).toBeInstanceOf(type);
      expect(e?.message).not.toContain('xoxp');
    }
  });

  it('refreshes a rotated token before it expires and saves it', async () => {
    const { connector, calls } = make(
      readRoutes({ 'POST /api/oauth.v2.access': load('oauth-v2-refresh.json') }),
      { pageSize: 4 },
    );
    let saved: OAuthTokens | null = null;
    const c = ctx({
      cursor: encodeCursor({ v: 1, ts: FLOOR }),
      tokens: { accessToken: 'xoxe.xoxp-old', refreshToken: 'xoxe-1-r', expiresAt: NOW + 10_000 },
      saveTokens: async (t) => {
        saved = t;
      },
    });
    await connector.fetchDelta(c);
    expect(saved).toMatchObject({
      accessToken: 'xoxe.xoxp-1-test-rotated',
      refreshToken: 'xoxe-1-test-refresh-2',
    });
    expect(calls[0]!.body).toContain('grant_type=refresh_token');
    expect(calls[1]!.headers.authorization).toBe('Bearer xoxe.xoxp-1-test-rotated');
  });

  it('refreshes once on token_expired, then gives up with reconnect', async () => {
    let n = 0;
    const { connector } = make({
      'GET /api/search.messages': {
        status: 200,
        body: () => (n++ === 0 ? load('error-token-expired.json') : load('search-empty.json')),
      },
      'POST /api/oauth.v2.access': load('oauth-v2-refresh.json'),
    });
    const c = ctx({
      cursor: encodeCursor({ v: 1, ts: FLOOR }),
      tokens: { accessToken: 'a', refreshToken: 'r' },
    });
    await expect(connector.fetchDelta(c)).resolves.toMatchObject({ records: [] });

    const dead = make({
      'GET /api/search.messages': load('error-token-expired.json'),
      'POST /api/oauth.v2.access': { ok: false, error: 'invalid_refresh_token' },
    });
    await expect(
      dead.connector.fetchDelta(
        ctx({
          cursor: encodeCursor({ v: 1, ts: FLOOR }),
          tokens: { accessToken: 'a', refreshToken: 'r' },
        }),
      ),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it('refuses a refreshed read token that gained write scopes, without saving it', async () => {
    const refreshed = load<{ scope: string }>('oauth-v2-refresh.json');
    refreshed.scope += ',chat:write';
    const { connector, calls } = make(readRoutes({ 'POST /api/oauth.v2.access': refreshed }), {
      config: writeApp,
    });
    const saved: OAuthTokens[] = [];
    const c = ctx({
      cursor: encodeCursor({ v: 1, ts: FLOOR }),
      tokens: {
        accessToken: 'xoxe.xoxp-old',
        refreshToken: 'xoxe-1-r',
        expiresAt: NOW + 10_000,
        scope: 'channels:history,search:read',
      },
      saveTokens: async (t) => {
        saved.push(t);
      },
    });
    await expect(connector.fetchDelta(c)).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(saved).toHaveLength(0);
    expect(calls).toHaveLength(1);
    // The read token refreshes through the read app.
    expect(calls[0]!.body).toContain('client_id=cid');
  });

  it('refreshes a write-app token through the write app', async () => {
    const refreshed = {
      ...load<Record<string, unknown>>('oauth-v2-refresh.json'),
      scope: 'chat:write',
    };
    const { connector, calls } = make(
      {
        'POST /api/oauth.v2.access': refreshed,
        'POST /api/chat.postMessage': load('chat-post-message.json'),
      },
      { config: writeApp },
    );
    const saved: OAuthTokens[] = [];
    await connector.execute!(
      ctx({
        tokens: {
          accessToken: 'w',
          refreshToken: 'wr',
          expiresAt: NOW + 10_000,
          scope: 'chat:write',
        },
        saveTokens: async (t) => {
          saved.push(t);
        },
      }),
      'slack.post',
      { channel: 'C0ENG00001', text: 'hi' },
      'key-1',
    );
    expect(calls[0]!.body).toContain('client_id=wcid');
    expect(saved[0]?.scope).toBe('chat:write');
  });

  it('rejects unknown sources', async () => {
    const { connector } = make({});
    await expect(connector.fetchDelta(ctx({ source: 'mail' }))).rejects.toThrow(/unknown source/);
  });
});

describe('slack backfill', () => {
  it('is bounded by days and pages', async () => {
    const { connector, calls } = make(readRoutes(), { pageSize: 4 });
    const r = await connector.backfill(ctx(), { days: 365 });
    // 365 is clamped to 90 days: query starts 91 days back.
    expect(calls[0]!.url.searchParams.get('query')).toBe('after:2026-06-29');
    expect(r.nextPageToken).toBe('2');
    expect(r.records.map((x) => x.message.ts)).toEqual(['1790596700.000100', '1790596600.000200']);
    const last = await connector.backfill(ctx(), { days: 1, pageToken: '21' });
    expect(last).toEqual({ records: [], nextPageToken: null });
  });

  it('stops paging at the cutoff', async () => {
    const { connector } = make(readRoutes(), { pageSize: 4 });
    // Everything on page 2 is newer than a day ago: keep paging.
    const r = await connector.backfill(ctx(), { days: 1, pageToken: '2' });
    expect(r.nextPageToken).toBe('3');
    // Here page 2 crosses the cutoff: stop.
    const tight = createSlackConnector({
      config,
      fetch: mockFetch(readRoutes()).fetch,
      now: () => 1_790_594_500_000 + 86_400_000,
      pageSize: 4,
    });
    const r2 = await tight.backfill(ctx(), { days: 1, pageToken: '2' });
    expect(r2.nextPageToken).toBeNull();
  });
});

describe('slack execute and findExecuted', () => {
  const payload = {
    channel: 'C0LAUNCH01',
    text: 'Done, checklist confirmed.',
    threadTs: '1790590000.000100',
  };

  it('posts with thread_ts and hub_action metadata keyed by sha256(idempotencyKey)', async () => {
    const { connector, calls } = make({
      'POST /api/chat.postMessage': load('chat-post-message.json'),
    });
    const r = await connector.execute!(
      ctx({ tokens: { accessToken: 'xoxp-write' } }),
      'slack.post',
      payload,
      'key-1',
    );
    expect(r).toEqual({
      externalId: 'C0LAUNCH01:1790596800.001000',
      channel: 'C0LAUNCH01',
      ts: '1790596800.001000',
      threadTs: '1790590000.000100',
    });
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      channel: 'C0LAUNCH01',
      text: 'Done, checklist confirmed.',
      thread_ts: '1790590000.000100',
      metadata: { event_type: 'hub_action', event_payload: { key: sha256Hex('key-1') } },
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(JSON.stringify(body)).not.toContain('"key-1"');
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxp-write');
  });

  it('validates the payload and the action', async () => {
    const { connector, calls } = make({});
    await expect(
      connector.execute!(ctx(), 'slack.post', { channel: '', text: 'x' }, 'k'),
    ).rejects.toThrow();
    await expect(connector.execute!(ctx(), 'slack.delete', payload, 'k')).rejects.toThrow(
      /unsupported/,
    );
    expect(calls).toHaveLength(0);
  });

  it('surfaces Slack errors (channel_not_found) as ConnectorError', async () => {
    const { connector } = make({
      'POST /api/chat.postMessage': load('error-channel-not-found.json'),
    });
    await expect(connector.execute!(ctx(), 'slack.post', payload, 'k')).rejects.toThrow(
      /channel_not_found/,
    );
  });

  const withKey = (name: string, key: string) => {
    const f = load<{ messages: { metadata?: { event_payload: { key: string } } }[] }>(name);
    for (const m of f.messages) if (m.metadata) m.metadata.event_payload.key = sha256Hex(key);
    return f;
  };

  it('finds an earlier post in a thread via the user’s recent messages', async () => {
    const { connector, calls } = make({
      'GET /api/search.messages': load('search-from-me.json'),
      'GET /api/conversations.replies': withKey('conversations-replies-metadata.json', 'key-1'),
      'GET /api/conversations.history': withKey('conversations-history-metadata.json', 'other'),
    });
    const r = await connector.findExecuted!(ctx(), 'slack.post', 'key-1');
    expect(r).toEqual({
      externalId: 'C0LAUNCH01:1790596000.000900',
      channel: 'C0LAUNCH01',
      ts: '1790596000.000900',
      threadTs: '1790590000.000100',
    });
    const s = calls[0]!.url.searchParams;
    expect(s.get('query')).toBe('from:<@U0ALEX0001> after:2026-09-24');
    const replies = calls.find((c) => c.url.pathname === '/api/conversations.replies')!;
    expect(replies.url.searchParams.get('include_all_metadata')).toBe('true');
    expect(replies.url.searchParams.get('ts')).toBe('1790590000.000100');
  });

  it('finds an earlier top-level post via conversations.history with metadata', async () => {
    const { connector, calls } = make({
      'GET /api/search.messages': load('search-from-me.json'),
      'GET /api/conversations.replies': withKey('conversations-replies-metadata.json', 'other'),
      'GET /api/conversations.history': withKey('conversations-history-metadata.json', 'key-2'),
    });
    const r = await connector.findExecuted!(ctx(), 'slack.post', 'key-2');
    expect(r).toMatchObject({ externalId: 'C0GENERAL1:1790595000.000500', threadTs: null });
    const h = calls.find((c) => c.url.pathname === '/api/conversations.history')!;
    expect(h.url.searchParams.get('channel')).toBe('C0GENERAL1');
    expect(h.url.searchParams.get('include_all_metadata')).toBe('true');
  });

  it('returns null when nothing carries the key', async () => {
    const { connector } = make({
      'GET /api/search.messages': load('search-from-me.json'),
      'GET /api/conversations.replies': withKey('conversations-replies-metadata.json', 'a'),
      'GET /api/conversations.history': withKey('conversations-history-metadata.json', 'b'),
    });
    expect(await connector.findExecuted!(ctx(), 'slack.post', 'key-3')).toBeNull();
    expect(await connector.findExecuted!(ctx(), 'gmail.send', 'key-3')).toBeNull();
  });
});
