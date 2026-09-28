import { ConnectorError, RetryableError } from '../errors';
import type { BackfillPage, DeltaResult, NormalizedItem, VerifyResult } from '../types';
import { httpStatusOf } from './client';
import type { PubSubPush } from './pubsub';
import { GOOGLE_API, type GoogleRest } from './rest';
import { mapLimit, sleep as defaultSleep } from './util';

/**
 * Google Chat source (Google Workspace accounts only): messages in the spaces, group chats
 * and DMs the user is in. Delta = spaces.list, then spaces.messages.list with
 * `createTime > cursor` for the spaces active since the cursor. Push = a Workspace Events
 * API subscription on `//chat.googleapis.com/spaces/-` publishing to Pub/Sub, which pushes
 * to /hooks/gmail/events.
 *
 * Consumer (gmail.com) accounts have no Chat API: a 403/404 on first use marks the source
 * unavailable in its subscription meta instead of failing every sync.
 */

export type ChatUser = { name?: string; displayName?: string; type?: string; domainId?: string };
export type ChatSpace = {
  name: string;
  type?: string;
  spaceType?: 'SPACE' | 'GROUP_CHAT' | 'DIRECT_MESSAGE' | string;
  displayName?: string;
  singleUserBotDm?: boolean;
  spaceUri?: string;
  lastActiveTime?: string;
  createTime?: string;
};
export type ChatAnnotation = {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: { user?: ChatUser; type?: string };
};
export type ChatMessage = {
  name: string;
  sender?: ChatUser;
  createTime?: string;
  lastUpdateTime?: string;
  deleteTime?: string;
  text?: string;
  formattedText?: string;
  argumentText?: string;
  thread?: { name?: string; threadKey?: string };
  space?: { name?: string };
  annotations?: ChatAnnotation[];
  threadReply?: boolean;
  attachment?: unknown[];
  [k: string]: unknown;
};

export type ChatRecord = {
  chatMessage: ChatMessage;
  space: ChatSpace | null;
  /** Google account id of the owner (`sub`), so normalize can tell their own messages. */
  selfUserId: string | null;
};

export const CHAT_TARGET = '//chat.googleapis.com/spaces/-';
export const CHAT_EVENT_TYPES = ['google.workspace.chat.message.v1.created'];
/** Without resource data, Chat subscriptions may live up to 7 days. */
export const CHAT_SUBSCRIPTION_TTL = '604800s';
export const LIFECYCLE_PREFIX = 'google.workspace.events.subscription.v1.';
const SUBSCRIPTION_SOURCE_PREFIX = '//workspaceevents.googleapis.com/';
const MAX_BODY_CHARS = 20_000;
const MAX_PAGES = 10;

/** 403 (not a Workspace account, Chat off for the user) or 404 (no Chat API): not an outage. */
export const chatUnavailable = (e: unknown) => {
  const s = httpStatusOf(e);
  return s === 403 || s === 404;
};

/** Sortable key for RFC 3339 timestamps with 0–9 fractional digits (Chat uses micros). */
export function tsKey(s: string | undefined): string {
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(s);
  if (m) return `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}`;
  const v = Date.parse(s);
  return Number.isFinite(v) ? tsKey(new Date(v).toISOString()) : '';
}

