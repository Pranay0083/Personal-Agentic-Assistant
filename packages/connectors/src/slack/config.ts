import { ConnectorError } from '../errors';
import { fakeMode } from '../lib/fake';

/**
 * User-token scopes (Slack OAuth v2 `user_scope`). Read consent is read-only; the write
 * consent asks for `chat:write` and nothing else.
 */
export const SLACK_READ_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  // Delta and the executor lookup use search.messages (see delta.ts for why).
  'search:read',
] as const;

export const SLACK_WRITE_SCOPES = ['chat:write'] as const;

/** Any of these in a read grant means the consent could post or change data: refuse it. */
export function isWriteScope(scope: string): boolean {
  return /:write(\.|$)/.test(scope) || scope === 'admin' || scope.startsWith('admin.');
}

/** Literal signing secret the fake:slack script signs with. Accepted only in fake mode. */
export const FAKE_SIGNING_SECRET = 'fake-signing-secret';

export type SlackConfig = {
  /** Fixture-backed fake Slack (CONNECTORS_FAKE=1). Refused in production. */
  fake: boolean;
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  /**
   * Optional second Slack app used only for the write consent. Slack user tokens are
   * cumulative per app (a later chat:write consent upgrades the same token), so a
   * separate app is the only way to keep the read token free of write scopes.
   * Without it the write consent is not offered (see writeConfigured), except in fake mode.
   */
  writeClientId?: string;
  writeClientSecret?: string;
  apiBase: string;
  authorizeUrl: string;
};

const opt = (v: string | undefined) => (v ? v : undefined);

/** Read lazily from process.env (the services load the repo-root .env at startup). */
export function slackConfigFromEnv(e: NodeJS.ProcessEnv = process.env): SlackConfig {
  return {
    fake: fakeMode('SLACK_FAKE'),
    clientId: opt(e.SLACK_CLIENT_ID),
    clientSecret: opt(e.SLACK_CLIENT_SECRET),
    signingSecret: opt(e.SLACK_SIGNING_SECRET),
    writeClientId: opt(e.SLACK_WRITE_CLIENT_ID),
    writeClientSecret: opt(e.SLACK_WRITE_CLIENT_SECRET),
    apiBase: 'https://slack.com/api',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
  };
}

/**
 * Which consent a token came from: a write-app token carries chat:write and no history
 * scope. A token with both is a read token that gained write scopes (one app, two consents).
 */
export function accessOfTokens(scope: string | undefined): 'read' | 'write' {
  const granted = (scope ?? '').split(/[\s,]+/);
  return granted.includes('chat:write') && !granted.includes('channels:history') ? 'write' : 'read';
}

/**
 * True when the write consent can be offered: a separate write app is configured, or fake
 * mode. Slack user tokens accumulate every scope granted to one app, so a write consent on
 * the read app would silently give the read token chat:write.
 */
export function writeConfigured(c: SlackConfig): boolean {
  return c.fake || (!!c.writeClientId && !!c.writeClientSecret);
}

/** Client credentials for a consent kind. Write needs the separate write app (or fake mode). */
export function clientFor(c: SlackConfig, access: 'read' | 'write') {
  if (access === 'write') {
    if (c.writeClientId && c.writeClientSecret) {
      return { clientId: c.writeClientId, clientSecret: c.writeClientSecret };
    }
    if (!c.fake) {
      throw new ConnectorError(
        'slack',
        'write consent needs a separate Slack app (SLACK_WRITE_CLIENT_ID/SECRET)',
      );
    }
  }
  return { clientId: c.clientId ?? '', clientSecret: c.clientSecret ?? '' };
}
