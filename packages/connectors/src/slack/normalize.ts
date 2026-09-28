import type { AccountFilters } from '@hub/shared';
import type { NormalizedItem } from '../types';
import { tsToDate, type SlackMessage, type SlackSearchChannel } from './api';

export type ConversationType = 'channel' | 'group' | 'im' | 'mpim';

/** One Slack message plus the context `normalize` needs (it has no connector context). */
export type SlackRecord = {
  teamId: string;
  teamDomain: string | null;
  /** The connected user; `fromMe` compares against it. */
  selfUserId: string;
  channel: { id: string; type: ConversationType; name: string | null };
  message: SlackMessage;
  /** Resolved display name of `message.user` (users.info). */
  authorName: string | null;
  /** Display names for user ids mentioned in the text, when resolved. */
  names?: Record<string, string>;
};

export const SLACK_LABEL = {
  channel: (id: string) => `slack:channel:${id}`,
  ts: (ts: string) => `slack:ts:${ts}`,
  thread: (ts: string) => `slack:thread:${ts}`,
  type: (t: ConversationType) => `slack:type:${t}`,
  mentionsMe: 'slack:mentions:me',
  channelName: (name: string) => `slack:channel_name:${name}`,
} as const;

/**
 * Trusted signal labels (see NormalizedItem.labels). Set only from Slack metadata:
 * conversation type, author id and Slack's own `<@U…>` mention markup (a user typing
 * `<@U…>` literally arrives escaped as `&lt;@U…&gt;`, so text cannot forge it).
 */
export const HUB_LABEL = { mention: 'hub:mention', dm: 'hub:dm', fromMe: 'hub:from_me' } as const;

/** Slack channel names are lowercase letters, digits, `-` and `_`; anything else is dropped. */
const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** Message subtypes that are never worth an item (joins, topic changes, edits, bots). */
const NOISE_SUBTYPES = new Set([
  'bot_message',
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'message_changed',
  'message_deleted',
  'message_replied',
  'pinned_item',
  'unpinned_item',
  'reminder_add',
  'joiner_notification_for_inviter',
  'ekm_access_denied',
  'tombstone',
]);

export function isNoise(m: Pick<SlackMessage, 'subtype' | 'bot_id' | 'user'>): boolean {
  if (m.subtype && NOISE_SUBTYPES.has(m.subtype)) return true;
  if (m.bot_id) return true;
  return !m.user || m.user === 'USLACKBOT';
}

export function conversationType(c: SlackSearchChannel): ConversationType {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  if (c.is_private || c.is_group) return 'group';
  if (c.is_channel) return 'channel';
  if (c.id.startsWith('D')) return 'im';
  if (c.id.startsWith('G')) return c.name?.startsWith('mpdm-') ? 'mpim' : 'group';
  return 'channel';
}

/** Thread root of a message: `thread_ts`, or the `thread_ts` query of a reply permalink. */
export function threadTsOf(m: SlackMessage): string | null {
  if (m.thread_ts) return m.thread_ts;
  if (!m.permalink) return null;
  try {
    return new URL(m.permalink).searchParams.get('thread_ts');
  } catch {
    return null;
  }
}

export const mentionsUser = (text: string | undefined, userId: string) =>
  !!text && text.includes(`<@${userId}`);

/** User ids mentioned in Slack markup (`<@U123>` or `<@U123|name>`). */
export function mentionedUserIds(text: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) out.add(m[1]!);
  return [...out];
}

/** Slack mrkdwn → plain text: mentions, channel links, URLs and HTML entities. */
export function slackToText(text: string, names: Record<string, string> = {}): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
      return `@${names[id] ?? label ?? id}`;
    })
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
      return `#${label || id}`;
    })
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label?: string) => label ?? '@group')
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Permalink for a message: the one Slack gave us, or the documented archive URL form. */
export function permalinkFor(r: SlackRecord): string {
  if (r.message.permalink) return r.message.permalink;
  const { id } = r.channel;
  const ts = r.message.ts;
  const thread = threadTsOf(r.message);
  if (!r.teamDomain) return `https://app.slack.com/client/${r.teamId}/${id}`;
  const base = `https://${r.teamDomain}.slack.com/archives/${id}/p${ts.replace('.', '')}`;
  return thread && thread !== ts ? `${base}?thread_ts=${thread}&cid=${id}` : base;
}