async function listSpaces(rest: GoogleRest): Promise<ChatSpace[]> {
  const out: ChatSpace[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await rest<{ spaces?: ChatSpace[]; nextPageToken?: string }>({
      url: `${GOOGLE_API.chat}/spaces`,
      params: { pageSize: 1000, pageToken },
    });
    out.push(...(res.spaces ?? []));
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

async function listMessages(
  rest: GoogleRest,
  space: ChatSpace,
  filter: string,
  pageToken?: string,
  pageSize = 1000,
) {
  return rest<{ messages?: ChatMessage[]; nextPageToken?: string }>({
    url: `${GOOGLE_API.chat}/${space.name}/messages`,
    params: { filter, pageSize, orderBy: 'createTime ASC', pageToken },
  });
}

/**
 * Cheap "is Chat usable for this account" check (one space). Returns null when it is,
 * else why not: `not_workspace` (403, consumer account or Chat off for the user) or
 * `chat_app_not_configured` (404: the Cloud project has no Chat app configured, an
 * operator fix; the reason is kept apart so it isn't mistaken for a consumer account).
 */
export async function chatProbe(
  rest: GoogleRest,
): Promise<null | 'not_workspace' | 'chat_app_not_configured'> {
  try {
    await rest({ url: `${GOOGLE_API.chat}/spaces`, params: { pageSize: 1 } });
    return null;
  } catch (e) {
    if (!chatUnavailable(e)) throw e;
    return httpStatusOf(e) === 404 ? 'chat_app_not_configured' : 'not_workspace';
  }
}

export async function chatDelta(
  rest: GoogleRest,
  opts: { cursor: string | null; selfUserId: string | null },
  now = Date.now(),
): Promise<DeltaResult<ChatRecord>> {
  if (!opts.cursor) return { records: [], cursor: new Date(now).toISOString() };
  const cursor = opts.cursor;
  let spaces: ChatSpace[];
  try {
    spaces = await listSpaces(rest);
  } catch (e) {
    if (chatUnavailable(e)) return { records: [], cursor };
    throw e;
  }
  const since = tsKey(cursor);
  const active = spaces.filter((s) => !s.lastActiveTime || tsKey(s.lastActiveTime) > since);
  const perSpace = await mapLimit(active, 3, async (space) => {
    const got: ChatMessage[] = [];
    let pageToken: string | undefined;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const res = await listMessages(rest, space, `createTime > "${cursor}"`, pageToken);
        got.push(...(res.messages ?? []));
        if (!res.nextPageToken) break;
        pageToken = res.nextPageToken;
      }
    } catch (e) {
      // Left the space between the two calls.
      if (chatUnavailable(e)) return [];
      throw e;
    }
    return got.map((chatMessage) => ({ chatMessage, space, selfUserId: opts.selfUserId }));
  });
  const records = perSpace
    .flat()
    .sort((a, b) => (tsKey(a.chatMessage.createTime) < tsKey(b.chatMessage.createTime) ? -1 : 1));
  let next = cursor;
  for (const r of records) {
    if (tsKey(r.chatMessage.createTime) > tsKey(next)) next = r.chatMessage.createTime!;
  }
  return { records, cursor: next };
}

/**
 * Backfill walks the spaces active in the window one messages page at a time.
 * pageToken = `<space index>:<messages page token>`.
 */
export async function chatBackfill(
  rest: GoogleRest,
  opts: { days: number; pageToken?: string; selfUserId: string | null; pageSize?: number },
  now = Date.now(),
): Promise<BackfillPage<ChatRecord>> {
  const since = new Date(now - Math.max(1, opts.days) * 86400_000).toISOString();
  let spaces: ChatSpace[];
  try {
    spaces = await listSpaces(rest);
  } catch (e) {
    if (chatUnavailable(e)) return { records: [], nextPageToken: null };
    throw e;
  }
  const active = spaces
    .filter((s) => !s.lastActiveTime || tsKey(s.lastActiveTime) > tsKey(since))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const [iRaw, ...tail] = (opts.pageToken ?? '0:').split(':');
  const i = Number(iRaw) || 0;
  const token = tail.join(':') || undefined;
  const space = active[i];
  if (!space) return { records: [], nextPageToken: null };
  let res: { messages?: ChatMessage[]; nextPageToken?: string };
  try {
    res = await listMessages(rest, space, `createTime > "${since}"`, token, opts.pageSize ?? 200);
  } catch (e) {
    if (!chatUnavailable(e)) throw e;
    res = {};
  }
  const records = (res.messages ?? []).map((chatMessage) => ({
    chatMessage,
    space,
    selfUserId: opts.selfUserId,
  }));
  const nextPageToken = res.nextPageToken
    ? `${i}:${res.nextPageToken}`
    : i + 1 < active.length
      ? `${i + 1}:`
      : null;
  return { records, nextPageToken };
}

function spaceTitle(space: ChatSpace | null): string | null {
  if (!space) return null;
  if (space.displayName) return space.displayName;
  if (space.spaceType === 'DIRECT_MESSAGE') return 'Direct message';
  if (space.spaceType === 'GROUP_CHAT') return 'Group chat';
  return null;
}

