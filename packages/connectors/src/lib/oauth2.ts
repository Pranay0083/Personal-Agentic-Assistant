import { ConnectorError, ReconnectRequiredError } from '../errors';
import type { ConnectorContext, OAuthTokens } from '../types';
import { createHttp, type FetchFn } from './http';

/**
 * Standard OAuth 2.0 authorization-code flow and refresh for REST connectors
 * (Microsoft, Atlassian, Slack v2, Notion, GitHub App user tokens).
 */
export type OAuth2Config = {
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** How the client authenticates at the token endpoint. */
  clientAuth?: 'body' | 'basic';
  /** Token endpoint wants JSON instead of a form body (Atlassian, Notion). */
  jsonBody?: boolean;
  fetch?: FetchFn;
};

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [k: string]: unknown;
};

export function authorizeUrl(
  cfg: Pick<OAuth2Config, 'authorizeUrl' | 'clientId'>,
  p: {
    state: string;
    redirectUri: string;
    scopes?: string[];
    scopeParam?: string;
    scopeSep?: string;
    extra?: Record<string, string>;
  },
): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', p.state);
  if (p.scopes?.length)
    u.searchParams.set(p.scopeParam ?? 'scope', p.scopes.join(p.scopeSep ?? ' '));
  for (const [k, v] of Object.entries(p.extra ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenRequest(
  cfg: OAuth2Config,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const http = createHttp({ provider: cfg.provider, baseUrl: cfg.tokenUrl, fetch: cfg.fetch });
  const headers: Record<string, string> = {};
  const all: Record<string, string> = { ...params };
  if (cfg.clientAuth === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  } else {
    all.client_id = cfg.clientId;
    all.client_secret = cfg.clientSecret;
  }
  let res: TokenResponse | null;
  try {
    res = cfg.jsonBody
      ? await http.request<TokenResponse>(cfg.tokenUrl, {
          method: 'POST',
          body: all,
          headers,
          allow: [400],
        })
      : await http.request<TokenResponse>(cfg.tokenUrl, {
          method: 'POST',
          form: all,
          headers,
          allow: [400],
        });
  } catch (err) {
    if (err instanceof ConnectorError && err.status === 401) {
      throw new ReconnectRequiredError(cfg.provider, 'token endpoint refused the grant');
    }
    throw err;
  }
  // 400 at the token endpoint = invalid_grant / expired refresh token.
  if (!res || typeof res.access_token !== 'string') {
    throw new ReconnectRequiredError(cfg.provider, 'token endpoint refused the grant');
  }
  return res;
}

export function toTokens(r: TokenResponse, now = Date.now()): OAuthTokens {
  return {
    accessToken: r.access_token,
    ...(r.refresh_token ? { refreshToken: r.refresh_token } : {}),
    ...(r.expires_in ? { expiresAt: now + r.expires_in * 1000 } : {}),
    ...(r.scope ? { scope: r.scope } : {}),
  };
}

export async function exchangeCode(
  cfg: OAuth2Config,
  p: { code: string; redirectUri: string; extra?: Record<string, string> },
): Promise<TokenResponse> {
  return tokenRequest(cfg, {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    ...p.extra,
  });
}

export async function refreshTokens(cfg: OAuth2Config, tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw new ReconnectRequiredError(cfg.provider, 'no refresh token');
  const r = await tokenRequest(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  const next = toTokens(r);
  // Some providers rotate refresh tokens (Atlassian, GitHub); others keep the old one.
  return {
    ...next,
    refreshToken: next.refreshToken ?? tokens.refreshToken,
    scope: next.scope ?? tokens.scope,
  };
}

/**
 * Returns a valid access token for `ctx`, refreshing (and saving via ctx.saveTokens) when it
 * expires within a minute. Tokens without an expiry (Notion, Slack without rotation) pass through.
 */
export async function accessToken(
  cfg: OAuth2Config,
  ctx: ConnectorContext,
  now = Date.now(),
): Promise<string> {
  const t = ctx.tokens;
  if (!t.expiresAt || t.expiresAt - now > 60_000) return t.accessToken;
  const next = await refreshTokens(cfg, t);
  await ctx.saveTokens(next);
  ctx.tokens = next;
  return next.accessToken;
}
