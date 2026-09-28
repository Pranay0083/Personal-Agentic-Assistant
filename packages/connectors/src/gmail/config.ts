import type { OAuth2ClientOptions } from 'google-auth-library';

export const GMAIL_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  send: 'https://www.googleapis.com/auth/gmail.send',
  openid: 'openid',
  email: 'email',
  /** Google reports the `email` scope back under this name. */
  userinfoEmail: 'https://www.googleapis.com/auth/userinfo.email',
} as const;

export type GmailConfig = {
  /** Fixture-backed client instead of Google (GMAIL_FAKE=1). Refused in production. */
  fake: boolean;
  clientId?: string;
  clientSecret?: string;
  /** projects/<project>/topics/<topic> that users.watch publishes to. */
  pubsubTopic?: string;
  /** OIDC audience configured on the push subscription. */
  pubsubAudience?: string;
  /** Service account the push subscription signs as. */
  pubsubServiceAccount?: string;
  /** Overrides for tests (point the real client at a local fixture server). */
  rootUrl?: string;
  oauthEndpoints?: OAuth2ClientOptions['endpoints'];
  historyPageSize?: number;
  backfillPageSize?: number;
};

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/**
 * Reads Gmail settings from process.env (the services load the repo-root .env through
 * @hub/server `env()` at startup). Read lazily so tests and processes see the final env.
 */
export function gmailConfigFromEnv(e: NodeJS.ProcessEnv = process.env): GmailConfig {
  const fake = truthy(e.GMAIL_FAKE);
  if (fake && e.NODE_ENV === 'production') {
    throw new Error('GMAIL_FAKE=1 is not allowed when NODE_ENV=production');
  }
  const opt = (v: string | undefined) => (v ? v : undefined);
  return {
    fake,
    clientId: opt(e.GOOGLE_CLIENT_ID),
    clientSecret: opt(e.GOOGLE_CLIENT_SECRET),
    pubsubTopic: opt(e.GMAIL_PUBSUB_TOPIC),
    pubsubAudience: opt(e.GMAIL_PUBSUB_AUDIENCE),
    pubsubServiceAccount: opt(e.GMAIL_PUBSUB_SERVICE_ACCOUNT),
  };
}
