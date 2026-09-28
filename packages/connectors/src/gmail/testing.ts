import { AccountFilters } from '@hub/shared';
import type { ConnectorContext, OAuthTokens } from '../types';
import { FakeHttpError } from './fake';
import type { GoogleRequest, GoogleRest, GoogleRestFactory } from './rest';

/**
 * Test helper: a GoogleRest that answers from a table of recorded responses keyed by
 * `METHOD host/path`. A function value gets the request (and the call count) and may
 * throw a FakeHttpError to replay an error response. Unknown routes answer 404.
 */
export function recordedRest(
  routes: Record<string, unknown | ((req: GoogleRequest, n: number) => unknown)>,
) {
  const calls: (GoogleRequest & { key: string })[] = [];
  const counts = new Map<string, number>();
  const rest: GoogleRest = async <T>(req: GoogleRequest) => {
    const u = new URL(req.url);
    const key = `${req.method ?? 'GET'} ${u.host}${u.pathname}`;
    calls.push({ ...req, key });
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const r = routes[key];
    if (r === undefined) throw new FakeHttpError(404, { error: { code: 404 } });
    const v =
      typeof r === 'function' ? await (r as (q: GoogleRequest, n: number) => unknown)(req, n) : r;
    return structuredClone(v) as T;
  };
  const factory: GoogleRestFactory = () => rest;
  return { rest, factory, calls };
}

export const fail = (status: number, body: unknown) => () => {
  throw new FakeHttpError(status, body);
};

export function testCtx(
  source: string,
  opts: {
    cursor?: string | null;
    tokens?: OAuthTokens;
    externalId?: string;
    meta?: Record<string, unknown>;
    subscription?: ConnectorContext['subscription'];
  } = {},
): ConnectorContext {
  return {
    accountId: '00000000-0000-4000-8000-000000000001',
    externalId: opts.externalId ?? 'alex@company.example',
    tokens: opts.tokens ?? { accessToken: 'ya29.fixture', expiresAt: Date.now() + 3600_000 },
    saveTokens: async () => {},
    source,
    cursor: opts.cursor ?? null,
    filters: AccountFilters.parse({}),
    ...(opts.meta ? { meta: opts.meta } : {}),
    ...(opts.subscription !== undefined ? { subscription: opts.subscription } : {}),
  };
}
