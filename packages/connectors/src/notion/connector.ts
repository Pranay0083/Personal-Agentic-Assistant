import { ConnectorError } from '../errors';
import type { Store } from '../lib/fake';
import type { FetchFn } from '../lib/http';
import { authorizeUrl, createHttp, exchangeCode, toTokens, type OAuth2Config } from '../lib';
import type { Connector, ConnectorContext, ConnectorInfo, SubscriptionInfo } from '../types';
import { DEFAULT_FLATTEN_LIMITS, flattenPage, type FlattenLimits } from './blocks';
import {
  createNotionClient,
  type NotionClient,
  type NotionClientOptions,
  type NotionPage,
} from './client';
import {
  NOTION_AUTHORIZE_URL,
  NOTION_REVOKE_URL,
  NOTION_TOKEN_URL,
  notionConfigFromEnv,
  notionWebhookKey,
  type NotionConfig,
} from './config';
import {
  fakeNotionFetch,
  fakeNotionStore,
  notionTime,
  pickFakeWorkspace,
  type FakeNotionState,
} from './fake';
import { normalizeNotion, type NotionRecord } from './normalize';
import { verifyNotionWebhook, type NotionWebhookLog } from './webhook';

export const NOTION_INFO: ConnectorInfo = {
  name: 'Notion',
  covers: 'Only pages you pick',
  multiAccountNote: 'Connect each workspace separately. You pick the pages in Notion.',
  sources: [
    {
      id: 'pages',
      label: 'Pages',
      hint: 'Pages you shared with Hub during sign-in',
      kind: 'note',
      defaultOn: true,
    },
  ],
  options: [],
  writeActions: [],
};

export type NotionConnectorOptions = {
  config?: NotionConfig | (() => NotionConfig);
  /** Replaces the network (tests replay recorded fixtures through mockFetch). */
  fetch?: FetchFn;
  fakeStore?: Store<FakeNotionState>;
  client?: Omit<NotionClientOptions, 'token' | 'fetch'>;
  limits?: FlattenLimits;
  /** How far back each delta re-scans to cover search-index lag (default 5 min). */
  overlapMs?: number;
  /** Pages (with bodies) fetched per fetchDelta call; the rest come with hasMore. */
  maxPagesPerRun?: number;
  /** Search results scanned per delta before giving up and asking for a backfill. */
  maxScan?: number;
  backfillPageSize?: number;
  now?: () => number;
  onVerificationToken?: (token: string) => string | null | void;
  log?: NotionWebhookLog;
};

/** Delta cursor: newest processed edit time plus pages already synced at their edit time. */
export type NotionCursor = { t: string; seen: Record<string, string> };

export function parseNotionCursor(s: string): NotionCursor {
  try {
    const v = JSON.parse(s) as Partial<NotionCursor>;
    if (typeof v.t === 'string') return { t: v.t, seen: v.seen ?? {} };
  } catch {
    // A bare timestamp.
  }
  if (!Number.isFinite(Date.parse(s))) throw new ConnectorError('notion', 'bad delta cursor');
  return { t: s, seen: {} };
}

/** Notion's edit times are minute-rounded: only a closed minute can be marked as seen. */
const MINUTE_CLOSED_MS = 65_000;

