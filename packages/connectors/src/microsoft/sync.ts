import type { BackfillPage, ConnectorContext, DeltaResult } from '../types';
import type { MicrosoftConfig } from './config';
import {
  encodeCursor,
  parseCursor,
  type CalendarCursor,
  type ChannelsCursor,
  type DriveCursor,
  type MailCursor,
  type TeamsCursor,
} from './cursor';
import { outlookPrefer, type Graph } from './graph';
import type {
  GraphChat,
  GraphChatMessage,
  GraphCollection,
  GraphDriveItem,
  GraphEvent,
  GraphMessage,
  MsOwner,
  MsRecord,
} from './graph-types';

/**
 * Pulling changes per source.
 *
 * - mail: `/me/mailFolders/{inbox,sentitems}/messages/delta`, one delta link per folder.
 *   The first round is filtered to `receivedDateTime ge <now - FIRST_ROUND_LOOKBACK>` (Graph
 *   keeps the filter in the token), so connecting doesn't enumerate the mailbox (history
 *   comes from backfill) yet mail that arrived between connect and the first round isn't
 *   lost. Ingest upserts on the message id, so the overlap with backfill is harmless.
 * - calendar: `/me/calendarView/delta` over [now-1d, now+30d]. Graph fixes the window in
 *   the token, so the window is restarted (a fresh round) once it is a week old.
 * - teams: Graph has no delta for chat messages and no way to subscribe to all of a user's
 *   chats *and* page their changes, so this is a watermark poll: `/me/chats` ordered by
 *   last message, stop at the first chat older than the watermark, and list each newer
 *   chat's messages with `lastModifiedDateTime gt <since>`. The user-level subscription
 *   `/users/{id}/chats/getAllMessages` (Chat.Read) only tells us *when* to poll.
 * - channels (optional, admin consent): joined teams → channels → per-channel messages
 *   delta filtered by the watermark. Polled only (no delegated tenant-wide subscription).
 * - onedrive: `/me/drive/root/delta`, first round with `token=latest`. Metadata only.
 *
 * Expired delta tokens (HTTP 410, see graphFetch) restart the source from "now" and report
 * `fullResyncRequired` so the caller backfills.
 */

export type SyncDeps = { cfg: MicrosoftConfig; graph: Graph; ctx: ConnectorContext };

const MAIL_SELECT = [
  'id',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'conversationId',
  'internetMessageId',
  'webLink',
  'parentFolderId',
  'isDraft',
  'categories',
  'inferenceClassification',
  'importance',
].join(',');

const DRIVE_SELECT = [
  'id',
  'name',
  'webUrl',
  'size',
  'createdDateTime',
  'lastModifiedDateTime',
  'file',
  'folder',
  'root',
  'deleted',
  'parentReference',
  'createdBy',
  'lastModifiedBy',
].join(',');

const FOLDERS = { inbox: 'inbox', sent: 'sentitems' } as const;
type FolderKey = keyof typeof FOLDERS;

/** Clock-skew overlap for watermark polls; duplicates are upserts downstream. */
const OVERLAP_MS = 2 * 60_000;
const CHAT_MESSAGE_PAGES = 4;
const CHANNELS_PER_CALL = 10;

export function ownerOf(ctx: ConnectorContext): MsOwner {
  const m = ctx.meta ?? {};
  const addresses = [m.mail, m.upn]
    .filter((a): a is string => typeof a === 'string' && a.includes('@'))
    .map((a) => a.toLowerCase());
  return { id: ctx.externalId, addresses: [...new Set(addresses)] };
}

