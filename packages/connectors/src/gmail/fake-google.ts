import type { CalendarEvent, CalendarEventList } from './calendar';
import { CHAT_SUBSCRIPTION_TTL, tsKey, type ChatMessage } from './chat';
import type { DriveChange, DriveFile } from './drive';
import { FakeHttpError, fakeAuthGuard, type FakeClientOptions } from './fake';
import { fakeGoogleId, type FakeChannel, type FakeGoogle } from './fake-google-store';
import type { FakeGmailStore, FakeMailbox } from './fake-store';
import { fixture } from './fixtures/index';
import { cleanParams, type GoogleRequest, type GoogleRestFactory } from './rest';

/**
 * Calendar, Drive, Chat and Workspace Events served from the fake store, in the same
 * response shapes as the recorded fixtures. Used in fake mode and by the fake-mode tests.
 */

type Params = Record<string, string>;
type Ctx = { mb: FakeMailbox; g: FakeGoogle; p: Params; data: unknown; now: number };

const notFound = () =>
  new FakeHttpError(404, { error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } });
const badRequest = () =>
  new FakeHttpError(400, {
    error: { code: 400, message: 'Bad Request', status: 'INVALID_ARGUMENT' },
  });

/** Offset pagination: `pageToken` is the start index. */
function paginate<T>(all: T[], p: Params, def: number, max: number) {
  const size = Math.min(Math.max(1, Number(p.maxResults ?? p.pageSize) || def), max);
  const start = Number(p.pageToken) || 0;
  const items = all.slice(start, start + size);
  const next = start + size < all.length ? String(start + size) : undefined;
  return { items, next };
}

// ---- Calendar ----

const CAL_TOKEN = /^fake-cal-(\d+)$/;

function calendarList({ mb, g, p }: Ctx): CalendarEventList {
  let entries = g.calendar.events;
  if (p.syncToken !== undefined) {
    const m = CAL_TOKEN.exec(p.syncToken);
    const seq = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(seq) || seq < g.calendar.minSeq) {
      throw new FakeHttpError(410, fixture('calendar-410.json'));
    }
    entries = entries.filter((e) => e.seq > seq);
  } else {
    const timeMin = p.timeMin ? Date.parse(p.timeMin) : null;
    const updatedMin = p.updatedMin ? Date.parse(p.updatedMin) : null;
    entries = entries.filter(({ event: e }) => {
      if (p.showDeleted === 'false' && e.status === 'cancelled') return false;
      if (updatedMin !== null && Date.parse(e.updated ?? '') < updatedMin) return false;
      if (timeMin !== null) {
        const end = Date.parse(e.end?.dateTime ?? e.end?.date ?? '');
        if (Number.isFinite(end) && end < timeMin) return false;
      }
      return true;
    });
  }
  const { items, next } = paginate(entries, p, 250, 2500);
  const tail = next ? { nextPageToken: next } : { nextSyncToken: `fake-cal-${g.calendar.seq}` };
  if (p.fields === 'nextPageToken,nextSyncToken') return tail;
  return {
    kind: 'calendar#events',
    etag: `"${g.calendar.seq}"`,
    summary: mb.email,
    updated: new Date().toISOString(),
    timeZone: 'UTC',
    items: items.map((e) => e.event as CalendarEvent),
    ...tail,
  };
}

// ---- Channels (Calendar + Drive watch) ----

function watch(source: FakeChannel['source'], { g, data, now }: Ctx) {
  const d = (data ?? {}) as {
    id?: string;
    type?: string;
    address?: string;
    token?: string;
    expiration?: string;
  };
  if (!d.id || d.type !== 'web_hook' || !d.address) throw badRequest();
  const expiration = Math.min(Number(d.expiration) || now + 3600_000, now + 7 * 86400_000);
  const ch: FakeChannel = {
    id: d.id,
    resourceId: fakeGoogleId(10),
    source,
    token: d.token ?? '',
    address: d.address,
    expiration,
  };
  g.channels = g.channels.filter((c) => c.id !== ch.id);
  g.channels.push(ch);
  return {
    kind: 'api#channel',
    id: ch.id,
    resourceId: ch.resourceId,
    resourceUri:
      source === 'calendar'
        ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json'
        : 'https://www.googleapis.com/drive/v3/changes?alt=json',
    ...(d.token ? { token: d.token } : {}),
    expiration: String(expiration),
  };
}

function stop({ g, data }: Ctx) {
  const d = (data ?? {}) as { id?: string; resourceId?: string };
  const i = g.channels.findIndex((c) => c.id === d.id && c.resourceId === d.resourceId);
  if (i < 0) throw notFound();
  g.channels.splice(i, 1);
  return '';
}

