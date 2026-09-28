import type { OAuthTokens } from '../types';
import { GMAIL_REQUEST_TIMEOUT_MS, fromCredentials, oauthClient, toCredentials } from './client';
import type { GmailConfig } from './config';

/**
 * Calendar, Drive, Chat and Workspace Events are called as plain REST through
 * google-auth-library's OAuth2Client.request (auto-refresh, gaxios errors), so no extra
 * Google SDKs are needed. Tests and fake mode swap in a transport with the same shape.
 */
export const GOOGLE_API = {
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive: 'https://www.googleapis.com/drive/v3',
  chat: 'https://chat.googleapis.com/v1',
  events: 'https://workspaceevents.googleapis.com/v1',
} as const;

export type GoogleRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  params?: Record<string, string | number | boolean | undefined>;
  data?: unknown;
};

/** Performs one request and returns the parsed JSON body. Throws gaxios-shaped errors. */
export type GoogleRest = <T = unknown>(req: GoogleRequest) => Promise<T>;

export type GoogleRestFactory = (opts: {
  tokens: OAuthTokens;
  externalId: string;
  onTokens: (tokens: OAuthTokens) => void;
}) => GoogleRest;

export function cleanParams(p: GoogleRequest['params']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p ?? {})) if (v !== undefined) out[k] = String(v);
  return out;
}

/** Real transport on OAuth2Client. `config.rootUrl` redirects every call (local fixture server). */
export function realRestFactory(
  config: GmailConfig,
  opts: { timeoutMs?: number } = {},
): GoogleRestFactory {
  const timeout = opts.timeoutMs ?? GMAIL_REQUEST_TIMEOUT_MS;
  return ({ tokens, onTokens }) => {
    const auth = oauthClient(config);
    auth.setCredentials(toCredentials(tokens));
    auth.on('tokens', (c) => onTokens(fromCredentials(c, tokens)));
    return async <T>(req: GoogleRequest): Promise<T> => {
      let url = req.url;
      if (config.rootUrl) {
        const u = new URL(req.url);
        url = config.rootUrl.replace(/\/$/, '') + u.pathname;
      }
      const res = await auth.request<T>({
        url,
        method: req.method ?? 'GET',
        params: cleanParams(req.params),
        ...(req.data !== undefined ? { data: req.data } : {}),
        timeout,
        retry: false,
      });
      return res.data;
    };
  };
}
