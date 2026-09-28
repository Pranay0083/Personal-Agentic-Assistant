import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountFilters } from '@hub/shared';
import { ReconnectRequiredError, RetryableError } from '../errors';
import type { ConnectorContext, OAuthTokens } from '../types';
import type { GmailConfig } from './config';
import { createGmailConnector } from './connector';
import { fixture } from './fixtures/index';

/**
 * Exercises the real @googleapis/gmail + OAuth2Client path against a local server that
 * replays recorded responses. No network, no real account.
 */
type Route = { status: number; body: unknown; headers?: Record<string, string> };
let routes: Record<string, Route> = {};
const seen: { method: string; path: string; auth: string | undefined; body: string }[] = [];
let server: Server;
let base = '';

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const body = await readBody(req);
    seen.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization, body });
    const r = routes[`${req.method} ${url.pathname}`] ?? {
      status: 404,
      body: fixture('history-404.json'),
    };
    res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  routes = {};
  seen.length = 0;
});

const config = (): GmailConfig => ({
  fake: false,
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  rootUrl: `${base}/`,
  oauthEndpoints: { oauth2TokenUrl: `${base}/token`, oauth2RevokeUrl: `${base}/revoke` },
});

function ctx(tokens: OAuthTokens, cursor: string | null = '1000') {
  const saved: OAuthTokens[] = [];
  const c: ConnectorContext = {
    accountId: '00000000-0000-4000-8000-000000000001',
    externalId: 'alex@company.example',
    tokens,
    saveTokens: async (t) => {
      saved.push(t);
    },
    cursor,
    filters: AccountFilters.parse({}),
  };
  return { c, saved };
}

const H = '/gmail/v1/users/me';

describe('real Gmail client (local fixture server)', () => {
  it('refreshes an expired access token, uses it, and saves it', async () => {
    routes = {
      'POST /token': { status: 200, body: fixture('token-refresh.json') },
      [`GET ${H}/history`]: { status: 200, body: { historyId: '1000' } },
    };
    const { c, saved } = ctx({
      accessToken: 'ya29.old',
      refreshToken: '1//refresh',
      expiresAt: Date.now() - 60_000,
    });
    const delta = await createGmailConnector({ config }).fetchDelta(c);
    expect(delta).toEqual({ records: [], cursor: '1000' });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /token', `GET ${H}/history`]);
    expect(seen[0]!.body).toContain('grant_type=refresh_token');
    expect(seen[1]!.auth).toBe('Bearer ya29.a0AfB_fixture-refreshed-access-token');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      accessToken: 'ya29.a0AfB_fixture-refreshed-access-token',
      refreshToken: '1//refresh',
    });
    expect(saved[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('pages history and fetches full messages', async () => {
    const page1 = fixture('history-page-1.json');
    const page2 = fixture('history-page-2.json');
    let n = 0;
    routes = {
      [`GET ${H}/messages/192a7c3e5b1d0a01`]: {
        status: 200,
        body: fixture('message-multipart.json'),
      },
      [`GET ${H}/messages/192a7c3e5b1d0a02`]: {
        status: 200,
        body: fixture('message-html-only.json'),
      },
      [`GET ${H}/messages/192a7c3e5b1d0a03`]: { status: 200, body: fixture('message-sent.json') },
    };
    Object.defineProperty(routes, `GET ${H}/history`, {
      enumerable: true,
      get: () => ({ status: 200, body: n++ === 0 ? page1 : page2 }),
    });
    const { c } = ctx({
      accessToken: 'ya29.ok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3600_000,
    });
    const delta = await createGmailConnector({ config }).fetchDelta(c);
    expect(delta.cursor).toBe('1005');
    expect(delta.records).toHaveLength(3);
    const historyCalls = seen.filter((s) => s.path.endsWith('/history'));
    expect(historyCalls).toHaveLength(2);
    expect(seen.find((s) => s.path.includes('/messages/'))!.auth).toBe('Bearer ya29.ok');
  });

  it('404 on history.list returns fullResyncRequired', async () => {
    routes = {
      [`GET ${H}/history`]: { status: 404, body: fixture('history-404.json') },
      [`GET ${H}/profile`]: { status: 200, body: fixture('profile.json') },
    };
    const { c } = ctx({ accessToken: 'ya29.ok', expiresAt: Date.now() + 3600_000 });
    expect(await createGmailConnector({ config }).fetchDelta(c)).toEqual({
      records: [],
      cursor: '1000',
      fullResyncRequired: true,
    });
  });

  it('invalid_grant on refresh becomes ReconnectRequiredError', async () => {
    routes = { 'POST /token': { status: 400, body: fixture('token-invalid-grant.json') } };
    const { c } = ctx({
      accessToken: 'ya29.old',
      refreshToken: '1//revoked',
      expiresAt: Date.now() - 1,
    });
    await expect(createGmailConnector({ config }).fetchDelta(c)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });

  it('429 becomes RetryableError with retry-after', async () => {
    routes = {
      [`GET ${H}/history`]: {
        status: 429,
        body: fixture('error-429.json'),
        headers: { 'retry-after': '3' },
      },
    };
    const { c } = ctx({ accessToken: 'ya29.ok', expiresAt: Date.now() + 3600_000 });
    const err = await createGmailConnector({ config })
      .fetchDelta(c)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryAfterMs).toBe(3000);
  });

  it('builds read and write consent URLs with separate scopes', () => {
    const conn = createGmailConnector({ config });
    const read = new URL(
      conn.connect.authUrl({
        state: 's1',
        redirectUri: 'http://localhost:4000/cb',
        access: 'read',
        loginHint: 'alex@company.example',
      }),
    );
    expect(read.searchParams.get('scope')!.split(' ')).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/chat.messages.readonly',
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'openid',
      'email',
    ]);
    expect(read.searchParams.get('access_type')).toBe('offline');
    expect(read.searchParams.get('prompt')).toBe('consent');
    expect(read.searchParams.get('include_granted_scopes')).toBe('false');
    expect(read.searchParams.get('login_hint')).toBe('alex@company.example');
    expect(read.searchParams.get('state')).toBe('s1');
    const write = new URL(
      conn.connect.authUrl({
        state: 's2',
        redirectUri: 'http://localhost:4000/cb',
        access: 'write',
      }),
    );
    const ws = write.searchParams.get('scope')!;
    expect(ws).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(ws).not.toContain('gmail.readonly');
    expect(ws).not.toContain('calendar');
  });
});
