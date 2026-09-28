import { ConnectorError, ReconnectRequiredError, RetryableError } from '../errors';

/**
 * Small fetch wrapper for REST connectors. Maps provider failures to the typed errors
 * callers branch on:
 * - 401 (and provider-specific "token revoked" signals) → ReconnectRequiredError
 * - 429, 5xx, timeouts, network errors → RetryableError (with Retry-After when sent)
 * - anything else non-2xx → ConnectorError with the status
 * Error messages carry the method, path and status only: never bodies, tokens or query
 * strings (which can contain search terms).
 */
export type FetchFn = typeof fetch;

export type HttpOptions = {
  provider: string;
  baseUrl: string;
  /** Injected in tests to replay recorded fixtures. */
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Extra headers on every request (e.g. Notion-Version). */
  headers?: Record<string, string>;
  /** Treat a 200 response as a failure (Slack returns 200 with `ok:false`). */
  checkBody?: (
    status: number,
    body: unknown,
  ) => { reconnect?: boolean; retry?: boolean; error?: string } | null;
};

export type RequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Sent as application/x-www-form-urlencoded instead of JSON. */
  form?: Record<string, string>;
  token?: string;
  headers?: Record<string, string>;
  /** Return null instead of throwing for these statuses (e.g. 404 for "already gone"). */
  allow?: number[];
};

const DEFAULT_TIMEOUT_MS = 30_000;

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export function createHttp(opts: HttpOptions) {
  const doFetch = opts.fetch ?? fetch;

  async function request<T = unknown>(path: string, r: RequestOptions = {}): Promise<T> {
    const method = r.method ?? (r.body !== undefined || r.form ? 'POST' : 'GET');
    const url = new URL(path.startsWith('http') ? path : opts.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(r.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...opts.headers,
      ...r.headers,
    };
    if (r.token) headers.authorization = `Bearer ${r.token}`;
    let body: string | undefined;
    if (r.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(r.form).toString();
    } else if (r.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(r.body);
    }
    const where = `${method} ${url.pathname}`;

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout or network error: the request may or may not have reached the provider.
      throw new RetryableError(opts.provider, `${where} failed (${(err as Error).name})`);
    }

    if (r.allow?.includes(res.status)) return null as T;
    if (res.status === 401)
      throw new ReconnectRequiredError(opts.provider, `${where} → 401`, { status: 401 });
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(opts.provider, `${where} → ${res.status}`, {
        status: res.status,
        retryAfterMs: retryAfterMs(res),
      });
    }
    if (!res.ok)
      throw new ConnectorError(opts.provider, `${where} → ${res.status}`, { status: res.status });

    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : null;
    const verdict = opts.checkBody?.(res.status, parsed);
    if (verdict) {
      const msg = `${where} → ${verdict.error ?? 'error'}`;
      if (verdict.reconnect) throw new ReconnectRequiredError(opts.provider, msg);
      if (verdict.retry) throw new RetryableError(opts.provider, msg);
      throw new ConnectorError(opts.provider, msg);
    }
    return parsed as T;
  }

  return { request };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type Http = ReturnType<typeof createHttp>;
