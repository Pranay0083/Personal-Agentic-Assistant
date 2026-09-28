import type { Connector } from '@hub/connectors';
import type { Db } from '@hub/db';
import type { ModelRouter } from '@hub/models';
import type { Env, Logger } from '@hub/server';
import type { KeyProvider, SecretStore } from '@hub/server/secrets';
import type { Provider } from '@hub/shared';
import type { LiveEvent, QueueName } from '@hub/shared/queues';

export type ApiConfig = {
  production: boolean;
  /** POST /auth/dev is enabled only when this is true and `production` is false. */
  devAuth: boolean;
  /** Signs OAuth state (HS256). */
  sessionSecret: string;
  appScheme: string;
  publicApiUrl: string;
  publicMcpUrl: string;
  /** Redirect URI registered on the Google OAuth client (points at /oauth/google/callback). */
  googleOAuthRedirectUri: string | undefined;
  /** Audiences accepted for "Continue with Google" ID tokens. */
  googleSigninClientIds: string[];
};

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

/** Same shape as `enqueue` from @hub/server. Always pass a deterministic jobId. */
export type Enqueue = (
  name: QueueName,
  data: unknown,
  opts?: { jobId?: string },
) => Promise<unknown>;

/**
 * Short-lived single-use values for the OAuth connect flow (Redis in production).
 * Both operations must be atomic: they are what makes a state or pending id single-use.
 */
export type OAuthStore = {
  /** SET key value NX EX ttl. True if the key was set, false if it already existed. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** GETDEL: returns the value and deletes the key in one step, or null if absent or expired. */
  take(key: string): Promise<string | null>;
};

export type ApiDeps = {
  db: Db;
  secrets: SecretStore;
  /** Opens sealed item bodies (item_bodies rows are envelopes). */
  keys: KeyProvider;
  enqueue: Enqueue;
  publishLive: (userId: string, event: LiveEvent) => Promise<void>;
  subscribeLive: (userId: string, onEvent: (e: LiveEvent) => void) => () => void;
  /** Returns the connector for a provider, or throws / returns undefined if unsupported. */
  getConnector: (provider: Provider) => Connector | undefined;
  /** Single-use OAuth state nonces and pending connect results. */
  oauthStore: OAuthStore;
  router: ModelRouter;
  now: () => Date;
  config: ApiConfig;
  /** Verifies a Google ID token against the given audiences. Defaults to google-auth-library. */
  verifyGoogleIdToken?: (idToken: string, audiences: string[]) => Promise<GoogleIdentity>;
  logger?: Logger | false;
  /** SSE heartbeat interval in ms (default 25s). */
  heartbeatMs?: number;
};

export function configFromEnv(e: Env): ApiConfig {
  return {
    production: e.NODE_ENV === 'production',
    devAuth: e.DEV_AUTH,
    sessionSecret: e.SESSION_SECRET,
    appScheme: e.APP_SCHEME,
    publicApiUrl: e.PUBLIC_API_URL,
    publicMcpUrl: e.PUBLIC_MCP_URL,
    googleOAuthRedirectUri: e.GOOGLE_OAUTH_REDIRECT_URI || undefined,
    googleSigninClientIds: (e.GOOGLE_SIGNIN_CLIENT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
