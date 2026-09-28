import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { ConnectorError, ReconnectRequiredError, RetryableError, parseRetryAfter } from '../errors';
import type { OAuthTokens } from '../types';
import type { GmailConfig } from './config';

export type GmailMessage = gmail_v1.Schema$Message;
export type GmailHistoryList = gmail_v1.Schema$ListHistoryResponse;
export type GmailMessageList = gmail_v1.Schema$ListMessagesResponse;

/**
 * The slice of the Gmail API the connector uses. The real client (googleapis) and the
 * fixture-backed fake implement the same interface, so every connector code path runs
 * the same way in tests, fake mode and production.
 */
export interface GmailApi {
  getProfile(): Promise<gmail_v1.Schema$Profile>;
  watch(req: gmail_v1.Schema$WatchRequest): Promise<gmail_v1.Schema$WatchResponse>;
  stop(): Promise<void>;
  listHistory(p: {
    startHistoryId: string;
    pageToken?: string;
    historyTypes?: string[];
    maxResults?: number;
  }): Promise<GmailHistoryList>;
  getMessage(id: string): Promise<GmailMessage>;
  listMessages(p: {
    q?: string;
    pageToken?: string;
    maxResults?: number;
    includeSpamTrash?: boolean;
  }): Promise<GmailMessageList>;
  sendMessage(p: { raw: string; threadId?: string }): Promise<GmailMessage>;
}

export type GmailClientFactory = (opts: {
  tokens: OAuthTokens;
  externalId: string;
  /** Called when the client refreshed the access token. */
  onTokens: (tokens: OAuthTokens) => void;
}) => GmailApi;

export function toCredentials(t: OAuthTokens): Credentials {
  return {
    access_token: t.accessToken,
    refresh_token: t.refreshToken ?? null,
    expiry_date: t.expiresAt ?? null,
    scope: t.scope,
    token_type: 'Bearer',
  };
}

export function fromCredentials(c: Credentials, prev?: OAuthTokens): OAuthTokens {
  const out: OAuthTokens = { accessToken: c.access_token ?? prev?.accessToken ?? '' };
  const refresh = c.refresh_token ?? prev?.refreshToken;
  if (refresh) out.refreshToken = refresh;
  const exp = c.expiry_date ?? prev?.expiresAt;
  if (exp) out.expiresAt = exp;
  const scope = c.scope ?? prev?.scope;
  if (scope) out.scope = scope;
  return out;
}

export function oauthClient(config: GmailConfig, redirectUri?: string) {
  if (!config.clientId || !config.clientSecret) {
    throw new ConnectorError('gmail', 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set');
  }
  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(redirectUri ? { redirectUri } : {}),
    ...(config.oauthEndpoints ? { endpoints: config.oauthEndpoints } : {}),
  });
}

/**
 * Per-request timeout for Gmail API calls. Without one a hung connection blocks a worker
 * (and, for sends, the executor's advisory lock) indefinitely. A timed-out send is an
 * *ambiguous* failure: the executor reconciles with findExecuted instead of re-sending.
 */
export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;

/** Real Gmail client on @googleapis/gmail with an OAuth2Client that auto-refreshes. */
export function realClientFactory(
  config: GmailConfig,
  opts: { timeoutMs?: number } = {},
): GmailClientFactory {
  const timeout = opts.timeoutMs ?? GMAIL_REQUEST_TIMEOUT_MS;
  return ({ tokens, onTokens }) => {
    const auth = oauthClient(config);
    auth.setCredentials(toCredentials(tokens));
    auth.on('tokens', (c) => onTokens(fromCredentials(c, tokens)));
    const api = gmailApi({
      version: 'v1',
      auth,
      retry: false,
      timeout,
      ...(config.rootUrl ? { rootUrl: config.rootUrl } : {}),
    });
    const u = api.users;
    return {
      async getProfile() {
        return (await u.getProfile({ userId: 'me' })).data;
      },
      async watch(requestBody) {
        return (await u.watch({ userId: 'me', requestBody })).data;
      },
      async stop() {
        await u.stop({ userId: 'me' });
      },
      async listHistory(p) {
        return (await u.history.list({ userId: 'me', ...p })).data;
      },
      async getMessage(id) {
        return (await u.messages.get({ userId: 'me', id, format: 'full' })).data;
      },
      async listMessages(p) {
        return (await u.messages.list({ userId: 'me', ...p })).data;
      },
      async sendMessage({ raw, threadId }) {
        return (
          await u.messages.send({
            userId: 'me',
            requestBody: { raw, ...(threadId ? { threadId } : {}) },
          })
        ).data;
      },
    };
  };
}

