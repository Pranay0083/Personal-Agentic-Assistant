import type { AccountFilters } from '@hub/shared';
import type { NormalizedItem } from '../types';
import type {
  GraphChatMessage,
  GraphDateTimeTimeZone,
  GraphEvent,
  GraphItemBody,
  GraphMessage,
  MsOwner,
  MsRecord,
} from './graph-types';

const MAX_BODY_CHARS = 200_000;
const MAX_SUMMARY_CHARS = 300;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ent: string) => {
    const lower = ent.toLowerCase();
    if (NAMED[lower] !== undefined) return NAMED[lower]!;
    const n = lower.startsWith('#x')
      ? parseInt(lower.slice(2), 16)
      : lower.startsWith('#')
        ? parseInt(lower.slice(1), 10)
        : NaN;
    try {
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    } catch {
      return all;
    }
  });
}

/** Strips an HTML body (Outlook, Teams) to readable plain text. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clamp = (s: string, n = MAX_BODY_CHARS) => (s.length > n ? s.slice(0, n) : s);

/** Plain text of a Graph itemBody; HTML is stripped. Empty → null. */
export function bodyText(body: GraphItemBody | null | undefined): string | null {
  const content = body?.content;
  if (!content) return null;
  const text =
    (body.contentType ?? '').toLowerCase() === 'html'
      ? htmlToText(content)
      : content.replace(/\r\n/g, '\n').trim();
  return text ? clamp(text) : null;
}

const lower = (s: string | null | undefined) => (s ? s.trim().toLowerCase() : null);

function date(v: string | null | undefined): Date | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Graph dateTimeTimeZone → ISO instant. We request `outlook.timezone="UTC"`, so dateTime has
 * no offset and the zone is UTC; an explicit offset in the string is respected.
 */
export function eventInstant(v: GraphDateTimeTimeZone | null | undefined): string | null {
  if (!v?.dateTime) return null;
  const s = v.dateTime;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const utc = !v.timeZone || /^(utc|gmt|coordinated universal time)$/i.test(v.timeZone);
  const d = date(hasZone || !utc ? s : `${s}Z`);
  return d ? d.toISOString() : null;
}

function isOwner(owner: MsOwner, address: string | null) {
  return !!address && owner.addresses.map((a) => a.toLowerCase()).includes(address);
}

function normalizeMail(folder: 'inbox' | 'sent', m: GraphMessage, owner: MsOwner) {
  if (m['@removed'] || m.isDraft) return null;
  const from = m.from?.emailAddress ?? m.sender?.emailAddress ?? null;
  const authorAddress = lower(from?.address);
  const labels = [`outlook:id:${m.id}`, `outlook:folder:${folder}`];
  if (m.conversationId) labels.push(`outlook:conversation:${m.conversationId}`);
  // RFC 822 id for cross-referencing only; replies thread on `outlook:id:` (see send.ts).
  if (m.internetMessageId) labels.push(`outlook:msgid:${m.internetMessageId}`);
  if (m.inferenceClassification) labels.push(`outlook:inference:${m.inferenceClassification}`);
  for (const c of m.categories ?? []) labels.push(`outlook:category:${c}`);
  const preview = m.bodyPreview?.trim();
  return {
    kind: 'email',
    externalId: m.id,
    threadId: m.conversationId ?? null,
    author: from?.name?.trim() || authorAddress,
    authorAddress,
    title: m.subject?.trim() || null,
    summary: preview ? clamp(preview, MAX_SUMMARY_CHARS) : null,
    body: bodyText(m.body),
    url: m.webLink ?? null,
    labels,
    receivedAt: date(m.receivedDateTime) ?? date(m.sentDateTime) ?? new Date(0),
    fromMe: folder === 'sent' || isOwner(owner, authorAddress),
  } satisfies NormalizedItem;
}

function normalizeEvent(e: GraphEvent, owner: MsOwner) {
  if (e['@removed']) return null;
  const org = e.organizer?.emailAddress ?? null;
  const orgAddress = lower(org?.address);
  const start = eventInstant(e.start);
  const end = eventInstant(e.end);
  const labels = [`mscal:event:${e.id}`];
  if (start) labels.push(`mscal:start:${start}`);
  if (end) labels.push(`mscal:end:${end}`);
  if (e.isAllDay) labels.push('mscal:allday');
  if (e.isCancelled) labels.push('mscal:cancelled');
  if (e.seriesMasterId) labels.push(`mscal:series:${e.seriesMasterId}`);
  const response = e.responseStatus?.response ?? null;
  if (response) labels.push(`mscal:response:${response}`);
  // An invite someone else organized that the user hasn't answered.
  if (!e.isOrganizer && !e.isCancelled && (response === 'notResponded' || response === 'none')) {
    labels.push('hub:rsvp_needed');
  }
  const where = e.location?.displayName?.trim();
  const preview = e.bodyPreview?.trim();
  const summary = [where ? `@ ${where}` : null, preview || null].filter(Boolean).join(' · ');
  return {
    kind: 'event',
    externalId: e.id,
    threadId: e.seriesMasterId ?? e.iCalUId ?? null,
    author: org?.name?.trim() || orgAddress,
    authorAddress: orgAddress,
    title: e.subject?.trim() || null,
    summary: summary ? clamp(summary, MAX_SUMMARY_CHARS) : null,
    body: bodyText(e.body),
    url: e.webLink ?? null,
    labels,
    receivedAt:
      date(e.lastModifiedDateTime) ?? date(e.createdDateTime) ?? date(start) ?? new Date(0),
    fromMe: e.isOrganizer === true || isOwner(owner, orgAddress),
  } satisfies NormalizedItem;
}

