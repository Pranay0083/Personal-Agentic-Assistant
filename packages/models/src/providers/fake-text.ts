/**
 * Text heuristics for the deterministic fake provider. They read the fenced content
 * the agents send and produce plausible structured output, fully offline.
 */
import { resolveDueDate, type ResolvedDue } from '../dates';

export type Fence = { label: string; content: string };

/** Extracts every `fenceUntrusted()` block from a prompt. */
export function readFences(text: string): Fence[] {
  const out: Fence[] = [];
  const re = /<untrusted-([0-9a-f]+) label="([^"]*)">\n([\s\S]*?)\n<\/untrusted-\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ label: m[2]!, content: m[3]! });
  return out;
}

/** Text outside the fences: trusted metadata written by our own code. */
export function outsideFences(text: string): string {
  return text.replace(/<untrusted-([0-9a-f]+) label="[^"]*">\n[\s\S]*?\n<\/untrusted-\1>/g, '');
}

export type ParsedItem = {
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  body: string;
};

/** Parses the item block the agents build: `From:` / `Subject:` headers, blank line, body. */
export function parseItem(content: string): ParsedItem {
  const [head, ...rest] = content.split(/\n\s*\n/);
  const headers: Record<string, string> = {};
  for (const line of (head ?? '').split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  const from = headers.from ?? '';
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? /\S+@\S+/.exec(from)?.[0] ?? null;
  const name =
    from
      .replace(/<[^>]*>/, '')
      .replace(/"/g, '')
      .trim() || null;
  const hasHeaders = 'from' in headers || 'subject' in headers;
  return {
    fromName: name && name !== addr ? name : null,
    fromAddress: addr ? addr.toLowerCase() : null,
    subject: headers.subject ?? '',
    body: hasHeaders ? rest.join('\n\n').trim() : content.trim(),
  };
}

export function firstName(name: string | null, address: string | null): string | null {
  if (name) return name.split(/\s+/)[0]!.replace(/[^\p{L}'-]/gu, '') || null;
  if (address) {
    const local = address.split('@')[0]!.split(/[._+-]/)[0]!;
    return local ? local[0]!.toUpperCase() + local.slice(1) : null;
  }
  return null;
}

const REQUEST_RE =
  /\b(can you|could you|would you|will you|can we get|please|pls|need you to|i need|we need|needs? (?:the|your|a|an)\b|let me know|waiting on you|asap|required by|due by|kindly)\b/i;
const NOISE_RE =
  /\b(unsubscribe|newsletter|no-?reply|promotion|% off|sale ends|webinar|receipt|your order|verification code|digest)\b/i;
const REPLY_RE = /\?|\b(let me know|can you|could you|would you|will you|confirm|thoughts)\b/i;
const PROMISE_RE = /\bI(?:'ll| will| can| am going to|'m going to)\s+([^.?!\n]+)/i;

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isNoise(item: ParsedItem): boolean {
  return (
    NOISE_RE.test(`${item.subject}\n${item.body}`) || /no-?reply/i.test(item.fromAddress ?? '')
  );
}

export function requestSentences(body: string): string[] {
  return sentences(body).filter((s) => REQUEST_RE.test(s) && !/^(thanks|thank you)\b/i.test(s));
}

export function expectsReply(body: string): boolean {
  return REPLY_RE.test(body);
}

export function promiseSentences(body: string): string[] {
  return sentences(body).filter((s) => PROMISE_RE.test(s));
}

const DUE_TAIL_RE =
  /\s*[,-]?\s*\b(?:by|before|on|until|till|no later than|due|for)\s+(?:the\s+)?(?:end of (?:the |this )?(?:day|week|month)|today|tonight|tomorrow|eod|cob|eow|eom|this \w+|next \w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|[a-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s+(?:eod|cob|at \d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}(?::\d{2})?\s*(?:am|pm)))?/gi;

/** "Hi Meera, can you send the Q3 deck by Thursday?" → "send the Q3 deck". */
export function actionPhrase(sentence: string): string {
  let s = sentence.trim();
  s = s.replace(/^(hi|hey|hello|dear)\b[^,—–-]*[,—–-]\s*/i, '');
  s = s.replace(/^(so|also|and|but|ok|okay)\b[,\s]*/i, '');
  s = s.replace(
    /^.*?\b(?:can you|could you|would you|will you|need you to|i need you to|please)\s+(?:please\s+)?/i,
    '',
  );
  s = s.replace(/^(?:i|we) need\s+/i, 'get ');
  s = s.replace(DUE_TAIL_RE, '');
  s = s.replace(
    /\s*\b(?:today|tonight|tomorrow|tmrw)(?:\s+(?:eod|cob|morning|afternoon|evening))?\b|\s*\b(?:eod|cob)\b/gi,
    '',
  );
  s = s.replace(/\b(?:asap|please|for me|thanks|thank you)\b/gi, '');
  s = s
    .replace(/[?!.,;:\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s;
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function lowerFirst(s: string): string {
  return s && !/^[A-Z]{2}/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

const HANDOFF_VERBS = /^(send|share|forward|email|mail|give|pass|show)\b/i;

/** Turns a request sentence into a task title, e.g. "Send the Q3 deck to Meera". */
export function taskTitle(sentence: string, requester: string | null): string {
  const action = actionPhrase(sentence);
  if (!action) return capitalize(sentence.replace(/[?!.]+$/, '')).slice(0, 120);
  let title = capitalize(action);
  if (
    requester &&
    HANDOFF_VERBS.test(action) &&
    !/\bto\s+\w+/i.test(action) &&
    !/\bme\b/i.test(action)
  ) {
    title += ` to ${requester}`;
  }
  title = title.replace(/\bme\b/g, requester ?? 'them');
  return title.slice(0, 120);
}

export function dueFor(sentence: string, whole: string, ref: string | null): ResolvedDue | null {
  if (!ref) return null;
  return resolveDueDate(sentence, ref) ?? resolveDueDate(whole, ref);
}

/** The object of an action: "send the Q3 deck" → "the Q3 deck". */
export function objectOf(action: string): string {
  const m = /^\w+\s+(.+?)(?:\s+to\s+\w+)?$/i.exec(action.trim());
  return (m?.[1] ?? action).trim();
}

export function stripSubject(subject: string): string {
  return subject.replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').trim();
}

export function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}
