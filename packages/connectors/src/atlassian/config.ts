import { fakeMode } from '../lib/fake';

/** Atlassian Cloud endpoints. All product calls go through the API gateway with the site's cloud id. */
export const ATLASSIAN_URLS = {
  authorize: 'https://auth.atlassian.com/authorize',
  token: 'https://auth.atlassian.com/oauth/token',
  api: 'https://api.atlassian.com',
  audience: 'api.atlassian.com',
} as const;

/**
 * Classic scopes. Atlassian recommends classic scopes for the REST v2/v3 (Jira) and v1
 * (Confluence) endpoints we use; granular Confluence scopes would need a longer list for
 * the same calls (`read:page:confluence`, `read:content-details:confluence`, ...).
 */
export const ATLASSIAN_SCOPES = {
  jiraRead: 'read:jira-work',
  jiraUser: 'read:jira-user',
  /**
   * Needed to register, refresh and delete the app's *own* dynamic webhooks. It cannot
   * change issues, projects or any user data, so it is part of the read consent.
   */
  jiraWebhooks: 'manage:jira-webhook',
  confluenceRead: 'read:confluence-content.all',
  /** CQL search (`/wiki/rest/api/search`). */
  confluenceSearch: 'search:confluence',
  me: 'read:me',
  offline: 'offline_access',
  jiraWrite: 'write:jira-work',
} as const;

export const JIRA_SOURCE_SCOPES = [ATLASSIAN_SCOPES.jiraRead, ATLASSIAN_SCOPES.jiraUser];
export const CONFLUENCE_SOURCE_SCOPES = [
  ATLASSIAN_SCOPES.confluenceRead,
  ATLASSIAN_SCOPES.confluenceSearch,
];

export const READ_SCOPES = [
  ...JIRA_SOURCE_SCOPES,
  ATLASSIAN_SCOPES.jiraWebhooks,
  ...CONFLUENCE_SOURCE_SCOPES,
  ATLASSIAN_SCOPES.me,
  ATLASSIAN_SCOPES.offline,
];

/**
 * Separate consent used only by the executor. Besides `write:jira-work`:
 * - `offline_access` lets the executor refresh its token (access tokens last an hour);
 * - `read:me` identifies the consenting Atlassian user, so the API can check the write
 *   consent came from the same person as the read one.
 * Neither grants access to Jira or Confluence data.
 */
export const WRITE_SCOPES = [
  ATLASSIAN_SCOPES.jiraWrite,
  ATLASSIAN_SCOPES.me,
  ATLASSIAN_SCOPES.offline,
];

/** `manage:jira-webhook` is the one `manage:` scope a read grant may carry (see above). */
export function isWriteScope(scope: string): boolean {
  if (scope === ATLASSIAN_SCOPES.jiraWebhooks) return false;
  return /^(write|delete|manage|admin):/.test(scope) || /:(write|delete|admin)$/.test(scope);
}

export type AtlassianConfig = {
  /** Fixture-backed fake Atlassian (CONNECTORS_FAKE=1 or ATLASSIAN_FAKE=1). Never production. */
  fake: boolean;
  clientId?: string;
  clientSecret?: string;
  /** Base of the webhook URL registered with Jira: `<gateway>/hooks/atlassian`. */
  gatewayUrl: string;
};

/** Client secret the fake Atlassian signs webhook JWTs with when none is configured. */
export const FAKE_CLIENT_SECRET = 'fake-atlassian-client-secret';

export function atlassianConfigFromEnv(e: NodeJS.ProcessEnv = process.env): AtlassianConfig {
  const opt = (v: string | undefined) => (v ? v : undefined);
  return {
    fake: fakeMode('ATLASSIAN_FAKE'),
    clientId: opt(e.ATLASSIAN_CLIENT_ID),
    clientSecret: opt(e.ATLASSIAN_CLIENT_SECRET),
    gatewayUrl: (e.PUBLIC_GATEWAY_URL || 'http://localhost:4001').replace(/\/$/, ''),
  };
}

/** Secret that signs (and verifies) webhook JWTs: the app's client secret. */
export function webhookSigningSecret(c: AtlassianConfig): string | undefined {
  return c.clientSecret ?? (c.fake ? FAKE_CLIENT_SECRET : undefined);
}
