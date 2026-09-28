/** Base class for model errors. `retryable` drives the router's backoff. */
export class ModelError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ModelError';
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }
}

/** A provider call failed (HTTP error, connection error, bad response). */
export class ModelProviderError extends ModelError {
  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, opts);
    this.name = 'ModelProviderError';
  }
}

export class ModelTimeoutError extends ModelError {
  constructor(ms: number) {
    super(`model call timed out after ${ms}ms`, { retryable: true });
    this.name = 'ModelTimeoutError';
  }
}

/** The model declined the request (Anthropic `stop_reason: "refusal"`). */
export class ModelRefusalError extends ModelError {
  constructor(message = 'model declined the request') {
    super(message, { retryable: false });
    this.name = 'ModelRefusalError';
  }
}

/** Misconfiguration: missing key, unknown provider, adapter not implemented yet. */
export class ModelConfigError extends ModelError {
  constructor(message: string) {
    super(message, { retryable: false });
    this.name = 'ModelConfigError';
  }
}

/** The user's monthly model budget (`settings.monthlyCapUsd`) is used up. Never retried. */
export class BudgetExceededError extends Error {
  readonly userId: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  constructor(userId: string, capUsd: number, spentUsd: number) {
    super(`monthly model budget reached ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)})`);
    this.name = 'BudgetExceededError';
    this.userId = userId;
    this.capUsd = capUsd;
    this.spentUsd = spentUsd;
  }
}

/** Status-code based classification, shared by the SDK adapters. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Whether an arbitrary error is worth retrying: our own ModelErrors carry the flag;
 * anything with an HTTP `status` is classified by status; network errors are retryable.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof BudgetExceededError) return false;
  if (err instanceof ModelError) return err.retryable;
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; code?: unknown; name?: unknown };
    if (typeof e.status === 'number') return isRetryableStatus(e.status);
    if (
      typeof e.code === 'string' &&
      /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|UND_ERR)/.test(e.code)
    ) {
      return true;
    }
    if (typeof e.name === 'string' && /Connection|Timeout/i.test(e.name)) return true;
  }
  return false;
}
