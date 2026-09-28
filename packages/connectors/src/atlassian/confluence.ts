import type { BackfillPage, DeltaResult, NormalizedItem } from '../types';
import type { ConfluenceContent, ConfluenceSearchPage } from './api-types';
import type { AtlassianClient } from './client';
import { CursorTracker, parseCursor, parseTime, startCursor, windowMinutes } from './cursor';
import { cap, storageMentions, storageToText } from './text';

/**
 * Confluence source: pages the user created or watches, or that mention them, via CQL
 * search (`GET /wiki/rest/api/search`, cursor paging). Confluence has no dynamic webhooks
 * for OAuth 2.0 apps, so this source is polled by the scheduler's catch-up sync.
 */

export type ConfluenceRecord = {
  type: 'confluence';
  cloudId: string;
  siteUrl: string | null;
  me: string | null;
  page: ConfluenceContent;
};

const INVOLVED = 'creator = currentUser() OR watcher = currentUser() OR mention = currentUser()';
const EXPAND = 'content.body.storage,content.version,content.history,content.space';
export const CQL_PAGE_SIZE = 25;
export const CQL_MAX_PAGES = 4;
const BODY_CAP = 20_000;

export const deltaCql = (minutes: number) =>
  `type = page AND (${INVOLVED}) AND lastmodified >= now("-${minutes}m") ORDER BY lastmodified ASC`;
export const backfillCql = (days: number) =>
  `type = page AND (${INVOLVED}) AND lastmodified >= now("-${days}d") ORDER BY lastmodified DESC`;

/** The `cursor` query parameter of a `_links.next` link. */
export function nextCursor(page: ConfluenceSearchPage): string | null {
  const next = page._links?.next;
  if (!next) return null;
  try {
    return new URL(next, 'https://x.invalid').searchParams.get('cursor');
  } catch {
    return null;
  }
}

async function searchPage(api: AtlassianClient, cql: string, cursor?: string | null) {
  return api.wiki<ConfluenceSearchPage>('/search', {
    query: { cql, limit: CQL_PAGE_SIZE, expand: EXPAND, ...(cursor ? { cursor } : {}) },
  });
}

type Site = { cloudId: string; siteUrl: string | null; me: string | null };

const pagesOf = (p: ConfluenceSearchPage) =>
  p.results.map((r) => r.content).filter((c): c is ConfluenceContent => !!c && c.type === 'page');

export async function confluenceDelta(
  api: AtlassianClient,
  site: Site,
  cursor: string | null,
  now: number,
): Promise<DeltaResult<ConfluenceRecord>> {
  const prev = parseCursor(cursor);
  if (!prev) return { records: [], cursor: startCursor(now) };
  const cql = deltaCql(windowMinutes(prev, now));
  const tracker = new CursorTracker<ConfluenceContent>(
    prev,
    (p) => p.id,
    (p) => parseTime(p.version?.when),
  );
  const records: ConfluenceRecord[] = [];
  let next: string | null = null;
  let pages = 0;
  do {
    const page = await searchPage(api, cql, next);
    pages++;
    for (const p of tracker.take(pagesOf(page)))
      records.push({ type: 'confluence', ...site, page: p });
    const n = nextCursor(page);
    next = n && n !== next && page.results.length > 0 ? n : null;
  } while (next && pages < CQL_MAX_PAGES);
  return { records, cursor: tracker.cursor(), ...(next ? { hasMore: true } : {}) };
}

export async function confluenceBackfill(
  api: AtlassianClient,
  site: Site,
  days: number,
  pageToken: string | undefined,
): Promise<BackfillPage<ConfluenceRecord>> {
  const page = await searchPage(api, backfillCql(days), pageToken);
  const next = nextCursor(page);
  return {
    records: pagesOf(page).map((p) => ({ type: 'confluence', ...site, page: p })),
    nextPageToken: next && next !== pageToken ? next : null,
  };
}

export function pageUrl(siteUrl: string | null, page: ConfluenceContent): string | null {
  const webui = page._links?.webui;
  if (!siteUrl || !webui) return null;
  return `${siteUrl.replace(/\/$/, '')}/wiki${webui.startsWith('/') ? '' : '/'}${webui}`;
}

export function normalizeConfluence(r: ConfluenceRecord): NormalizedItem {
  const { page, me } = r;
  const editor = page.version?.by;
  const text = cap(storageToText(page.body?.storage?.value), BODY_CAP);
  const labels = [`confluence:page:${page.id}`];
  if (page.space?.key) labels.push(`confluence:space:${page.space.key}`);
  if (me && page.history?.createdBy?.accountId === me) labels.push('confluence:creator:me');
  // Trusted signals, from page metadata and user-link nodes only (never from text).
  const fromMe = !!me && editor?.accountId === me;
  if (storageMentions(page.body?.storage?.value, me)) labels.push('hub:mention');
  if (fromMe) labels.push('hub:from_me');
  const when = parseTime(page.version?.when);
  const space = page.space?.name ?? page.space?.key;
  const who = editor?.accountId && editor.accountId === me ? 'you' : editor?.displayName;
  return {
    kind: 'note',
    externalId: `confluence:${page.id}`,
    threadId: null,
    author: editor?.displayName ?? editor?.publicName ?? null,
    authorAddress: editor?.email || null,
    title: page.title,
    summary: [space, who ? `edited by ${who}` : null].filter(Boolean).join(' · ') || null,
    body: text || null,
    url: pageUrl(r.siteUrl, page),
    labels,
    receivedAt: new Date(Number.isFinite(when) ? when : Date.now()),
    fromMe,
  };
}
