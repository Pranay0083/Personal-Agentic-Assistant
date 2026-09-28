import { RetryableError } from '../errors';
import { createHttp, type FetchFn, type RequestOptions } from '../lib/http';
import { NOTION_API, NOTION_VERSION } from './config';

/** The subset of Notion API objects the connector reads. */
export type RichText = {
  plain_text?: string;
  type?: string;
  href?: string | null;
  /** `type: 'mention'` pieces; `mention.type: 'user'` carries the mentioned user's id. */
  mention?: { type?: string; user?: { id?: string } };
};

export type NotionUserRef = { object?: 'user'; id: string };

export type NotionPage = {
  object: 'page';
  id: string;
  created_time: string;
  last_edited_time: string;
  created_by?: NotionUserRef;
  last_edited_by?: NotionUserRef;
  in_trash?: boolean;
  /** Pre-2026-03-11 name of `in_trash`. */
  archived?: boolean;
  url?: string;
  parent?: { type: string; [k: string]: unknown };
  properties?: Record<string, { type: string; title?: RichText[]; [k: string]: unknown }>;
};

export type NotionBlock = {
  object: 'block';
  id: string;
  type: string;
  has_children?: boolean;
  in_trash?: boolean;
  archived?: boolean;
  [k: string]: unknown;
};

export type NotionList<T> = {
  object: 'list';
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
};

export type NotionUser = {
  object: 'user';
  id: string;
  type?: 'person' | 'bot';
  name?: string | null;
  person?: { email?: string };
};

export type NotionClientOptions = {
  token: string;
  fetch?: FetchFn;
  /**
   * Minimum gap between requests. Notion allows ~3 requests/s per integration on average,
   * so the default is 350ms. Tests pass 0.
   */
  minIntervalMs?: number;
  /** Longest Retry-After we wait out in-process; longer ones go back to the queue. */
  maxRetryWaitMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Rate-limit aware Notion REST client. Spaces requests out and honours 429 Retry-After
 * (the lib's RetryableError.retryAfterMs) a few times before giving the error to the queue.
 */
export function createNotionClient(opts: NotionClientOptions) {
  const http = createHttp({
    provider: 'notion',
    baseUrl: NOTION_API,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    headers: { 'Notion-Version': NOTION_VERSION },
  });
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const minGap = opts.minIntervalMs ?? 350;
  const maxWait = opts.maxRetryWaitMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 3;
  let nextAt = 0;
  let requests = 0;

  async function call<T>(path: string, r: RequestOptions = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = nextAt - now();
      if (wait > 0) await sleep(wait);
      nextAt = now() + minGap;
      requests++;
      try {
        return await http.request<T>(path, { ...r, token: opts.token });
      } catch (e) {
        if (!(e instanceof RetryableError) || e.status !== 429 || attempt >= maxRetries) throw e;
        const ms = e.retryAfterMs ?? 1000;
        if (ms > maxWait) throw e;
        await sleep(ms);
      }
    }
  }

  return {
    /** Number of HTTP requests made so far (for body-size budgeting and tests). */
    get requests() {
      return requests;
    },
    searchPages(p: { startCursor?: string | null; pageSize?: number }) {
      return call<NotionList<NotionPage>>('/v1/search', {
        method: 'POST',
        body: {
          filter: { property: 'object', value: 'page' },
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          page_size: p.pageSize ?? 100,
          ...(p.startCursor ? { start_cursor: p.startCursor } : {}),
        },
      });
    },
    blockChildren(blockId: string, startCursor?: string | null) {
      return call<NotionList<NotionBlock>>(`/v1/blocks/${encodeURIComponent(blockId)}/children`, {
        query: { page_size: 100, start_cursor: startCursor ?? undefined },
      });
    },
    /** Null when the integration lacks the "read user information" capability. */
    user(id: string) {
      return call<NotionUser | null>(`/v1/users/${encodeURIComponent(id)}`, {
        allow: [403, 404],
      });
    },
  };
}

export type NotionClient = ReturnType<typeof createNotionClient>;