function normalizeChat(r: Extract<MsRecord, { source: 'teams' | 'channels' }>) {
  const m: GraphChatMessage = r.message;
  // System events (member added, renamed...) and deleted messages are not content.
  if (m.deletedDateTime || (m.messageType && m.messageType !== 'message')) return null;
  const user = m.from?.user ?? null;
  const app = m.from?.application ?? null;
  const body = bodyText(m.body);
  const channel = r.source === 'channels';
  const labels = channel
    ? [
        `teams:team:${r.chat.teamId ?? ''}`,
        `teams:channel:${r.chat.channelId ?? r.chat.id}`,
        `teams:message:${m.id}`,
      ]
    : [`teams:chat:${r.chat.id}`, `teams:message:${m.id}`];
  if (!channel && r.chat.chatType) labels.push(`teams:chatType:${r.chat.chatType}`);
  if (!channel && r.chat.chatType === 'oneOnOne') labels.push('hub:dm');
  // Graph mention entities (not the text) say who was @-mentioned.
  if (
    (m.mentions ?? []).some((x) => !!x.mentioned?.user?.id && x.mentioned.user.id === r.owner.id)
  ) {
    labels.push('hub:mention');
  }
  if (m.replyToId) labels.push(`teams:replyTo:${m.replyToId}`);
  if (user?.id) labels.push(`teams:user:${user.id}`);
  const title =
    r.chat.topic?.trim() ||
    (m.subject?.trim() ?? null) ||
    (user?.displayName ? `Chat with ${user.displayName}` : null);
  return {
    kind: 'chat',
    // Message ids are only unique inside a chat/channel.
    externalId: `${r.chat.id}/${m.id}`,
    threadId: channel ? `${r.chat.id}/${m.replyToId ?? m.id}` : r.chat.id,
    author: user?.displayName ?? app?.displayName ?? null,
    authorAddress: null,
    title: title || null,
    summary: body ? clamp(body.replace(/\s+/g, ' '), MAX_SUMMARY_CHARS) : null,
    body,
    url: m.webUrl ?? r.chat.webUrl ?? null,
    labels,
    receivedAt: date(m.createdDateTime) ?? date(m.lastModifiedDateTime) ?? new Date(0),
    fromMe: !!user?.id && user.id === r.owner.id,
  } satisfies NormalizedItem;
}

function normalizeFile(r: Extract<MsRecord, { source: 'onedrive' }>) {
  const f = r.item;
  if (f.deleted || f.folder || f.root || !f.file) return null;
  const by = f.lastModifiedBy?.user ?? f.createdBy?.user ?? null;
  const path = f.parentReference?.path?.replace(/^\/drive(s\/[^/]+)?\/root:?/, '') || '/';
  const labels = [`onedrive:item:${f.id}`];
  if (f.parentReference?.driveId) labels.push(`onedrive:drive:${f.parentReference.driveId}`);
  if (f.file.mimeType) labels.push(`onedrive:mime:${f.file.mimeType}`);
  return {
    kind: 'file',
    externalId: f.id,
    threadId: null,
    author: by?.displayName ?? null,
    authorAddress: lower(by?.email),
    title: f.name ?? null,
    // Metadata only: file contents are never downloaded.
    summary: clamp(`${by?.displayName ? `Edited by ${by.displayName} · ` : ''}${path}`, 300),
    body: null,
    url: f.webUrl ?? null,
    labels,
    receivedAt: date(f.lastModifiedDateTime) ?? date(f.createdDateTime) ?? new Date(0),
    fromMe: !!by?.id && by.id === r.owner.id,
  } satisfies NormalizedItem;
}

/** Trusted signals derived from metadata that every source shares. */
function withSignals(item: NormalizedItem | null): NormalizedItem | null {
  if (item?.fromMe && !item.labels.includes('hub:from_me')) item.labels.push('hub:from_me');
  return item;
}

/** Maps any Microsoft record to a NormalizedItem (null for drafts, deletions, system events). */
export function normalizeMicrosoft(raw: MsRecord, _source?: string): NormalizedItem | null {
  return withSignals(normalizeRecord(raw));
}

function normalizeRecord(raw: MsRecord): NormalizedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  switch (raw.source) {
    case 'mail':
      return raw.message?.id ? normalizeMail(raw.folder, raw.message, raw.owner) : null;
    case 'calendar':
      return raw.event?.id ? normalizeEvent(raw.event, raw.owner) : null;
    case 'teams':
    case 'channels':
      return raw.message?.id && raw.chat?.id ? normalizeChat(raw) : null;
    case 'onedrive':
      return raw.item?.id ? normalizeFile(raw) : null;
    default:
      return null;
  }
}

const SOURCE_OF_KIND: Record<string, string> = {
  email: 'mail',
  event: 'calendar',
  file: 'onedrive',
};

/**
 * Read filters: a source switched off in `filters.sources` accepts nothing; mail passes when
 * it is in the Inbox and `inbox` is on, or in Sent Items and `sent` is on.
 */
export function microsoftAccepts(
  item: NormalizedItem,
  filters: AccountFilters,
  source?: string,
  defaults: Record<string, boolean> = {},
): boolean {
  const src =
    source ??
    SOURCE_OF_KIND[item.kind] ??
    (item.labels.some((l) => l.startsWith('teams:channel:')) ? 'channels' : 'teams');
  const on = filters.sources?.[src] ?? defaults[src] ?? true;
  if (!on) return false;
  if (item.kind === 'email') {
    const inInbox = item.labels.includes('outlook:folder:inbox');
    const inSent = item.labels.includes('outlook:folder:sent');
    return (filters.inbox && inInbox) || (filters.sent && inSent);
  }
  return true;
}
