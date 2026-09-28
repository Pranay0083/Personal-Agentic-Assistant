import type { gmail_v1 } from '@googleapis/gmail';
import type { NormalizedItem } from '../types';
import type { GmailMessage } from './client';

/**
 * What fetchDelta/backfill return: the API message plus the mailbox it came from
 * (so normalize can build a Gmail web link for the right signed-in account).
 */
export type GmailRecord = { message: GmailMessage; accountEmail: string | null };

type Part = gmail_v1.Schema$MessagePart;

const MAX_BODY_CHARS = 200_000;

export function header(part: Part | undefined, name: string): string | null {
  const n = name.toLowerCase();
  const h = part?.headers?.find((x) => x.name?.toLowerCase() === n);
  return h?.value ?? null;
}

/** Parses `"Name" <addr>`, `Name <addr>` or a bare address. */
export function parseAddress(value: string | null): {
  name: string | null;
  address: string | null;
} {
  if (!value) return { name: null, address: null };
  const first = value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0]!.trim();
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(first);
  if (m) {
    const name = m[1]!
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    return { name: name || null, address: m[2]!.trim().toLowerCase() };
  }
  return /@/.test(first)
    ? { name: null, address: first.toLowerCase() }
    : { name: first || null, address: null };
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  '#39': "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ent: string) => {
    const lower = ent.toLowerCase();
    if (NAMED[lower] !== undefined) return NAMED[lower]!;
    if (lower.startsWith('#x')) return safeCodePoint(parseInt(lower.slice(2), 16)) ?? all;
    if (lower.startsWith('#')) return safeCodePoint(parseInt(lower.slice(1), 10)) ?? all;
    return all;
  });
}

function safeCodePoint(n: number) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : null;
  } catch {
    return null;
  }
}

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

function charsetOf(part: Part): string {
  const ct = header(part, 'Content-Type') ?? '';
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
  return m?.[1]?.toLowerCase() ?? 'utf-8';
}

export function decodeBase64Url(data: string, charset = 'utf-8'): string {
  const bytes = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function isAttachment(part: Part): boolean {
  if (part.filename) return true;
  const cd = header(part, 'Content-Disposition') ?? '';
  return /^\s*attachment/i.test(cd);
}

/** Depth-first search for the first inline part of the given type. */
function findPart(part: Part | undefined, mimeType: string): Part | null {
  if (!part) return null;
  if (part.mimeType?.toLowerCase() === mimeType && !isAttachment(part) && part.body?.data) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return null;
}

/** text/plain if present, otherwise the text/html part with tags stripped. */
export function extractBody(payload: Part | undefined): string | null {
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) {
    return clamp(decodeBase64Url(plain.body.data, charsetOf(plain)).replace(/\r\n/g, '\n').trim());
  }
  const html = findPart(payload, 'text/html');
  if (html?.body?.data) return clamp(htmlToText(decodeBase64Url(html.body.data, charsetOf(html))));
  return null;
}

const clamp = (s: string) => (s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) : s);

export function gmailWebUrl(accountEmail: string | null, id: string): string {
  const who = accountEmail ? encodeURIComponent(accountEmail) : '0';
  return `https://mail.google.com/mail/u/${who}/#all/${id}`;
}

function receivedAt(m: GmailMessage): Date {
  const ms = Number(m.internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  const d = header(m.payload, 'Date');
  const parsed = d ? Date.parse(d) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(0);
}

/** Prefix of the synthetic label carrying the RFC 822 Message-ID (used to thread replies). */
export const RFC822_LABEL_PREFIX = 'rfc822msgid:';

/** `<id@host>` from the Message-ID header, or null if absent/malformed. */
export function rfc822MessageId(m: GmailMessage): string | null {
  const v = header(m.payload, 'Message-ID')?.trim();
  if (!v) return null;
  const bracketed = v.startsWith('<') ? v : `<${v}>`;
  return /^<[^<>\s]+@[^<>\s]+>$/.test(bracketed) ? bracketed : null;
}

/** Maps a Gmail `messages.get format=full` response to a NormalizedItem. */
export function normalizeGmail(raw: GmailRecord | GmailMessage): NormalizedItem | null {
  const rec: GmailRecord =
    raw && typeof raw === 'object' && 'message' in raw && raw.message
      ? (raw as GmailRecord)
      : { message: raw as GmailMessage, accountEmail: null };
  const m = rec.message;
  if (!m?.id) return null;
  const labels = m.labelIds ?? [];
  // Drafts and Hangouts chats are not mail we want in the feed.
  if (labels.includes('DRAFT') || labels.includes('CHAT')) return null;
  const from = parseAddress(header(m.payload, 'From'));
  const subject = header(m.payload, 'Subject');
  const mid = rfc822MessageId(m);
  return {
    kind: 'email',
    externalId: m.id,
    threadId: m.threadId ?? null,
    author: from.name ?? from.address,
    authorAddress: from.address,
    title: subject ? subject.trim() : null,
    summary: m.snippet ? decodeEntities(m.snippet) : null,
    body: extractBody(m.payload),
    url: gmailWebUrl(rec.accountEmail, m.id),
    // Gmail label ids, plus `rfc822msgid:<id@host>` so the reply agent can thread.
    labels: mid ? [...labels, `${RFC822_LABEL_PREFIX}${mid}`] : labels,
    receivedAt: receivedAt(m),
    fromMe: labels.includes('SENT'),
  };
}
