import { ConnectorError, ReconnectRequiredError } from '../errors';
import { createHttp, type FetchFn, type RequestOptions } from '../lib/http';
import { accessToken, refreshTokens, type OAuth2Config } from '../lib/oauth2';
import type { ConnectorContext } from '../types';
import { ATLASSIAN_URLS, type AtlassianConfig } from './config';

export const PROVIDER = 'atlassian';

export function oauthConfig(c: AtlassianConfig, fetch?: FetchFn): OAuth2Config {
  return {
    provider: PROVIDER,
    authorizeUrl: ATLASSIAN_URLS.authorize,
    tokenUrl: ATLASSIAN_URLS.token,
    clientId: c.clientId ?? (c.fake ? 'fake-atlassian-client' : ''),
    clientSecret: c.clientSecret ?? (c.fake ? 'fake-atlassian-client-secret' : ''),
    // Atlassian's token endpoint takes a JSON body with the client credentials in it.
    jsonBody: true,
    ...(fetch ? { fetch } : {}),
  };
}

/** The site's cloud id: accounts.external_id, also kept in accounts.meta.cloudId. */
export function cloudIdOf(ctx: Pick<ConnectorContext, 'externalId' | 'meta'>): string {
  const id = typeof ctx.meta?.cloudId === 'string' ? ctx.meta.cloudId : ctx.externalId;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new ConnectorError(PROVIDER, 'bad cloud id');
  return id;
}

export type AtlassianClient = ReturnType<typeof atlassianClient>;

/**
 * API client for one account. Refreshes the token before it expires and once more on a
 * 401 (Atlassian rotates the refresh token on every refresh; `refreshTokens` keeps the new
 * one and ctx.saveTokens persists it). A second 401 means the grant is gone.
 */
export function atlassianClient(c: AtlassianConfig, ctx: ConnectorContext, fetch?: FetchFn) {
  const cfg = oauthConfig(c, fetch);
  const http = createHttp({ provider: PROVIDER, baseUrl: ATLASSIAN_URLS.api, fetch });

  async function call<T>(path: string, r: RequestOptions = {}): Promise<T> {
    const token = await accessToken(cfg, ctx);
    try {
      return await http.request<T>(path, { ...r, token });
    } catch (e) {
      if (!(e instanceof ReconnectRequiredError) || e.status !== 401 || !ctx.tokens.refreshToken)
        throw e;
      const next = await refreshTokens(cfg, ctx.tokens);
      ctx.tokens = next;
      await ctx.saveTokens(next);
      return http.request<T>(path, { ...r, token: next.accessToken });
    }
  }

  const jiraBase = () => `/ex/jira/${cloudIdOf(ctx)}/rest/api/3`;
  const wikiBase = () => `/ex/confluence/${cloudIdOf(ctx)}/wiki/rest/api`;

  return {
    call,
    jira: <T>(path: string, r?: RequestOptions) => call<T>(`${jiraBase()}${path}`, r),
    wiki: <T>(path: string, r?: RequestOptions) => call<T>(`${wikiBase()}${path}`, r),
  };
}

export const issuePath = (key: string) => `/issue/${encodeURIComponent(key)}`;