// ---- Drive ----

function driveChanges({ g, p }: Ctx) {
  const token = Number(p.pageToken);
  if (!Number.isInteger(token) || token <= g.drive.minSeq || token > g.drive.seq + 1) {
    throw new FakeHttpError(404, fixture('drive-404.json'));
  }
  const pending = g.drive.changes.filter((c) => c.seq >= token);
  const size = Math.min(Math.max(1, Number(p.pageSize) || 100), 1000);
  const page = pending.slice(0, size);
  const rest = pending[size];
  return {
    kind: 'drive#changeList',
    ...(rest
      ? { nextPageToken: String(rest.seq) }
      : { newStartPageToken: String(g.drive.seq + 1) }),
    changes: page.map((c) => c.change as DriveChange),
  };
}

function driveFiles({ g, p }: Ctx) {
  const since = /modifiedTime > '([^']+)'/.exec(p.q ?? '')?.[1];
  const latest = new Map<string, DriveFile>();
  for (const { change } of g.drive.changes)
    if (change.file) latest.set(change.file.id, change.file);
  const files = [...latest.values()]
    .filter((f) => !f.trashed)
    .filter((f) => !since || Date.parse(f.modifiedTime ?? '') > Date.parse(since))
    .sort((a, b) => Date.parse(b.modifiedTime ?? '') - Date.parse(a.modifiedTime ?? ''));
  const { items, next } = paginate(files, p, 100, 1000);
  return {
    kind: 'drive#fileList',
    incompleteSearch: false,
    ...(next ? { nextPageToken: next } : {}),
    files: items,
  };
}

// ---- Chat ----

function requireWorkspace(g: FakeGoogle) {
  if (!g.workspace) throw new FakeHttpError(403, fixture('chat-403.json'));
}

function chatSpaces({ g, p }: Ctx) {
  requireWorkspace(g);
  const { items, next } = paginate(g.chat.spaces, p, 100, 1000);
  return { spaces: items, ...(next ? { nextPageToken: next } : {}) };
}

function chatMessages(space: string, { g, p }: Ctx) {
  requireWorkspace(g);
  if (!g.chat.spaces.some((s) => s.name === space)) {
    throw new FakeHttpError(404, fixture('chat-404.json'));
  }
  const after = /createTime > "([^"]+)"/.exec(p.filter ?? '')?.[1];
  const before = /createTime < "([^"]+)"/.exec(p.filter ?? '')?.[1];
  const msgs = g.chat.messages
    .filter((m: ChatMessage) => (m.space?.name ?? '') === space)
    .filter((m) => !after || tsKey(m.createTime) > tsKey(after))
    .filter((m) => !before || tsKey(m.createTime) < tsKey(before))
    .sort((a, b) => (tsKey(a.createTime) < tsKey(b.createTime) ? -1 : 1));
  const { items, next } = paginate(msgs, p, 25, 1000);
  return items.length || next ? { messages: items, ...(next ? { nextPageToken: next } : {}) } : {};
}

// ---- Workspace Events ----

const SUB_TYPE = 'type.googleapis.com/google.apps.events.subscriptions.v1.Subscription';
const ttlMs = (ttl: unknown) => (Number(String(ttl ?? '').replace(/s$/, '')) || 604800) * 1000;

function publicSub(s: FakeGoogle['eventSubscriptions'][number]) {
  const { topic: _topic, ...rest } = s;
  return rest;
}
const op = (s: FakeGoogle['eventSubscriptions'][number]) => ({
  done: true,
  response: { '@type': SUB_TYPE, ...publicSub(s) },
});

function createSubscription({ g, data, now }: Ctx) {
  requireWorkspace(g);
  const d = (data ?? {}) as {
    targetResource?: string;
    eventTypes?: string[];
    notificationEndpoint?: { pubsubTopic?: string };
    payloadOptions?: Record<string, unknown>;
    ttl?: string;
  };
  const topic = d.notificationEndpoint?.pubsubTopic;
  if (!d.targetResource || !d.eventTypes?.length || !topic) throw badRequest();
  if (
    g.eventSubscriptions.some((s) => s.targetResource === d.targetResource && s.topic === topic)
  ) {
    throw new FakeHttpError(409, fixture('events-409.json'));
  }
  const stamp = new Date(now).toISOString();
  const sub = {
    name: `subscriptions/chat-spaces-${fakeGoogleId(8)}`,
    uid: fakeGoogleId(16),
    targetResource: d.targetResource,
    eventTypes: d.eventTypes,
    payloadOptions: d.payloadOptions ?? {},
    notificationEndpoint: { pubsubTopic: topic },
    state: 'ACTIVE',
    authority: `users/${g.googleUserId}`,
    createTime: stamp,
    updateTime: stamp,
    expireTime: new Date(now + ttlMs(d.ttl ?? CHAT_SUBSCRIPTION_TTL)).toISOString(),
    topic,
  };
  g.eventSubscriptions.push(sub);
  return op(sub);
}

