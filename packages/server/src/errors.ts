/** BullMQ control-flow errors; BullMQ itself recognises them by name. */
const BULLMQ_CONTROL = new Set([
  'UnrecoverableError',
  'DelayedError',
  'WaitingError',
  'WaitingChildrenError',
  'RateLimitError',
]);

/**
 * Log-safe summary of an error: class name, driver/system code and HTTP status only.
 * Never the message: database errors (DrizzleQueryError) put the SQL and its bound params
 * — which can include message text, addresses or tokens — in `message`.
 */
export function errorInfo(e: unknown): { err: string; code?: string; status?: number } {
  if (!e || typeof e !== 'object') return { err: typeof e };
  if (e instanceof SanitizedJobError) {
    const out: { err: string; code?: string; status?: number } = { err: e.originalName };
    if (e.code) out.code = e.code;
    if (e.status !== undefined) out.status = e.status;
    return out;
  }
  const x = e as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown };
  const cause = (x.cause && typeof x.cause === 'object' ? x.cause : {}) as { code?: unknown };
  const code =
    typeof cause.code === 'string' ? cause.code : typeof x.code === 'string' ? x.code : undefined;
  const out: { err: string; code?: string; status?: number } = {
    err: typeof x.name === 'string' ? x.name : 'Error',
  };
  if (code) out.code = code.slice(0, 40);
  if (typeof x.status === 'number') out.status = x.status;
  return out;
}

/** Error thrown to BullMQ in place of the original, so `failedReason` carries no params. */
export class SanitizedJobError extends Error {
  readonly originalName: string;
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(original: unknown) {
    const info = errorInfo(original);
    super(
      [info.err, info.code ? `code=${info.code}` : '', info.status ? `status=${info.status}` : '']
        .filter(Boolean)
        .join(' '),
    );
    this.name = 'SanitizedJobError';
    this.originalName = info.err;
    this.code = info.code;
    this.status = info.status;
  }
}

/**
 * Maps an error escaping a job processor to one that is safe to store in Redis
 * (`failedReason`, `stacktrace`). BullMQ control-flow errors pass through unchanged:
 * their messages are ours and their class drives retry behaviour.
 */
export function sanitizeJobError(err: unknown): Error {
  if (err instanceof SanitizedJobError) return err;
  if (err instanceof Error && BULLMQ_CONTROL.has(err.name)) return err;
  const safe = new SanitizedJobError(err);
  // Keep the original stack frames (file:line only), but not the original message line.
  if (err instanceof Error && err.stack) {
    const frames = err.stack.split('\n').filter((l) => /^\s+at /.test(l));
    safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join('\n');
  }
  return safe;
}