function titleFor(r: SlackRecord, author: string | null): string {
  switch (r.channel.type) {
    case 'im':
      return author ? `DM · ${author}` : 'Direct message';
    case 'mpim':
      return 'Group DM';
    default:
      return r.channel.name ? `#${r.channel.name}` : `#${r.channel.id}`;
  }
}

const SUMMARY_LEN = 200;

export function normalizeSlack(r: SlackRecord): NormalizedItem | null {
  const m = r.message;
  if (!m?.ts || isNoise(m)) return null;
  const channelId = r.channel.id;
  const threadTs = threadTsOf(m);
  const isReply = !!threadTs && threadTs !== m.ts;
  const names = r.names ?? {};
  const body = slackToText(m.text ?? '', names).trim();
  const author = r.authorName ?? m.username ?? m.user ?? null;
  const labels = [
    SLACK_LABEL.channel(channelId),
    SLACK_LABEL.ts(m.ts),
    SLACK_LABEL.type(r.channel.type),
  ];
  const named = r.channel.type === 'channel' || r.channel.type === 'group';
  if (named && r.channel.name && CHANNEL_NAME.test(r.channel.name)) {
    labels.push(SLACK_LABEL.channelName(r.channel.name));
  }
  if (isReply) labels.push(SLACK_LABEL.thread(threadTs));
  const fromMe = !!m.user && m.user === r.selfUserId;
  if (mentionsUser(m.text, r.selfUserId)) labels.push(SLACK_LABEL.mentionsMe, HUB_LABEL.mention);
  if (r.channel.type === 'im') labels.push(HUB_LABEL.dm);
  if (fromMe) labels.push(HUB_LABEL.fromMe);
  const dm = r.channel.type === 'im' || r.channel.type === 'mpim';
  return {
    kind: 'chat',
    externalId: `${channelId}:${m.ts}`,
    // A thread groups its replies; a DM is one conversation; a channel post is its own thread.
    threadId: threadTs ? `${channelId}:${threadTs}` : dm ? channelId : `${channelId}:${m.ts}`,
    author,
    authorAddress: m.user ?? null,
    title: titleFor(r, author),
    summary: body ? body.slice(0, SUMMARY_LEN) : null,
    body: body || null,
    url: permalinkFor(r),
    labels,
    receivedAt: tsToDate(m.ts),
    fromMe,
  };
}

/** Slack read options from the Scope screen (`filters.options`). */
export type SlackOptions = { channels: 'joined' | 'mentions'; dms: boolean };

export function slackOptions(filters: Partial<AccountFilters> | undefined): SlackOptions {
  const o = filters?.options ?? {};
  const dms = typeof o.dms === 'boolean' ? o.dms : (filters?.sources?.dms ?? true);
  return { channels: o.channels === 'mentions' ? 'mentions' : 'joined', dms };
}

/** Option check on raw data, used during delta so filtered messages are never fetched further. */
export function passesOptions(
  opts: SlackOptions,
  type: ConversationType,
  m: SlackMessage,
  selfUserId: string,
): boolean {
  if (type === 'im' || type === 'mpim') return opts.dms;
  if (opts.channels === 'mentions') return mentionsUser(m.text, selfUserId);
  return true;
}

/** `accepts` for normalized items: the same rules, read back from the labels. */
export function slackAccepts(item: NormalizedItem, filters: AccountFilters): boolean {
  const opts = slackOptions(filters);
  const dm =
    item.labels.includes(SLACK_LABEL.type('im')) || item.labels.includes(SLACK_LABEL.type('mpim'));
  if (dm) return opts.dms;
  if (opts.channels === 'mentions') return item.labels.includes(SLACK_LABEL.mentionsMe);
  return true;
}
