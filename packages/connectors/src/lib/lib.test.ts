import { describe, expect, it } from 'vitest';
import { ConnectorError, ReconnectRequiredError, RetryableError } from '../errors';
import { createHttp } from './http';
import { accessToken, refreshTokens } from './oauth2';
import { mockFetch } from './fake';
import { newSubscriptionSecret, sha256Hex } from './crypto';
import type { ConnectorContext } from '../types';

describe('createHttp', () => {
  it('maps statuses to typed errors without leaking bodies or queries', async () => {
    const { fetch } = mockFetch({
      'GET /a': { status: 401, body: { secret: 'x' } },
      'GET /b': { status: 429, headers: { 'retry-after': '3' } },
      'GET /c': { status: 503 },
      'GET /d': { status: 403, body: 'private text' },
      'GET /ok': { hello: 'world' },
    });
    const http = createHttp({ provider: 'p', baseUrl: 'https://api.example', fetch });
    await expect(http.request('/a')).rejects.toBeInstanceOf(ReconnectRequiredError);
    const e = await http
      .request<never>('/b', { query: { q: 'search terms' } })
      .catch((x: unknown) => x as RetryableError);
    expect(e).toBeInstanceOf(RetryableError);
    expect(e.retryAfterMs).toBe(3000);
    expect(e.message).not.toContain('search');
    await expect(http.request('/c')).rejects.toBeInstanceOf(RetryableError);
    const d = await http.request<never>('/d').catch((x: unknown) => x as RetryableError);
    expect(d).toBeInstanceOf(ConnectorError);
    expect(d.message).not.toContain('private');
    expect(await http.request('/ok')).toEqual({ hello: 'world' });
  });

  it('treats network failures as retryable', async () => {
    const http = createHttp({
      provider: 'p',
      baseUrl: 'https://x',
      fetch: (async () => {
        throw new TypeError('boom');
      }) as typeof fetch,
    });
    await expect(http.request('/')).rejects.toBeInstanceOf(RetryableError);
  });

  it('lets a body check turn 200 into an error (Slack ok:false)', async () => {
    const { fetch } = mockFetch({ 'GET /x': { ok: false, error: 'token_revoked' } });
    const http = createHttp({
      provider: 'slack',
      baseUrl: 'https://s',
      fetch,
      checkBody: (_s, b) =>
        (b as { ok?: boolean }).ok === false ? { reconnect: true, error: 'token_revoked' } : null,
    });
    await expect(http.request('/x')).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe('oauth2', () => {
  const cfg = (fetch: typeof globalThis.fetch) => ({
    provider: 'p',
    authorizeUrl: 'https://a/auth',
    tokenUrl: 'https://a/token',
    clientId: 'id',
    clientSecret: 'sec',
    fetch,
  });

  it('refreshes near expiry, saves the new tokens and keeps the refresh token when not rotated', async () => {
    const { fetch, calls } = mockFetch({
      'POST /token': { access_token: 'new', expires_in: 3600 },
    });
    let saved: unknown;
    const ctx = {
      tokens: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000 },
      saveTokens: async (t: unknown) => {
        saved = t;
      },
    } as unknown as ConnectorContext;
    expect(await accessToken(cfg(fetch), ctx)).toBe('new');
    expect(saved).toMatchObject({ accessToken: 'new', refreshToken: 'r1' });
    expect(calls[0]!.body).toContain('grant_type=refresh_token');
  });

  it('does not refresh a token that is still valid', async () => {
    const { fetch, calls } = mockFetch({});
    const ctx = {
      tokens: { accessToken: 'ok', expiresAt: Date.now() + 3600_000 },
      saveTokens: async () => {},
    } as unknown as ConnectorContext;
    expect(await accessToken(cfg(fetch), ctx)).toBe('ok');
    expect(calls).toHaveLength(0);
  });

  it('recovers when a sibling account rotated the shared refresh token first', async () => {
    // Sibling already refreshed: the stored token is fresh, so no second refresh is needed.
    const stored = { accessToken: 'sibling', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 };
    const { fetch: f2 } = mockFetch({
      'POST /token': { status: 400, body: { error: 'invalid_grant' } },
    });
    const ctx = {
      tokens: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1 },
      saveTokens: async () => {},
      reloadTokens: async () => stored,
    } as unknown as ConnectorContext;
    expect(await accessToken(cfg(f2), ctx)).toBe('sibling');
  });

  it('treats a rejected (401) access token as expired and re-reads the stored tokens first', async () => {
    const { fetch, calls } = mockFetch({
      'POST /token': { access_token: 'new', expires_in: 3600 },
    });
    const saved: unknown[] = [];
    const base = { refreshToken: 'r1', expiresAt: Date.now() + 3600_000 };
    // Stored token is the same one that was rejected: refresh.
    const a = {
      tokens: { accessToken: 'bad', ...base },
      saveTokens: async (t: unknown) => void saved.push(t),
      reloadTokens: async () => ({ accessToken: 'bad', ...base }),
    } as unknown as ConnectorContext;
    expect(await accessToken(cfg(fetch), a, Date.now(), { rejected: 'bad' })).toBe('new');
    expect(calls).toHaveLength(1);
    expect(saved).toHaveLength(1);
    // A sibling stored a different, fresh token: use it, no refresh.
    const b = {
      tokens: { accessToken: 'bad', ...base },
      saveTokens: async () => {},
      reloadTokens: async () => ({
        accessToken: 'sibling',
        refreshToken: 'r2',
        expiresAt: base.expiresAt,
      }),
    } as unknown as ConnectorContext;
    expect(await accessToken(cfg(fetch), b, Date.now(), { rejected: 'bad' })).toBe('sibling');
    expect(calls).toHaveLength(1);
  });

  it('still reports reconnect when the stored token is the same one that failed', async () => {
    const { fetch } = mockFetch({
      'POST /token': { status: 400, body: { error: 'invalid_grant' } },
    });
    const t = { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1 };
    const ctx = {
      tokens: t,
      saveTokens: async () => {},
      reloadTokens: async () => ({ ...t }),
    } as unknown as ConnectorContext;
    await expect(accessToken(cfg(fetch), ctx)).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it('refreshes under the grant lock and skips the refresh if a sibling already did', async () => {
    const { fetch, calls } = mockFetch({
      'POST /token': { access_token: 'mine', expires_in: 3600 },
    });
    const order: string[] = [];
    const sibling = {
      accessToken: 'from-sibling',
      refreshToken: 'r2',
      expiresAt: Date.now() + 3600_000,
    };
    const ctx = {
      tokens: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1 },
      saveTokens: async () => {},
      reloadTokens: async () => {
        order.push('reload');
        return sibling;
      },
      withRefreshLock: async <T>(fn: () => Promise<T>) => {
        order.push('lock');
        try {
          return await fn();
        } finally {
          order.push('unlock');
        }
      },
    } as unknown as ConnectorContext;
    expect(await accessToken(cfg(fetch), ctx)).toBe('from-sibling');
    expect(order).toEqual(['lock', 'reload', 'unlock']);
    expect(calls).toHaveLength(0);
  });

  it('maps invalid_grant to reconnect', async () => {
    const { fetch } = mockFetch({
      'POST /token': { status: 400, body: { error: 'invalid_grant' } },
    });
    await expect(
      refreshTokens(cfg(fetch), { accessToken: 'a', refreshToken: 'r' }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe('subscription secrets', () => {
  it('stores only the hash', () => {
    const { secret, secretHash } = newSubscriptionSecret();
    expect(secretHash).toBe(sha256Hex(secret));
    expect(secretHash).not.toContain(secret);
  });
});
