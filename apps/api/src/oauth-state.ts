import { randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { hashToken, type redis } from '@hub/server';
import { open, seal, type Envelope, type KeyProvider } from '@hub/server/secrets';
import { Provider } from '@hub/shared';
import { z } from 'zod';
import type { ApiConfig, OAuthStore } from './deps';
import { badRequest } from './http';

const AUDIENCE = 'hub:oauth-state';
export const STATE_TTL_SECONDS = 10 * 60;

export const OAuthState = z.object({
  userId: z.uuid(),
  provider: Provider,
  access: z.enum(['read', 'write']),
  nonce: z.string(),
  /** Set for the write-access flow: the account the write consent is for. */
  accountId: z.uuid().optional(),
  /** App deep link to return to, already checked against the allow-list. */
  redirect: z.string().optional(),
});
export type OAuthState = z.infer<typeof OAuthState>;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signState(
  config: ApiConfig,
  state: Omit<OAuthState, 'nonce'>,
  now: Date,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ ...state, nonce: randomBytes(16).toString('base64url') })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + STATE_TTL_SECONDS)
    .sign(key(config.sessionSecret));
}

/** Returns the verified state, or null if the signature, audience or expiry is wrong. */
export async function verifyState(
  config: ApiConfig,
  token: string,
  now: Date,
): Promise<OAuthState | null> {
  try {
    const { payload } = await jwtVerify(token, key(config.sessionSecret), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      currentDate: now,
    });
    const r = OAuthState.safeParse(payload);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** OAuth callback path segment per provider: Gmail uses the Google OAuth client. */
export const CALLBACK_NAME: Record<Provider, string> = {
  gmail: 'google',
  microsoft: 'microsoft',
  slack: 'slack',
  atlassian: 'atlassian',
  notion: 'notion',
  github: 'github',
};

export function callbackUrl(config: ApiConfig, provider: Provider): string {
  if (provider === 'gmail' && config.googleOAuthRedirectUri) return config.googleOAuthRedirectUri;
  return `${config.publicApiUrl.replace(/\/$/, '')}/oauth/${CALLBACK_NAME[provider]}/callback`;
}

export const defaultAppRedirect = (config: ApiConfig) => `${config.appScheme}://connected`;

/**
 * Where the callback may send the browser back to: the app's own scheme, and in
 * development also Expo Go (`exp://`) and localhost (Expo web). Never an arbitrary URL.
 */
export function checkAppRedirect(
  config: ApiConfig,
  redirect: string | undefined,
): string | undefined {
  if (!redirect) return undefined;
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    throw badRequest('redirectUri: not a URL');
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme === config.appScheme) return redirect;
  if (!config.production) {
    if (scheme === 'exp' || scheme === 'exps') return redirect;
    if (
      (scheme === 'http' || scheme === 'https') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      return redirect;
    }
  }
  throw badRequest('redirectUri: not an allowed app redirect');
}

export function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// ---- Single-use state and pending connect results ----

/** How long a callback result waits for the app to call POST /accounts/complete. */
export const PENDING_TTL_SECONDS = 10 * 60;

const nonceKey = (nonce: string) => `oauth:nonce:${hashToken(nonce)}`;
// The id is a bearer secret for the sealed code, so only its hash is used as the key.
const pendingKey = (id: string) => `oauth:pending:${hashToken(id)}`;

/** Marks the state's nonce used. False if this state was already presented once. */
export async function claimStateNonce(store: OAuthStore, state: OAuthState): Promise<boolean> {
  return store.setNx(nonceKey(state.nonce), '1', STATE_TTL_SECONDS);
}

export const PendingConnect = z.object({ code: z.string(), state: OAuthState });
export type PendingConnect = z.infer<typeof PendingConnect>;

/** Seals the code and state claims under a fresh random single-use id and returns the id. */
export async function putPending(
  store: OAuthStore,
  keys: KeyProvider,
  pending: PendingConnect,
): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const envelope = await seal(keys, JSON.stringify(pending));
  if (!(await store.setNx(pendingKey(id), JSON.stringify(envelope), PENDING_TTL_SECONDS))) {
    throw new Error('pending id collision');
  }
  return id;
}

/** Loads and deletes a pending connect in one step. Null if unknown, expired or already used. */
export async function takePending(
  store: OAuthStore,
  keys: KeyProvider,
  id: string,
): Promise<PendingConnect | null> {
  const raw = await store.take(pendingKey(id));
  if (!raw) return null;
  try {
    const plain = await open(keys, JSON.parse(raw) as Envelope);
    const r = PendingConnect.safeParse(JSON.parse(plain.toString('utf8')));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** OAuthStore on Redis: SET NX EX and GETDEL are both single atomic commands. */
export function redisOAuthStore(r: ReturnType<typeof redis>): OAuthStore {
  return {
    setNx: async (key, value, ttlSeconds) =>
      (await r.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK',
    take: (key) => r.getdel(key),
  };
}
