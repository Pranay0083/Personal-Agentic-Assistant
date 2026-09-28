import { ConnectorError, ReconnectRequiredError } from '../errors';
import { createHttp, toTokens, type FetchFn, type TokenResponse } from '../lib/index';
import type { AccessKind, ConnectorContext, OAuthTokens } from '../types';
import {
  clientFor,
  normalizeScopes,
  scopesFor,
  tokenUrl,
  writeScopesIn,
  type MicrosoftConfig,
} from './config';

export const PROVIDER = 'microsoft';

/** Delta state tokens Graph no longer knows. Mapped to 410 so callers see one signal. */
const SYNC_STATE_CODES =
  /^(syncStateNotFound|syncStateInvalid|resyncRequired|ErrorInvalidSyncStateData|ErrorSyncFolderNotFound)$/i;

/**
 * Wraps fetch so an expired delta token always surfaces as HTTP 410, whatever the
 * workload returns (Outlook: 410 SyncStateNotFound, sometimes 400; OneDrive: 410
 * resyncRequired). The error body is inspected here and never logged or rethrown.
 */
export function graphFetch(inner: FetchFn): FetchFn {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    if (res.status !== 400 && res.status !== 404) return res;
    const text = await res.text();
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
    } catch {
      code = undefined;
    }
    if (code && SYNC_STATE_CODES.test(code)) {
      return new Response(text, { status: 410, headers: res.headers });
    }
    return new Response(text, { status: res.status, headers: res.headers });
  }) as FetchFn;
}

/**
 * A valid access token for ctx, refreshing through the v2 token endpoint (with the scopes of
 * the consent kind, as Microsoft wants) when it expires within a minute. Saves rotated tokens
 * through ctx.saveTokens. 400/401 at the token endpoint means the grant is gone. A refreshed
 * read token that carries a write scope is refused with ReconnectRequiredError.
 */
export async function msAccessToken(
  cfg: MicrosoftConfig,
  ctx: ConnectorContext,
  access: AccessKind,
): Promise<string> {
  const now = cfg.now?.() ?? Date.now();
  const t = ctx.tokens;
  if (!t.expiresAt || t.expiresAt - now > 60_000) return t.accessToken;
  if (!t.refreshToken) throw new ReconnectRequiredError(PROVIDER, 'no refresh token');
  const { clientId, clientSecret } = clientFor(cfg, access);
  const http = createHttp({ provider: PROVIDER, baseUrl: tokenUrl(cfg), fetch: cfg.fetch });
  const res = await http.request<TokenResponse | null>(tokenUrl(cfg), {
    method: 'POST',
    form: {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: scopesFor(cfg, access).join(' '),
    },
    allow: [400],
  });
  if (!res || typeof res.access_token !== 'string') {
    throw new ReconnectRequiredError(PROVIDER, 'token endpoint refused the grant');
  }
  const fresh = toTokens(res, now);
  // A read token must never carry write scopes (e.g. Mail.Send consented to the read app,
  // which Microsoft then adds to every token of that app). Refuse it before it is saved.
  if (access === 'read' && writeScopesIn(normalizeScopes(fresh.scope)).length) {
    throw new ReconnectRequiredError(PROVIDER, 'refreshed read token carries write scopes');
  }
  const next: OAuthTokens = {
    ...fresh,
    refreshToken: fresh.refreshToken ?? t.refreshToken,
    ...((fresh.scope ?? t.scope) ? { scope: fresh.scope ?? t.scope } : {}),
  };
  ctx.tokens = next;
  await ctx.saveTokens(next);
  return next.accessToken;
}

export type GraphRequest = {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Graph `Prefer` preferences, joined into one header. */
  prefer?: string[];
  /** Statuses returned as null instead of thrown (410 = delta token expired). */
  allow?: number[];
};

export type Graph = {
  request<T>(pathOrLink: string, r?: GraphRequest): Promise<T>;
};

/**
 * Graph client for one account and consent kind. Links from Graph (`@odata.nextLink`,
 * `@odata.deltaLink`) are followed only when they point at the configured Graph origin:
 * cursors are stored data and must never steer a bearer token to another host.
 */
export function graphFor(cfg: MicrosoftConfig, ctx: ConnectorContext, access: AccessKind): Graph {
  const http = createHttp({
    provider: PROVIDER,
    baseUrl: cfg.graphBaseUrl,
    fetch: graphFetch(cfg.fetch ?? fetch),
  });
  const origin = new URL(cfg.graphBaseUrl).origin;
  return {
    async request<T>(pathOrLink: string, r: GraphRequest = {}) {
      if (/^https?:/i.test(pathOrLink) && new URL(pathOrLink).origin !== origin) {
        throw new ConnectorError(PROVIDER, 'refusing to follow a link outside Graph');
      }
      const token = await msAccessToken(cfg, ctx, access);
      const headers: Record<string, string> = {};
      if (r.prefer?.length) headers.prefer = r.prefer.join(', ');
      return http.request<T>(pathOrLink, {
        ...(r.method ? { method: r.method } : {}),
        ...(r.query ? { query: r.query } : {}),
        ...(r.body !== undefined ? { body: r.body } : {}),
        ...(r.allow ? { allow: r.allow } : {}),
        headers,
        token,
      });
    },
  };
}

/** Preferences for Outlook calls: stable ids (survive folder moves) and a page size. */
export const outlookPrefer = (pageSize?: number) => [
  'IdType="ImmutableId"',
  ...(pageSize ? [`odata.maxpagesize=${pageSize}`] : []),
];