function findSub(g: FakeGoogle, name: string) {
  const s = g.eventSubscriptions.find((x) => x.name === name);
  if (!s) throw notFound();
  return s;
}

type Handler = (c: Ctx, m: RegExpExecArray) => unknown;

const ROUTES: [string, RegExp, Handler][] = [
  ['GET', /^www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events$/, calendarList],
  [
    'POST',
    /^www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/watch$/,
    (c) => watch('calendar', c),
  ],
  ['POST', /^www\.googleapis\.com\/(calendar\/v3|drive\/v3)\/channels\/stop$/, stop],
  [
    'GET',
    /^www\.googleapis\.com\/drive\/v3\/changes\/startPageToken$/,
    ({ g }) => ({
      kind: 'drive#startPageToken',
      startPageToken: String(g.drive.seq + 1),
    }),
  ],
  ['GET', /^www\.googleapis\.com\/drive\/v3\/changes$/, driveChanges],
  [
    'POST',
    /^www\.googleapis\.com\/drive\/v3\/changes\/watch$/,
    (c) => {
      driveChanges(c); // validates the page token like Drive does
      return watch('drive', c);
    },
  ],
  ['GET', /^www\.googleapis\.com\/drive\/v3\/files$/, driveFiles],
  ['GET', /^chat\.googleapis\.com\/v1\/spaces$/, chatSpaces],
  [
    'GET',
    /^chat\.googleapis\.com\/v1\/(spaces\/[^/]+)\/messages$/,
    (c, m) => chatMessages(m[1]!, c),
  ],
  ['POST', /^workspaceevents\.googleapis\.com\/v1\/subscriptions$/, createSubscription],
  [
    'GET',
    /^workspaceevents\.googleapis\.com\/v1\/subscriptions$/,
    ({ g }) => ({
      subscriptions: g.eventSubscriptions.map(publicSub),
    }),
  ],
  [
    'PATCH',
    /^workspaceevents\.googleapis\.com\/v1\/(subscriptions\/[^/:]+)$/,
    (c, m) => {
      const s = findSub(c.g, m[1]!);
      const d = (c.data ?? {}) as { ttl?: string };
      s.expireTime = new Date(c.now + ttlMs(d.ttl)).toISOString();
      s.updateTime = new Date(c.now).toISOString();
      return op(s);
    },
  ],
  [
    'POST',
    /^workspaceevents\.googleapis\.com\/v1\/(subscriptions\/[^/:]+):reactivate$/,
    (c, m) => {
      const s = findSub(c.g, m[1]!);
      s.state = 'ACTIVE';
      return op(s);
    },
  ],
  [
    'DELETE',
    /^workspaceevents\.googleapis\.com\/v1\/(subscriptions\/[^/:]+)$/,
    (c, m) => {
      findSub(c.g, m[1]!);
      c.g.eventSubscriptions = c.g.eventSubscriptions.filter((s) => s.name !== m[1]);
      return { done: true, response: {} };
    },
  ],
];

/** A GoogleRest served from the fake store; enforces tokens like the fake Gmail client. */
export function fakeRestFactory(
  store: FakeGmailStore,
  opts: FakeClientOptions = {},
): GoogleRestFactory {
  const now = opts.now ?? Date.now;
  return ({ tokens, externalId, onTokens }) => {
    const auth = fakeAuthGuard(store, externalId, tokens, onTokens, now);
    return async <T>(req: GoogleRequest): Promise<T> => {
      const mb = auth();
      const u = new URL(req.url);
      const method = req.method ?? 'GET';
      const path = `${u.host}${u.pathname}`;
      const p = cleanParams(req.params);
      for (const [m, re, handler] of ROUTES) {
        const hit = m === method ? re.exec(path) : null;
        if (!hit) continue;
        // Mutating routes run under the store lock; reads see a consistent snapshot too.
        const out = store.updateGoogle(mb.email, (g, box) =>
          handler({ mb: box, g, p, data: req.data, now: now() }, hit),
        );
        return structuredClone(out) as T;
      }
      throw notFound();
    };
  };
}
