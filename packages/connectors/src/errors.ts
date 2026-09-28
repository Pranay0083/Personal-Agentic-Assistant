/**
 * Typed connector errors. Callers branch on these instead of provider-specific shapes:
 * - ReconnectRequiredError: the token is revoked or expired for good (401, invalid_grant).
 *   Mark the account `reconnect`; do not retry.
 * - RetryableError: rate limited or provider hiccup (429, 5xx, network). Throw so the
 *   queue backs off; honour `retryAfterMs` when present.
 *
 * Messages never contain tokens or message content.
 */
export class ConnectorError extends Error {
  readonly provider: string;
  readonly status: number | undefined;

  constructor(provider: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ConnectorError';
    this.provider = provider;
    this.status = opts.status;
  }
}

export class ReconnectRequiredError extends ConnectorError {
  constructor(provider: string, message = 'reconnect required', opts: { status?: number } = {}) {
    super(provider, message, opts);
    this.name = 'ReconnectRequiredError';
  }
}

export class RetryableError extends ConnectorError {
  readonly retryAfterMs: number | undefined;

  constructor(
    provider: string,
    message = 'temporary provider error',
    opts: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(provider, message, opts);
    this.name = 'RetryableError';
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** The OAuth grant does not include a scope we need (the user unticked it on the consent screen). */
export class MissingScopeError extends ConnectorError {
  readonly missing: string[];

  constructor(provider: string, missing: string[]) {
    super(provider, `missing scopes: ${missing.join(' ')}`);
    this.name = 'MissingScopeError';
    this.missing = missing;
  }
}

export class NotImplementedError extends ConnectorError {
  constructor(provider: string, what = 'connector') {
    super(provider, `${what} not implemented for ${provider}`);
    this.name = 'NotImplementedError';
  }
}

export const isReconnectRequired = (e: unknown): e is ReconnectRequiredError =>
  e instanceof ReconnectRequiredError;
export const isRetryable = (e: unknown): e is RetryableError => e instanceof RetryableError;

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
