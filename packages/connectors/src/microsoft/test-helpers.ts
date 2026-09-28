/** Shared test setup for the Microsoft connector tests (not a test file itself). */
import type { AccountFilters } from '@hub/shared';
import { fixture, mockFetch } from '../lib/index';
import type { ConnectorContext, OAuthTokens } from '../types';
import { GRAPH_BASE_URL, LOGIN_BASE_URL, type MicrosoftConfig } from './config';
import { createMicrosoftConnector } from './connector';

export const NOW = Date.parse('2026-09-28T10:00:00Z');
export const WORK_ID = '6b1f3c2a-9d4e-4f7a-8c1b-2e3d4f5a6b7c';

/**
 * Recorded fixtures. Token endpoint fixtures store id_token claims as `{"$jwt": {...}}`
 * and are encoded to an unsigned-looking JWT here, so no token-shaped strings live in the
 * repo (secret scanners flag them even when they're fake).
 */
export const fx = <T = unknown>(name: string) =>
  withJwts(fixture<unknown>(import.meta.url, name)) as T;

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function withJwts(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withJwts);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length === 1 && o.$jwt && typeof o.$jwt === 'object') {
    return `${b64u({ typ: 'JWT', alg: 'RS256', kid: 'fixture' })}.${b64u(o.$jwt)}.fixture-signature`;
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, withJwts(x)]));
}

export function testConfig(over: Partial<MicrosoftConfig> = {}): MicrosoftConfig {
  return {
    fake: false,
    clientId: 'client-read',
    clientSecret: 'secret-read',
    tenant: 'common',
    gatewayUrl: 'https://hub.example',
    channelMessages: false,
    graphBaseUrl: GRAPH_BASE_URL,
    loginBaseUrl: LOGIN_BASE_URL,
    pageSize: 50,
    maxPages: 10,
    calendarDaysAhead: 30,
    now: () => NOW,
    ...over,
  };
}

export const defaultFilters = (over: Partial<AccountFilters> = {}): AccountFilters => ({
  inbox: true,
  sent: true,
  promotions: false,
  labels: [],
  sources: {},
  options: {},
  ...over,
});

export function testCtx(over: Partial<ConnectorContext> = {}): ConnectorContext & {
  saved: OAuthTokens[];
} {
  const saved: OAuthTokens[] = [];
  return {
    accountId: 'acc-1',
    externalId: WORK_ID,
    tokens: { accessToken: 'at-valid', refreshToken: 'rt-1', expiresAt: NOW + 3600_000 },
    saveTokens: async (t) => {
      saved.push(t);
    },
    source: 'mail',
    cursor: null,
    filters: defaultFilters(),
    meta: { upn: 'avery.chen@contoso.example', mail: 'avery.chen@contoso.example' },
    subscription: null,
    saved,
    ...over,
  };
}

/** A connector replaying recorded Graph responses. */
export function replay(
  routes: Parameters<typeof mockFetch>[0],
  over: Partial<MicrosoftConfig> = {},
) {
  const mock = mockFetch(routes);
  const connector = createMicrosoftConnector({ config: testConfig(over), fetch: mock.fetch });
  return { connector, calls: mock.calls };
}

/** A route whose body depends on the query (same path, several pages). */
export const byQuery = (fn: (u: URL) => unknown) => ({ status: 200, body: fn });

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/**
 * A connector whose fetch is a handler over (method, url) — for cases where the status
 * depends on the query (mockFetch matches the bare path first).
 */
export function replayWith(
  handler: (method: string, url: URL, body: string | undefined) => Reply,
  over: Partial<MicrosoftConfig> = {},
) {
  const calls: {
    method: string;
    url: URL;
    body: string | undefined;
    headers: Record<string, string>;
  }[] = [];
  const fetchFn = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      method,
      url,
      body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const r = handler(method, url, body);
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  }) as typeof fetch;
  const connector = createMicrosoftConnector({ config: testConfig(over), fetch: fetchFn });
  return { connector, calls };
}