export function createNotionConnector(opts: NotionConnectorOptions = {}): Connector<NotionRecord> {
  const cfg = (): NotionConfig =>
    typeof opts.config === 'function' ? opts.config() : (opts.config ?? notionConfigFromEnv());
  const now = opts.now ?? Date.now;
  const overlap = opts.overlapMs ?? 5 * 60_000;
  const perRun = opts.maxPagesPerRun ?? 25;
  const maxScan = opts.maxScan ?? 1000;
  const limits = opts.limits ?? DEFAULT_FLATTEN_LIMITS;
  let store: Store<FakeNotionState> | undefined = opts.fakeStore;
  const fakeStore = () => (store ??= fakeNotionStore());

  const fetchFor = (c: NotionConfig): FetchFn | undefined =>
    opts.fetch ?? (c.fake ? fakeNotionFetch(fakeStore()) : undefined);

  const oauth = (c: NotionConfig): OAuth2Config => {
    const f = fetchFor(c);
    return {
      provider: 'notion',
      authorizeUrl: NOTION_AUTHORIZE_URL,
      tokenUrl: NOTION_TOKEN_URL,
      clientId: c.clientId ?? (c.fake ? 'fake-notion-client' : ''),
      clientSecret: c.clientSecret ?? (c.fake ? 'fake-notion-secret' : ''),
      clientAuth: 'basic',
      jsonBody: true,
      ...(f ? { fetch: f } : {}),
    };
  };

  function clientFor(ctx: ConnectorContext): NotionClient {
    const f = fetchFor(cfg());
    return createNotionClient({
      token: ctx.tokens.accessToken,
      ...(f ? { fetch: f } : {}),
      now,
      ...opts.client,
    });
  }

  const ownerOf = (ctx: ConnectorContext): string | null =>
    (typeof ctx.meta?.ownerUserId === 'string' ? ctx.meta.ownerUserId : null) ??
    ctx.externalId.split(':')[1] ??
    null;

  /** Fetches bodies and editors for pages; pages unshared in the meantime are skipped. */
  async function toRecords(ctx: ConnectorContext, client: NotionClient, pages: NotionPage[]) {
    const owner = ownerOf(ctx);
    const editors = new Map<string, NotionRecord['editor']>();
    const out: NotionRecord[] = [];
    for (const page of pages) {
      let flat;
      try {
        flat = await flattenPage(client, page.id, limits);
      } catch (e) {
        if (e instanceof ConnectorError && e.status === 404) continue;
        throw e;
      }
      const editorId = page.last_edited_by?.id;
      let editor: NotionRecord['editor'] = null;
      if (editorId) {
        if (!editors.has(editorId)) {
          const u = await client.user(editorId);
          editors.set(
            editorId,
            u ? { name: u.name ?? null, email: u.person?.email ?? null } : null,
          );
        }
        editor = editors.get(editorId) ?? null;
      }
      out.push({
        page,
        text: flat.text,
        truncated: flat.truncated,
        mentions: flat.mentions,
        ownerUserId: owner,
        editor,
      });
    }
    return out;
  }

  const initialCursor = () =>
    JSON.stringify({ t: notionTime(now()), seen: {} } satisfies NotionCursor);

  async function subscribe(): Promise<SubscriptionInfo> {
    // Integration webhooks are configured once per integration, not per account.
    return { externalSubId: null, expiresAt: null, cursor: initialCursor() };
  }

  return {
    provider: 'notion',
    info: NOTION_INFO,
    configured() {
      const c = cfg();
      return c.fake || (!!c.clientId && !!c.clientSecret);
    },

    connect: {
      authUrl({ state, redirectUri, access, loginHint }) {
        if (access !== 'read') throw new ConnectorError('notion', 'Notion is read-only in Hub');
        const c = cfg();
        if (c.fake) {
          const ws = pickFakeWorkspace(fakeStore(), loginHint);
          const u = new URL(redirectUri);
          u.searchParams.set('code', `fake-notion:${ws.id}`);
          u.searchParams.set('state', state);
          return u.toString();
        }
        return authorizeUrl(oauth(c), { state, redirectUri, extra: { owner: 'user' } });
      },

      async exchange({ code, redirectUri, access }) {
        if (access === 'write') throw new ConnectorError('notion', 'Notion is read-only in Hub');
        const r = await exchangeCode(oauth(cfg()), { code, redirectUri });
        const workspaceId = typeof r.workspace_id === 'string' ? r.workspace_id : null;
        const owner = r.owner as { type?: string; user?: { id?: string } } | undefined;
        const ownerUserId = owner?.type === 'user' ? (owner.user?.id ?? null) : null;
        if (!workspaceId || !ownerUserId) {
          throw new ConnectorError('notion', 'token response lacks workspace or owner user');
        }
        const workspaceName = typeof r.workspace_name === 'string' ? r.workspace_name : null;
        const externalId = `${workspaceId}:${ownerUserId}`;
        const meta = {
          workspaceId,
          workspaceName,
          botId: typeof r.bot_id === 'string' ? r.bot_id : null,
          ownerUserId,
        };
        return {
          tokens: toTokens(r),
          externalId,
          displayName: workspaceName,
          identities: [{ externalId, displayName: workspaceName, routeKeys: [workspaceId], meta }],
        };
      },

      async revoke(tokens) {
        const o = oauth(cfg());
        const http = createHttp({
          provider: 'notion',
          baseUrl: NOTION_REVOKE_URL,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        const basic = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64');
        // 400 = already invalid, which is what we wanted.
        await http.request(NOTION_REVOKE_URL, {
          method: 'POST',
          body: { token: tokens.accessToken },
          headers: { authorization: `Basic ${basic}` },
          allow: [400, 404],
        });
      },
    },

    subscribe,
    renew: subscribe,

    async verifyWebhook(req) {
      const c = cfg();
      return verifyNotionWebhook(req, {
        key: notionWebhookKey(c),
        configuredToken: c.webhookVerificationToken,
        ...(opts.onVerificationToken ? { onVerificationToken: opts.onVerificationToken } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
    },

    async fetchDelta(ctx) {
      if (!ctx.cursor) return { records: [], cursor: initialCursor() };
      const cur = parseNotionCursor(ctx.cursor);
      const since = Date.parse(cur.t) - overlap;
      const client = clientFor(ctx);

      const candidates: NotionPage[] = [];
      let start: string | null = null;
      let reachedEnd = false;
      scan: do {
        const res = await client.searchPages({ startCursor: start, pageSize: 100 });
        for (const p of res.results) {
          if (Date.parse(p.last_edited_time) < since) {
            reachedEnd = true;
            break scan;
          }
          candidates.push(p);
        }
        start = res.has_more ? res.next_cursor : null;
        if (!start) reachedEnd = true;
      } while (start && candidates.length < maxScan);
      if (!reachedEnd) {
        // More edits than one scan covers: start over from now and let the caller backfill.
        return { records: [], cursor: initialCursor(), fullResyncRequired: true };
      }

      const fresh = candidates
        .filter((p) => cur.seen[p.id] !== p.last_edited_time)
        .sort((a, b) => a.last_edited_time.localeCompare(b.last_edited_time));
      const batch = fresh.slice(0, perRun);
      const records = await toRecords(ctx, client, batch);

      const last = batch.at(-1)?.last_edited_time;
      const t = last && last > cur.t ? last : cur.t;
      const keepFrom = Date.parse(t) - overlap;
      const seen: Record<string, string> = {};
      for (const [id, at] of Object.entries(cur.seen))
        if (Date.parse(at) >= keepFrom) seen[id] = at;
      for (const p of batch) {
        if (now() - Date.parse(p.last_edited_time) >= MINUTE_CLOSED_MS)
          seen[p.id] = p.last_edited_time;
      }
      return {
        records,
        cursor: JSON.stringify({ t, seen } satisfies NotionCursor),
        ...(fresh.length > batch.length ? { hasMore: true } : {}),
      };
    },

    async backfill(ctx, { days, pageToken }) {
      const client = clientFor(ctx);
      const cutoff = now() - days * 86400_000;
      const res = await client.searchPages({
        startCursor: pageToken ?? null,
        pageSize: opts.backfillPageSize ?? 20,
      });
      const pages = res.results.filter((p) => Date.parse(p.last_edited_time) >= cutoff);
      const records = await toRecords(ctx, client, pages);
      const done = pages.length < res.results.length || !res.has_more;
      return { records, nextPageToken: done ? null : res.next_cursor };
    },

    normalize: (raw) => normalizeNotion(raw),
  };
}
