import { ReconnectRequiredError } from '../errors';
import { createHttp, type FetchFn, type RequestOptions } from '../lib/http';
import type { OAuthTokens } from '../types';

/** Subset of the Slack Web API shapes the connector reads. */
export type SlackMessage = {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  permalink?: string;
  team?: string;
  channel?: SlackSearchChannel;
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
};

/** `channel` object on a search.messages match. */
export type SlackSearchChannel = {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
};

export type SearchResponse = {
  ok: true;
  messages: {
    matches: SlackMessage[];
    paging?: { count: number; total: number; page: number; pages: number };
    pagination?: { page: number; page_count: number };
  };
};

export type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string };
};

export type OAuthV2Response = {
  ok: true;
  app_id?: string;
  team?: { id: string; name?: string } | null;
  enterprise?: { id: string; name?: string } | null;
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  // Refresh responses for rotated user tokens carry these at the top level.
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export type AuthTest = {
  ok: true;
  url?: string;
  team?: string;
  user?: string;
  team_id: string;
  user_id: string;
};

/** Slack `error` codes that mean the grant is gone: mark the account `reconnect`. */
const RECONNECT_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'invalid_refresh_token',
  'missing_scope',
  'no_permission',
  'team_access_not_granted',
  'org_login_required',
  'ekm_access_denied',
]);
/** Transient: back off and retry. */
const RETRY_ERRORS = new Set([
  'ratelimited',
  'rate_limited',
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
]);

/**
 * Slack answers most failures with HTTP 200 and `{ok:false, error}`. Error codes are
 * fixed identifiers (never content), so they are safe to put in error messages.
 */
export function slackCheckBody(_status: number, body: unknown) {
  if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== false) return null;
  const code = String((body as { error?: unknown }).error ?? 'unknown_error').slice(0, 64);
  if (RECONNECT_ERRORS.has(code)) return { reconnect: true, error: code };
  if (RETRY_ERRORS.has(code)) return { retry: true, error: code };
  return { error: code };
}

export function createSlackHttp(apiBase: string, fetch?: FetchFn) {
  const http = createHttp({
    provider: 'slack',
    baseUrl: apiBase,
    ...(fetch ? { fetch } : {}),
    checkBody: slackCheckBody,
  });
  return {
    /** Calls a Web API method: `call('conversations.history', {token, query})`. */
    call<T>(method: string, r: RequestOptions = {}) {
      return http.request<T>(`/${method}`, r);
    },
  };
}

export type SlackHttp = ReturnType<typeof createSlackHttp>;

/** Tokens from an oauth.v2.access response: the user token (`authed_user`) or a refresh result. */
export function tokensFrom(r: OAuthV2Response, now = Date.now()): OAuthTokens {
  const u = r.authed_user;
  const accessToken = u?.access_token ?? r.access_token;
  if (!accessToken) throw new ReconnectRequiredError('slack', 'oauth response has no user token');
  const refreshToken = u?.refresh_token ?? r.refresh_token;
  const expiresIn = u?.expires_in ?? r.expires_in;
  const scope = (u?.scope ?? r.scope ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(' ');
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(scope ? { scope } : {}),
  };
}

export const tsToMicros = (ts: string): number => {
  const [s = '0', f = ''] = ts.split('.');
  return Number(s) * 1_000_000 + Number(f.padEnd(6, '0').slice(0, 6));
};

export const microsToTs = (us: number): string => {
  const s = Math.floor(us / 1_000_000);
  return `${s}.${String(us - s * 1_000_000).padStart(6, '0')}`;
};

export const tsToDate = (ts: string) => new Date(Math.floor(tsToMicros(ts) / 1000));

/** `T123:U456` → parts. */
export function splitExternalId(externalId: string): { teamId: string; userId: string } {
  const [teamId = '', userId = ''] = externalId.split(':');
  return { teamId, userId };
}
