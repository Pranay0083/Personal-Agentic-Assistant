import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Demo mode. With `CONNECTORS_FAKE=1` (or the provider's own flag, e.g. `GMAIL_FAKE=1`)
 * a connector serves recorded fixtures instead of calling the provider. Never in production.
 */
export function fakeMode(providerFlag?: string): boolean {
  const on = (v: string | undefined) => v === '1' || v === 'true';
  const enabled =
    on(process.env.CONNECTORS_FAKE) || (providerFlag ? on(process.env[providerFlag]) : false);
  if (enabled && process.env.NODE_ENV === 'production') {
    throw new Error('fake connectors are not allowed in production');
  }
  return enabled;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Default location of a provider's fake store: <repo>/.dev/fake-<provider>.json (gitignored). */
export function defaultFakePath(provider: string): string {
  return path.join(repoRoot, '.dev', `fake-${provider}.json`);
}

/**
 * A tiny JSON-file store shared across processes (api, gateway, workers) so a dev script
 * can "send" a message that the sync worker later fetches. Reads re-load the file every
 * time; writes are atomic (write + rename). Good enough for local demos and tests.
 */
export class JsonFileStore<T extends object> {
  constructor(
    readonly file: string,
    private readonly seed: () => T,
  ) {}

  read(): T {
    if (!existsSync(this.file)) {
      const initial = this.seed();
      this.write(initial);
      return initial;
    }
    return JSON.parse(readFileSync(this.file, 'utf8')) as T;
  }

  write(data: T): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }

  update<R>(fn: (data: T) => R): R {
    const data = this.read();
    const out = fn(data);
    this.write(data);
    return out;
  }
}

/** In-memory variant for tests. */
export class MemoryStore<T extends object> {
  private data: T;
  constructor(seed: () => T) {
    this.data = seed();
  }
  read(): T {
    return this.data;
  }
  write(data: T): void {
    this.data = data;
  }
  update<R>(fn: (data: T) => R): R {
    return fn(this.data);
  }
}

export type Store<T extends object> = Pick<JsonFileStore<T>, 'read' | 'write' | 'update'>;

/** Loads a recorded fixture JSON next to the calling module: `fixture(import.meta.url, 'x.json')`. */
export function fixture<T = unknown>(moduleUrl: string, name: string): T {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  return JSON.parse(readFileSync(path.join(dir, 'fixtures', name), 'utf8')) as T;
}

/**
 * Builds a fetch that answers from a route table of recorded responses, for tests:
 * `mockFetch({ 'GET /v1.0/me/messages/delta': fixture(...), 'POST /x': { status: 429 } })`.
 * Unknown routes answer 404. Records every call for assertions.
 */
export function mockFetch(
  routes: Record<
    string,
    unknown | { status: number; body?: unknown; headers?: Record<string, string> }
  >,
) {
  const calls: {
    method: string;
    url: URL;
    body: string | undefined;
    headers: Record<string, string>;
  }[] = [];
  const fn = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers,
    });
    const key = `${method} ${url.pathname}`;
    const hit = routes[key] ?? routes[`${key}?${url.searchParams.toString()}`];
    if (hit === undefined) return new Response('not found', { status: 404 });
    const spec =
      hit &&
      typeof hit === 'object' &&
      'status' in (hit as object) &&
      typeof (hit as { status: unknown }).status === 'number'
        ? (hit as { status: number; body?: unknown; headers?: Record<string, string> })
        : { status: 200, body: hit };
    const body =
      typeof spec.body === 'function' ? (spec.body as (u: URL) => unknown)(url) : spec.body;
    return new Response(
      body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
      {
        status: spec.status,
        headers: { 'content-type': 'application/json', ...spec.headers },
      },
    );
  }) as typeof fetch;
  return { fetch: fn, calls };
}