/** Query string with `%20` for spaces and literal `$` (Graph's OData parser wants both). */
export function qs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%24/g, '$')}=${encodeURIComponent(v)}`)
    .join('&');
}

const nowOf = (cfg: MicrosoftConfig) => cfg.now?.() ?? Date.now();
/**
 * How far back a source's very first delta round reaches. Messages that arrive after the
 * account is connected but before its first round (e.g. the one whose notification
 * triggered the first sync) would otherwise be skipped.
 */
export const FIRST_ROUND_LOOKBACK_MS = 24 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const isPersonal = (ctx: ConnectorContext) => ctx.meta?.personal === true;

type Round<T> = { items: T[]; link: string | null; complete: boolean; expired: boolean };

/**
 * Follows a delta round from `link` for at most `maxPages` pages. Returns the link to resume
 * from (nextLink if the round is unfinished, deltaLink once it completes).
 */
async function followDelta<T>(
  graph: Graph,
  link: string,
  maxPages: number,
  prefer: string[] = [],
): Promise<Round<T>> {
  const items: T[] = [];
  let current = link;
  for (let page = 0; page < maxPages; page++) {
    const res = await graph.request<GraphCollection<T> | null>(current, { prefer, allow: [410] });
    if (!res) return { items, link: null, complete: false, expired: true };
    items.push(...(res.value ?? []));
    if (res['@odata.deltaLink']) {
      return { items, link: res['@odata.deltaLink'], complete: true, expired: false };
    }
    if (!res['@odata.nextLink']) return { items, link: current, complete: true, expired: false };
    current = res['@odata.nextLink'];
  }
  return { items, link: current, complete: false, expired: false };
}

// ---------------------------------------------------------------------------------- mail

function mailStart(cfg: MicrosoftConfig, folder: FolderKey, sinceMs: number): string {
  const q = qs({
    $select: MAIL_SELECT,
    $filter: `receivedDateTime ge ${iso(sinceMs)}`,
    changeType: 'created',
  });
  return `${cfg.graphBaseUrl}/me/mailFolders/${FOLDERS[folder]}/messages/delta?${q}`;
}

function mailFolders(ctx: ConnectorContext): FolderKey[] {
  const out: FolderKey[] = [];
  if (ctx.filters.inbox) out.push('inbox');
  if (ctx.filters.sent) out.push('sent');
  return out;
}

async function mailDelta({ cfg, graph, ctx }: SyncDeps): Promise<DeltaResult<MsRecord>> {
  const owner = ownerOf(ctx);
  const prefer = outlookPrefer(cfg.pageSize);
  const stored = parseCursor<MailCursor>(ctx.cursor);
  const cur: MailCursor = stored ?? { v: 1 };
  const records: MsRecord[] = [];
  const seen = new Set<string>();
  let hasMore = false;
  let expired = false;
  for (const folder of mailFolders(ctx)) {
    const from = cur[folder] ?? mailStart(cfg, folder, nowOf(cfg) - FIRST_ROUND_LOOKBACK_MS);
    let round = await followDelta<GraphMessage>(graph, from, cfg.maxPages, prefer);
    if (round.expired) {
      expired = true;
      round = await followDelta<GraphMessage>(
        graph,
        mailStart(cfg, folder, nowOf(cfg)),
        cfg.maxPages,
        prefer,
      );
    }
    cur[folder] = round.link;
    if (!round.complete) hasMore = true;
    for (const message of round.items) {
      if (message['@removed'] || seen.has(message.id)) continue;
      seen.add(message.id);
      records.push({ source: 'mail', folder, message, owner });
    }
  }
  return {
    records,
    cursor: encodeCursor(cur),
    ...(hasMore ? { hasMore } : {}),
    ...(expired ? { fullResyncRequired: true } : {}),
  };
}

async function mailBackfill(
  { cfg, graph, ctx }: SyncDeps,
  days: number,
  pageToken?: string,
): Promise<BackfillPage<MsRecord>> {
  const folders = mailFolders(ctx);
  const tok = pageToken ? (JSON.parse(pageToken) as { f: FolderKey; next?: string }) : null;
  const folder = tok?.f ?? folders[0];
  if (!folder) return { records: [], nextPageToken: null };
  const since = nowOf(cfg) - Math.max(1, days) * 86_400_000;
  const q = qs({
    $select: MAIL_SELECT,
    $filter: `receivedDateTime ge ${iso(since)}`,
    $orderby: 'receivedDateTime desc',
    $top: String(cfg.pageSize),
  });
  const link = tok?.next ?? `${cfg.graphBaseUrl}/me/mailFolders/${FOLDERS[folder]}/messages?${q}`;
  const res = await graph.request<GraphCollection<GraphMessage>>(link, {
    prefer: outlookPrefer(),
  });
  const owner = ownerOf(ctx);
  const records: MsRecord[] = (res.value ?? []).map((message) => ({
    source: 'mail',
    folder,
    message,
    owner,
  }));
  const next = res['@odata.nextLink'];
  if (next) return { records, nextPageToken: JSON.stringify({ f: folder, next }) };
  const after = folders[folders.indexOf(folder) + 1];
  return { records, nextPageToken: after ? JSON.stringify({ f: after }) : null };
}

// ------------------------------------------------------------------------------ calendar

const CAL_PREFER = ['outlook.timezone="UTC"', 'IdType="ImmutableId"'];
const WINDOW_BEHIND_MS = 86_400_000;
const WINDOW_ROLL_MS = 7 * 86_400_000;

function calendarStart(cfg: MicrosoftConfig, start: string, end: string) {
  const q = qs({ startDateTime: start, endDateTime: end });
  return `${cfg.graphBaseUrl}/me/calendarView/delta?${q}`;
}

async function calendarDelta({ cfg, graph, ctx }: SyncDeps): Promise<DeltaResult<MsRecord>> {
  const now = nowOf(cfg);
  const owner = ownerOf(ctx);
  const prefer = [...CAL_PREFER, `odata.maxpagesize=${cfg.pageSize}`];
  const stored = parseCursor<CalendarCursor>(ctx.cursor);
  const fresh = (): CalendarCursor => {
    const start = iso(now - WINDOW_BEHIND_MS);
    const end = iso(now + cfg.calendarDaysAhead * 86_400_000);
    return { v: 1, link: null, start, end };
  };
  // Roll the window forward once it is a week old (only between rounds).
  const stale = stored && stored.link && Date.parse(stored.start) + WINDOW_ROLL_MS < now;
  let cur = stored && !(stale && isDeltaLink(stored.link)) ? stored : fresh();
  let round = await followDelta<GraphEvent>(
    graph,
    cur.link ?? calendarStart(cfg, cur.start, cur.end),
    cfg.maxPages,
    prefer,
  );
  let expired = false;
  if (round.expired) {
    expired = true;
    cur = fresh();
    round = await followDelta<GraphEvent>(
      graph,
      calendarStart(cfg, cur.start, cur.end),
      cfg.maxPages,
      prefer,
    );
  }
  const records: MsRecord[] = round.items
    .filter((e) => !e['@removed'])
    .map((event) => ({ source: 'calendar', event, owner }));
  return {
    records,
    cursor: encodeCursor({ ...cur, link: round.link }),
    ...(round.complete ? {} : { hasMore: true }),
    ...(expired ? { fullResyncRequired: true } : {}),
  };
}

const isDeltaLink = (link: string | null) => !!link && /[?&]\$?deltatoken=/i.test(link);

async function calendarBackfill(
  { cfg, graph, ctx }: SyncDeps,
  days: number,
  pageToken?: string,
): Promise<BackfillPage<MsRecord>> {
  const now = nowOf(cfg);
  const q = qs({
    startDateTime: iso(now - Math.max(1, days) * 86_400_000),
    endDateTime: iso(now + cfg.calendarDaysAhead * 86_400_000),
    $top: String(cfg.pageSize),
    $orderby: 'start/dateTime',
  });
  const res = await graph.request<GraphCollection<GraphEvent>>(
    pageToken ?? `${cfg.graphBaseUrl}/me/calendarView?${q}`,
    { prefer: CAL_PREFER },
  );
  const owner = ownerOf(ctx);
  return {
    records: (res.value ?? []).map((event) => ({ source: 'calendar', event, owner })),
    nextPageToken: res['@odata.nextLink'] ?? null,
  };
}

// --------------------------------------------------------------------------------- teams

function chatsFirstPage(cfg: MicrosoftConfig, top: number) {
  const q = qs({
    $expand: 'lastMessagePreview',
    $orderby: 'lastMessagePreview/createdDateTime desc',
    $top: String(top),
  });
  return `${cfg.graphBaseUrl}/me/chats?${q}`;
}

async function chatMessagesSince(
  cfg: MicrosoftConfig,
  graph: Graph,
  chatId: string,
  sinceMs: number,
  untilMs: number,
): Promise<GraphChatMessage[]> {
  const q = qs({
    $top: String(Math.min(50, cfg.pageSize)),
    $orderby: 'lastModifiedDateTime desc',
    $filter: `lastModifiedDateTime gt ${iso(sinceMs)} and lastModifiedDateTime lt ${iso(untilMs)}`,
  });
  let link: string | undefined =
    `${cfg.graphBaseUrl}/chats/${encodeURIComponent(chatId)}/messages?${q}`;
  const out: GraphChatMessage[] = [];
  for (let page = 0; link && page < CHAT_MESSAGE_PAGES; page++) {
    const res: GraphCollection<GraphChatMessage> = await graph.request(link);
    out.push(...(res.value ?? []));
    link = res['@odata.nextLink'];
  }
  return out;
}

const chatRef = (c: GraphChat) => ({
  id: c.id,
  topic: c.topic ?? null,
  chatType: c.chatType ?? null,
  webUrl: c.webUrl ?? null,
});

/** One page of chats changed after `sinceMs`, with their new messages. */
async function chatsPage(
  { cfg, graph, ctx }: SyncDeps,
  link: string,
  sinceMs: number,
  untilMs: number,
) {
  const owner = ownerOf(ctx);
  const res = await graph.request<GraphCollection<GraphChat>>(link);
  const records: MsRecord[] = [];
  let reachedOld = false;
  for (const chat of res.value ?? []) {
    const last = Date.parse(
      chat.lastMessagePreview?.createdDateTime ?? chat.lastUpdatedDateTime ?? '',
    );
    if (Number.isFinite(last) && last <= sinceMs) {
      reachedOld = true;
      break;
    }
    const messages = await chatMessagesSince(cfg, graph, chat.id, sinceMs, untilMs);
    for (const message of messages) {
      records.push({ source: 'teams', chat: chatRef(chat), message, owner });
    }
  }
  const next = reachedOld ? undefined : res['@odata.nextLink'];
  return { records, next };
}

async function teamsDelta(deps: SyncDeps): Promise<DeltaResult<MsRecord>> {
  const { cfg, ctx } = deps;
  const now = nowOf(cfg);
  // Graph chat APIs don't exist for personal Microsoft accounts.
  if (isPersonal(ctx))
    return { records: [], cursor: ctx.cursor ?? encodeCursor({ v: 1, since: iso(now) }) };
  const cur = parseCursor<TeamsCursor>(ctx.cursor);
  const since = cur?.since ?? iso(now - FIRST_ROUND_LOOKBACK_MS);
  const sinceMs = Date.parse(since) - OVERLAP_MS;
  const untilIso = cur?.until ?? iso(now);
  const untilMs = Date.parse(untilIso);
  let link: string | undefined = cur?.next ?? chatsFirstPage(cfg, 20);
  const records: MsRecord[] = [];
  for (let page = 0; link && page < cfg.maxPages; page++) {
    const r = await chatsPage(deps, link, sinceMs, untilMs);
    records.push(...r.records);
    link = r.next;
  }
  const next: TeamsCursor = link
    ? { v: 1, since, until: untilIso, next: link }
    : { v: 1, since: untilIso };
  return { records, cursor: encodeCursor(next), ...(link ? { hasMore: true } : {}) };
}

async function teamsBackfill(
  deps: SyncDeps,
  days: number,
  pageToken?: string,
): Promise<BackfillPage<MsRecord>> {
  if (isPersonal(deps.ctx)) return { records: [], nextPageToken: null };
  const now = nowOf(deps.cfg);
  const tok = pageToken
    ? (JSON.parse(pageToken) as { next: string; since: number; until: number })
    : {
        next: chatsFirstPage(deps.cfg, 20),
        since: now - Math.max(1, days) * 86_400_000,
        until: now,
      };
  const r = await chatsPage(deps, tok.next, tok.since, tok.until);
  return {
    records: r.records,
    nextPageToken: r.next ? JSON.stringify({ ...tok, next: r.next }) : null,
  };
}

// ------------------------------------------------------------------------------ channels

type ChannelRef = { teamId: string; channelId: string; name: string | null; webUrl: string | null };

async function listChannels(cfg: MicrosoftConfig, graph: Graph): Promise<ChannelRef[]> {
  const teams = await graph.request<GraphCollection<{ id: string }>>(
    `${cfg.graphBaseUrl}/me/joinedTeams?$select=id`,
  );
  const out: ChannelRef[] = [];
  for (const t of teams.value ?? []) {
    const chans = await graph.request<
      GraphCollection<{ id: string; displayName?: string; webUrl?: string }>
    >(
      `${cfg.graphBaseUrl}/teams/${encodeURIComponent(t.id)}/channels?$select=id,displayName,webUrl`,
    );
    for (const c of chans.value ?? []) {
      out.push({
        teamId: t.id,
        channelId: c.id,
        name: c.displayName ?? null,
        webUrl: c.webUrl ?? null,
      });
    }
  }
  return out.sort((a, b) =>
    `${a.teamId}/${a.channelId}`.localeCompare(`${b.teamId}/${b.channelId}`),
  );
}

async function channelsDelta({ cfg, graph, ctx }: SyncDeps): Promise<DeltaResult<MsRecord>> {
  const now = nowOf(cfg);
  if (isPersonal(ctx)) return { records: [], cursor: ctx.cursor };
  const cur = parseCursor<ChannelsCursor>(ctx.cursor);
  if (!cur)
    return { records: [], cursor: encodeCursor({ v: 1, since: iso(now) } as ChannelsCursor) };
  const untilIso = cur.until ?? iso(now);
  const sinceMs = Date.parse(cur.since) - OVERLAP_MS;
  const channels = await listChannels(cfg, graph);
  const start = cur.offset ?? 0;
  const batch = channels.slice(start, start + CHANNELS_PER_CALL);
  const owner = ownerOf(ctx);
  const records: MsRecord[] = [];
  for (const ch of batch) {
    const q = qs({
      $filter: `lastModifiedDateTime gt ${iso(sinceMs)}`,
      $top: String(Math.min(50, cfg.pageSize)),
    });
    const link = `${cfg.graphBaseUrl}/teams/${encodeURIComponent(ch.teamId)}/channels/${encodeURIComponent(ch.channelId)}/messages/delta?${q}`;
    // A filtered delta round used as a time-range query; its delta link is not kept.
    const round = await followDelta<GraphChatMessage>(graph, link, CHAT_MESSAGE_PAGES);
    for (const message of round.items) {
      if (Date.parse(message.lastModifiedDateTime ?? '') >= Date.parse(untilIso)) continue;
      records.push({
        source: 'channels',
        chat: {
          id: ch.channelId,
          topic: ch.name,
          chatType: 'channel',
          webUrl: ch.webUrl,
          teamId: ch.teamId,
          channelId: ch.channelId,
        },
        message,
        owner,
      });
    }
  }
  const nextOffset = start + batch.length;
  const more = nextOffset < channels.length;
  const next: ChannelsCursor = more
    ? { v: 1, since: cur.since, until: untilIso, offset: nextOffset }
    : { v: 1, since: untilIso };
  return { records, cursor: encodeCursor(next), ...(more ? { hasMore: true } : {}) };
}

// ------------------------------------------------------------------------------ onedrive

function driveStart(cfg: MicrosoftConfig, latest: boolean) {
  const q = qs({ $select: DRIVE_SELECT, ...(latest ? { token: 'latest' } : {}) });
  return `${cfg.graphBaseUrl}/me/drive/root/delta?${q}`;
}

async function driveDelta({ cfg, graph, ctx }: SyncDeps): Promise<DeltaResult<MsRecord>> {
  const owner = ownerOf(ctx);
  const cur = parseCursor<DriveCursor>(ctx.cursor);
  let round = await followDelta<GraphDriveItem>(
    graph,
    cur?.link ?? driveStart(cfg, true),
    cfg.maxPages,
  );
  let expired = false;
  if (round.expired) {
    expired = true;
    round = await followDelta<GraphDriveItem>(graph, driveStart(cfg, true), cfg.maxPages);
  }
  const records: MsRecord[] = round.items
    .filter((item) => !item.deleted && !item.folder && !item.root)
    .map((item) => ({ source: 'onedrive', item, owner }));
  return {
    records,
    cursor: encodeCursor({ v: 1, link: round.link } as DriveCursor),
    ...(round.complete ? {} : { hasMore: true }),
    ...(expired ? { fullResyncRequired: true } : {}),
  };
}

/** Walks a full delta enumeration and keeps files modified in the window (no ordered API). */
const DRIVE_BACKFILL_MAX_PAGES = 40;

async function driveBackfill(
  { cfg, graph, ctx }: SyncDeps,
  days: number,
  pageToken?: string,
): Promise<BackfillPage<MsRecord>> {
  const tok = pageToken ? (JSON.parse(pageToken) as { next: string; n: number }) : null;
  const res = await graph.request<GraphCollection<GraphDriveItem>>(
    tok?.next ?? driveStart(cfg, false),
  );
  const since = nowOf(cfg) - Math.max(1, days) * 86_400_000;
  const owner = ownerOf(ctx);
  const records: MsRecord[] = (res.value ?? [])
    .filter((i) => !i.deleted && !i.folder && !i.root && i.file)
    .filter((i) => Date.parse(i.lastModifiedDateTime ?? '') >= since)
    .map((item) => ({ source: 'onedrive', item, owner }));
  const n = (tok?.n ?? 0) + 1;
  const next = res['@odata.nextLink'];
  return {
    records,
    nextPageToken: next && n < DRIVE_BACKFILL_MAX_PAGES ? JSON.stringify({ next, n }) : null,
  };
}

// -------------------------------------------------------------------------------- router

export async function fetchDeltaFor(source: string, deps: SyncDeps) {
  switch (source) {
    case 'mail':
      return mailDelta(deps);
    case 'calendar':
      return calendarDelta(deps);
    case 'teams':
      return teamsDelta(deps);
    case 'channels':
      return channelsDelta(deps);
    case 'onedrive':
      return driveDelta(deps);
    default:
      return { records: [], cursor: deps.ctx.cursor };
  }
}

export async function backfillFor(
  source: string,
  deps: SyncDeps,
  days: number,
  pageToken?: string,
): Promise<BackfillPage<MsRecord>> {
  switch (source) {
    case 'mail':
      return mailBackfill(deps, days, pageToken);
    case 'calendar':
      return calendarBackfill(deps, days, pageToken);
    case 'teams':
      return teamsBackfill(deps, days, pageToken);
    case 'onedrive':
      return driveBackfill(deps, days, pageToken);
    default:
      // channels: history comes from the first polls; no separate backfill.
      return { records: [], nextPageToken: null };
  }
}
