import type { OAuth2ClientOptions } from 'google-auth-library';

/** OAuth scopes. The provider id stays `gmail`, meaning "Google account". */
export const GMAIL_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  send: 'https://www.googleapis.com/auth/gmail.send',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events.readonly',
  driveMetadata: 'https://www.googleapis.com/auth/drive.metadata.readonly',
  chatMessages: 'https://www.googleapis.com/auth/chat.messages.readonly',
  chatSpaces: 'https://www.googleapis.com/auth/chat.spaces.readonly',
  openid: 'openid',
  email: 'email',
  /** Google reports the `email` scope back under this name. */
  userinfoEmail: 'https://www.googleapis.com/auth/userinfo.email',
} as const;
export const GOOGLE_SCOPES = GMAIL_SCOPES;

export type GmailConfig = {
  /** Fixture-backed clients instead of Google (GMAIL_FAKE=1 or CONNECTORS_FAKE=1). Refused in production. */
  fake: boolean;
  clientId?: string;
  clientSecret?: string;
  /** projects/<project>/topics/<topic> that users.watch publishes to. */
  pubsubTopic?: string;
  /** OIDC audience configured on the push subscription. */
  pubsubAudience?: string;
  /** Service account the push subscription signs as. */
  pubsubServiceAccount?: string;
  /** Pub/Sub topic the Workspace Events API (Google Chat) publishes to. */
  eventsTopic?: string;
  /** OIDC audience on the push subscription to /hooks/gmail/events. */
  eventsAudience?: string;
  /** Service account that push subscription signs as (defaults to pubsubServiceAccount). */
  eventsServiceAccount?: string;
  /** Public gateway base URL; Calendar/Drive channels push to <url>/hooks/gmail/channel. */
  gatewayUrl?: string;
  /** Overrides for tests (point the real clients at a local fixture server). */
  rootUrl?: string;
  oauthEndpoints?: OAuth2ClientOptions['endpoints'];
  historyPageSize?: number;
  backfillPageSize?: number;
};

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/**
 * Reads Google settings from process.env (the services load the repo-root .env through
 * @hub/server `env()` at startup). Read lazily so tests and processes see the final env.
 */
export function gmailConfigFromEnv(e: NodeJS.ProcessEnv = process.env): GmailConfig {
  const fake = truthy(e.GMAIL_FAKE) || truthy(e.CONNECTORS_FAKE);
  if (fake && e.NODE_ENV === 'production') {
    throw new Error('GMAIL_FAKE / CONNECTORS_FAKE are not allowed when NODE_ENV=production');
  }
  const opt = (v: string | undefined) => (v ? v : undefined);
  return {
    fake,
    clientId: opt(e.GOOGLE_CLIENT_ID),
    clientSecret: opt(e.GOOGLE_CLIENT_SECRET),
    pubsubTopic: opt(e.GMAIL_PUBSUB_TOPIC),
    pubsubAudience: opt(e.GMAIL_PUBSUB_AUDIENCE),
    pubsubServiceAccount: opt(e.GMAIL_PUBSUB_SERVICE_ACCOUNT),
    eventsTopic: opt(e.GOOGLE_EVENTS_PUBSUB_TOPIC),
    eventsAudience: opt(e.GOOGLE_EVENTS_PUBSUB_AUDIENCE),
    eventsServiceAccount: opt(e.GOOGLE_EVENTS_PUBSUB_SERVICE_ACCOUNT),
    gatewayUrl: opt(e.PUBLIC_GATEWAY_URL),
  };
}