function spaceUrl(space: ChatSpace | null, spaceName: string): string {
  if (space?.spaceUri) return space.spaceUri;
  const id = spaceName.replace(/^spaces\//, '');
  return space?.spaceType === 'DIRECT_MESSAGE'
    ? `https://chat.google.com/dm/${encodeURIComponent(id)}`
    : `https://chat.google.com/room/${encodeURIComponent(id)}`;
}

/** Maps a spaces.messages resource to a NormalizedItem (kind `chat`). */
export function normalizeChat(rec: ChatRecord): NormalizedItem | null {
  const m = rec.chatMessage;
  if (!m?.name || m.deleteTime) return null;
  const spaceName = m.space?.name ?? rec.space?.name ?? m.name.split('/messages/')[0]!;
  const threadName = m.thread?.name ?? null;
  const text = (m.text ?? m.argumentText ?? '').trim();
  const senderId = m.sender?.name ?? null;
  const fromMe = !!senderId && !!rec.selfUserId && senderId === `users/${rec.selfUserId}`;
  const labels = [`gchat:space:${spaceName}`];
  if (threadName) labels.push(`gchat:thread:${threadName}`);
  if (rec.space?.spaceType) labels.push(`gchat:type:${rec.space.spaceType}`);
  if (m.sender?.type === 'BOT') labels.push('gchat:sender:bot');
  if (m.threadReply) labels.push('gchat:reply:true');
  // Trusted signals, from API metadata (annotations, space type), never from the text.
  const self = rec.selfUserId ? `users/${rec.selfUserId}` : null;
  const mentioned =
    !!self &&
    !fromMe &&
    (m.annotations ?? []).some(
      (a) =>
        a.type === 'USER_MENTION' &&
        a.userMention?.user?.name === self &&
        (a.userMention.type ?? 'MENTION') === 'MENTION',
    );
  if (mentioned) labels.push('hub:mention');
  if (rec.space?.spaceType === 'DIRECT_MESSAGE') labels.push('hub:dm');
  if (fromMe) labels.push('hub:from_me');
  const at = Date.parse(m.createTime ?? '');
  return {
    kind: 'chat',
    externalId: m.name,
    threadId: threadName ?? m.name,
    // With user auth the Chat API returns the sender id but not their display name.
    author: m.sender?.displayName ?? (fromMe ? 'You' : senderId),
    authorAddress: senderId,
    title: spaceTitle(rec.space),
    summary: text ? text.replace(/\s+/g, ' ').slice(0, 140) : null,
    body: text ? text.slice(0, MAX_BODY_CHARS) : null,
    url: spaceUrl(rec.space, spaceName),
    labels,
    receivedAt: new Date(Number.isFinite(at) ? at : 0),
    fromMe,
  };
}

// ---- Workspace Events API subscription ----

export type WorkspaceSubscription = {
  name: string;
  uid?: string;
  targetResource?: string;
  eventTypes?: string[];
  notificationEndpoint?: { pubsubTopic?: string };
  state?: 'ACTIVE' | 'SUSPENDED' | 'DELETED' | string;
  suspensionReason?: string;
  expireTime?: string;
  createTime?: string;
  updateTime?: string;
  authority?: string;
  ttl?: string;
};

type Operation<T> = {
  name?: string;
  done?: boolean;
  response?: T;
  error?: { code?: number; message?: string };
};

type SleepFn = (ms: number) => Promise<void>;

async function settle(
  rest: GoogleRest,
  op: Operation<WorkspaceSubscription>,
  sleep: SleepFn,
): Promise<WorkspaceSubscription> {
  let cur = op;
  for (let i = 0; i < 5; i++) {
    if (cur.done) {
      if (cur.error || !cur.response?.name) {
        throw new ConnectorError(
          'gmail',
          `workspace events operation failed (${cur.error?.code ?? 'no subscription'})`,
        );
      }
      return cur.response;
    }
    if (!cur.name) break;
    await sleep(300 * (i + 1));
    cur = await rest<Operation<WorkspaceSubscription>>({ url: `${GOOGLE_API.events}/${cur.name}` });
  }
  throw new RetryableError('gmail', 'workspace events operation still running');
}

async function findExisting(rest: GoogleRest, topic: string) {
  const res = await rest<{ subscriptions?: WorkspaceSubscription[] }>({
    url: `${GOOGLE_API.events}/subscriptions`,
    params: {
      filter: `event_types:"${CHAT_EVENT_TYPES[0]}" AND target_resource="${CHAT_TARGET}"`,
    },
  });
  const subs = res.subscriptions ?? [];
  return subs.find((s) => s.notificationEndpoint?.pubsubTopic === topic) ?? subs[0] ?? null;
}

async function extend(rest: GoogleRest, name: string, sleep: SleepFn) {
  const op = await rest<Operation<WorkspaceSubscription>>({
    method: 'PATCH',
    url: `${GOOGLE_API.events}/${name}`,
    params: { updateMask: 'ttl' },
    data: { ttl: CHAT_SUBSCRIPTION_TTL },
  });
  let sub = await settle(rest, op, sleep);
  if (sub.state === 'SUSPENDED') {
    const r = await rest<Operation<WorkspaceSubscription>>({
      method: 'POST',
      url: `${GOOGLE_API.events}/${name}:reactivate`,
      data: {},
    });
    sub = await settle(rest, r, sleep);
  }
  return sub;
}

/** Creates the `spaces/-` subscription, or extends the one this user already has (409). */
export async function createChatSubscription(
  rest: GoogleRest,
  topic: string,
  sleep: SleepFn = defaultSleep,
): Promise<WorkspaceSubscription> {
  try {
    const op = await rest<Operation<WorkspaceSubscription>>({
      method: 'POST',
      url: `${GOOGLE_API.events}/subscriptions`,
      data: {
        targetResource: CHAT_TARGET,
        eventTypes: CHAT_EVENT_TYPES,
        notificationEndpoint: { pubsubTopic: topic },
        payloadOptions: { includeResource: false },
        ttl: CHAT_SUBSCRIPTION_TTL,
      },
    });
    return await settle(rest, op, sleep);
  } catch (e) {
    if (httpStatusOf(e) !== 409) throw e;
    const existing = await findExisting(rest, topic);
    if (!existing) throw e;
    return extend(rest, existing.name, sleep);
  }
}

/** Extends the TTL; recreates the subscription when Google already deleted it. */
export async function renewChatSubscription(
  rest: GoogleRest,
  name: string,
  topic: string,
  sleep: SleepFn = defaultSleep,
): Promise<WorkspaceSubscription> {
  try {
    return await extend(rest, name, sleep);
  } catch (e) {
    if (httpStatusOf(e) === 404) return createChatSubscription(rest, topic, sleep);
    throw e;
  }
}

export async function deleteChatSubscription(rest: GoogleRest, name: string): Promise<void> {
  try {
    await rest({ method: 'DELETE', url: `${GOOGLE_API.events}/${name}` });
  } catch (e) {
    if (httpStatusOf(e) !== 404) throw e;
  }
}

// ---- Push (Pub/Sub → /hooks/gmail/events) ----

/**
 * Turns a verified Pub/Sub push of a Workspace event (CloudEvent in the message
 * attributes) into a webhook event routed to the subscription (`ce-source`).
 * Lifecycle events (expirationReminder, suspended, expired) are passed on so the sync
 * worker can renew or recreate; the payload carries only ids and event types.
 */
export function chatEventsFromPush(env: PubSubPush): VerifyResult {
  const a = env.message.attributes ?? {};
  const type = a['ce-type'];
  const source = a['ce-source'];
  if (!type || !source?.startsWith(SUBSCRIPTION_SOURCE_PREFIX)) {
    return { ok: false, reason: 'bad event attributes' };
  }
  const externalSubId = source.slice(SUBSCRIPTION_SOURCE_PREFIX.length);
  if (!/^subscriptions\/[A-Za-z0-9_.~-]+$/.test(externalSubId)) {
    return { ok: false, reason: 'bad event attributes' };
  }
  const lifecycle = type.startsWith(LIFECYCLE_PREFIX) ? type.slice(LIFECYCLE_PREFIX.length) : null;
  if (!lifecycle && !type.startsWith('google.workspace.chat.message.v1.')) {
    return { ok: true, events: [] };
  }
  const messageId = (env.message.messageId ?? env.message.message_id)!;
  const subject = a['ce-subject'] ?? '';
  const space = /^\/\/chat\.googleapis\.com\/(spaces\/[A-Za-z0-9_-]+)$/.exec(subject)?.[1];
  return {
    ok: true,
    events: [
      {
        providerEventId: `wse:${messageId}`,
        externalSubId,
        source: 'chat',
        payload: {
          eventType: type,
          messageId,
          ...(lifecycle ? { lifecycle } : {}),
          ...(space ? { space } : {}),
          ...(a['ce-time'] ? { time: a['ce-time'] } : {}),
        },
      },
    ],
  };
}