/** Normalized view of a gaxios (or fake) error. Never includes request headers or bodies. */
type ErrorShape = {
  status?: number;
  oauthError?: string;
  reasons?: string[];
  retryAfter?: string | null;
};

function shapeOf(e: unknown): ErrorShape {
  if (!e || typeof e !== 'object') return {};
  const err = e as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: unknown; headers?: unknown };
  };
  const status =
    typeof err.response?.status === 'number'
      ? err.response.status
      : typeof err.status === 'number'
        ? err.status
        : typeof err.code === 'number'
          ? err.code
          : undefined;
  const data = err.response?.data as { error?: unknown } | undefined;
  const oauthError = typeof data?.error === 'string' ? data.error : undefined;
  const apiErrors = (data?.error as { errors?: { reason?: unknown }[] } | undefined)?.errors;
  const reasons = Array.isArray(apiErrors)
    ? apiErrors.map((x) => x.reason).filter((r): r is string => typeof r === 'string')
    : [];
  let retryAfter: string | null = null;
  const h = err.response?.headers as
    { get?: (k: string) => string | null; [k: string]: unknown } | undefined;
  if (h) {
    if (typeof h.get === 'function') retryAfter = h.get('retry-after');
    else if (typeof h['retry-after'] === 'string') retryAfter = h['retry-after'];
  }
  return { status, oauthError, reasons, retryAfter };
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  // gaxios reports AbortSignal.timeout() as code `TimeoutError` (the DOMException name).
  'TimeoutError',
  'AbortError',
]);

export function httpStatusOf(e: unknown): number | undefined {
  return shapeOf(e).status;
}

/** Maps provider errors to typed connector errors. Messages carry no token or content. */
export function mapGmailError(e: unknown): unknown {
  if (e instanceof ConnectorError) return e;
  const { status, oauthError, reasons = [], retryAfter } = shapeOf(e);
  const rateLimited =
    status === 403 &&
    reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded');
  if (oauthError === 'invalid_grant' || oauthError === 'unauthorized_client' || status === 401) {
    return new ReconnectRequiredError('gmail', 'gmail token revoked or expired', {
      status: status ?? 401,
    });
  }
  if (status === 429 || rateLimited || (status !== undefined && status >= 500)) {
    const retryAfterMs = parseRetryAfter(retryAfter);
    return new RetryableError('gmail', `gmail responded ${status}`, {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  // gaxios puts the system code on `code`, or leaves it on `cause` (a timeout surfaces as a
  // GaxiosError whose cause is an AbortError/TimeoutError).
  const err = e as {
    code?: unknown;
    name?: unknown;
    cause?: { code?: unknown; name?: unknown };
  } | null;
  const code = [err?.code, err?.cause?.code, err?.name, err?.cause?.name].find(
    (c): c is string => typeof c === 'string' && NETWORK_CODES.has(c),
  );
  if (code) {
    // No HTTP status: the request may or may not have reached Gmail.
    return new RetryableError('gmail', `network error ${code}`);
  }
  if (status !== undefined) {
    return new ConnectorError('gmail', `gmail responded ${status}`, { status });
  }
  return e;
}
