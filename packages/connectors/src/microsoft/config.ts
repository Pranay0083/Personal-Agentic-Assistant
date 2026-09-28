import { fakeMode, type FetchFn } from '../lib/index';

/** Tenant id Microsoft uses for every personal (MSA: outlook.com, hotmail.com, live.com) account. */
export const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
export const LOGIN_BASE_URL = 'https://login.microsoftonline.com';

/**
 * Delegated read-only scopes. `openid` only makes the token endpoint return an id_token,
 * whose `tid` claim tells a work tenant from a personal account; it grants no data access.
 */
export const MS_READ_SCOPES = [
  'openid',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.Read',
  'Chat.Read',
  'Files.Read',
] as const;

/**
 * Optional Teams channel messages. ChannelMessage.Read.All needs tenant admin consent, so it
 * is requested only when MS_CHANNEL_MESSAGES=1 and the `channels` source is off by default.
 * Team.ReadBasic.All and Channel.ReadBasic.All list the joined teams and their channels.
 */
export const MS_CHANNEL_SCOPES = [
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Read.All',
] as const;

/** The write consent (executor only). Mail.Send cannot read the mailbox. */
export const MS_WRITE_SCOPES = ['openid', 'offline_access', 'User.Read', 'Mail.Send'] as const;

/** Identity-only scopes that may come back in a grant; never data access. */
export const IDENTITY_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

/**
 * Any Graph permission that can change data. A read grant carrying one of these is refused.
 * Matching is case-insensitive on the short scope name.
 */
export function isWriteScope(scope: string): boolean {
  return /(ReadWrite|\.Send|\.Write|Manage|FullControl|\.Create|\.Delete|\.Migrate|\.Import)/i.test(
    scope,
  );
}

export type MicrosoftConfig = {
  /** Fixture-backed fake Graph (CONNECTORS_FAKE=1 or MS_FAKE=1). Refused in production. */
  fake: boolean;
  clientId?: string;
  clientSecret?: string;
  /** `common`, `organizations`, `consumers` or a tenant id. */
  tenant: string;
  /**
   * Optional separate Entra app for the Mail.Send consent. Microsoft puts every scope a user
   * consented to for an app into that app's tokens, so with one app a later write consent
   * would leak Mail.Send into read tokens (the read exchange then refuses the grant).
   * Falls back to the read app.
   */
  writeClientId?: string;
  writeClientSecret?: string;
  /** Public gateway base; notifications go to `<gatewayUrl>/hooks/microsoft`. */
  gatewayUrl: string;
  /** Request ChannelMessage.Read.All (admin consent) for the optional `channels` source. */
  channelMessages: boolean;
  graphBaseUrl: string;
  loginBaseUrl: string;
  /** Page size for delta and list calls. */
  pageSize: number;
  /** Max provider pages per fetchDelta call and source before returning `hasMore`. */
  maxPages: number;
  /** Calendar delta window, days ahead of now. */
  calendarDaysAhead: number;
  /** Injected in tests (mockFetch) and fake mode (fake Graph). */
  fetch?: FetchFn;
  now?: () => number;
};

const truthy = (v: string | undefined) => v === '1' || v === 'true';
const opt = (v: string | undefined) => (v ? v : undefined);

/** Reads settings from process.env on each call, so tests and processes see the final env. */
export function msConfigFromEnv(e: NodeJS.ProcessEnv = process.env): MicrosoftConfig {
  const fake = fakeMode('MS_FAKE');
  return {
    fake,
    clientId: opt(e.MS_CLIENT_ID),
    clientSecret: opt(e.MS_CLIENT_SECRET),
    tenant: opt(e.MS_TENANT) ?? 'common',
    writeClientId: opt(e.MS_WRITE_CLIENT_ID),
    writeClientSecret: opt(e.MS_WRITE_CLIENT_SECRET),
    gatewayUrl: opt(e.PUBLIC_GATEWAY_URL) ?? 'http://localhost:4001',
    channelMessages: truthy(e.MS_CHANNEL_MESSAGES),
    graphBaseUrl: GRAPH_BASE_URL,
    loginBaseUrl: LOGIN_BASE_URL,
    pageSize: 50,
    maxPages: 10,
    calendarDaysAhead: 30,
  };
}

export function notificationUrl(cfg: Pick<MicrosoftConfig, 'gatewayUrl'>): string {
  return `${cfg.gatewayUrl.replace(/\/$/, '')}/hooks/microsoft`;
}

export function tokenUrl(cfg: Pick<MicrosoftConfig, 'loginBaseUrl' | 'tenant'>): string {
  return `${cfg.loginBaseUrl}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`;
}

export function authorizeEndpoint(cfg: Pick<MicrosoftConfig, 'loginBaseUrl' | 'tenant'>): string {
  return `${cfg.loginBaseUrl}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize`;
}

/** Client credentials for a consent kind: the write app when configured, else the read app. */
export function clientFor(cfg: MicrosoftConfig, access: 'read' | 'write') {
  if (access === 'write' && cfg.writeClientId && cfg.writeClientSecret) {
    return { clientId: cfg.writeClientId, clientSecret: cfg.writeClientSecret };
  }
  return { clientId: cfg.clientId ?? '', clientSecret: cfg.clientSecret ?? '' };
}

export function scopesFor(cfg: Pick<MicrosoftConfig, 'channelMessages'>, access: 'read' | 'write') {
  if (access === 'write') return [...MS_WRITE_SCOPES];
  return cfg.channelMessages ? [...MS_READ_SCOPES, ...MS_CHANNEL_SCOPES] : [...MS_READ_SCOPES];
}

/** `https://graph.microsoft.com/Mail.Read` → `Mail.Read`. */
export function normalizeScopes(scope: string | undefined): string[] {
  return [
    ...new Set(
      (scope ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '')),
    ),
  ];
}
