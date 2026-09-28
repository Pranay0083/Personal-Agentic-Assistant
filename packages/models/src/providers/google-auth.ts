import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { ModelConfigError, ModelProviderError } from '../errors';

/**
 * Minimal OAuth for a Google service account (JWT bearer grant, RFC 7523), used by the
 * Vertex adapter. Only `type: "service_account"` keys are accepted: other credential
 * types (external_account, impersonation) can point the hub at arbitrary token URLs or
 * run executables. The token endpoint is fixed; `token_uri` from the key is ignored.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export type ServiceAccountKey = {
  clientEmail: string;
  privateKey: KeyObject;
  projectId: string | null;
};

/** Parses service-account JSON. Errors never echo the key. */
export function parseServiceAccount(raw: string): ServiceAccountKey {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ModelConfigError('vertex: secret must be a service account JSON key');
  }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (o.type !== 'service_account') {
    throw new ModelConfigError('vertex: only service account keys are supported');
  }
  const clientEmail = typeof o.client_email === 'string' ? o.client_email : '';
  if (!/^[^@\s]+@[^@\s]+$/.test(clientEmail)) {
    throw new ModelConfigError('vertex: service account key has no client_email');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(String(o.private_key ?? ''));
  } catch {
    throw new ModelConfigError('vertex: service account key has an invalid private_key');
  }
  const projectId = typeof o.project_id === 'string' && o.project_id ? o.project_id : null;
  return { clientEmail, privateKey, projectId };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The slice of google-auth-library's `AuthClient` that `@anthropic-ai/vertex-sdk` uses:
 * `getRequestHeaders()` and `projectId`.
 */
export class ServiceAccountAuth {
  readonly projectId: string | null;
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly opts: { fetch?: FetchLike; now?: () => number; timeoutMs?: number } = {},
  ) {
    this.projectId = key.projectId;
  }

  /** Signed assertion for the token endpoint. */
  assertion(nowMs: number): string {
    const iat = Math.floor(nowMs / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: this.key.clientEmail,
        scope: CLOUD_PLATFORM_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${b64url(signer.sign(this.key.privateKey))}`;
  }

  async accessToken(): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    this.pending ??= this.fetchToken(now).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async fetchToken(now: number): Promise<string> {
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: this.assertion(now),
    }).toString();
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new ModelProviderError('vertex: token request failed', { retryable: true, cause: err });
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
    };
    if (!res.ok || typeof data.access_token !== 'string') {
      // The OAuth error code only (e.g. invalid_grant); never the response body.
      const code = typeof data.error === 'string' ? data.error.slice(0, 40) : `HTTP ${res.status}`;
      throw new ModelProviderError(`vertex: token request refused (${code})`, {
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const ttl = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.token = { value: data.access_token, expiresAt: now + ttl * 1000 };
    return data.access_token;
  }

  async getRequestHeaders(): Promise<Headers> {
    return new Headers({ authorization: `Bearer ${await this.accessToken()}` });
  }
}
