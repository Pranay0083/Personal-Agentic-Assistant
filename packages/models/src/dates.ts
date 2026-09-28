/**
 * Timezone and relative-date helpers with no dependencies (Intl only).
 * Used by the fake provider, the extractor (to resolve due dates in the user's timezone)
 * and the notifier (quiet hours).
 */

export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
  /** YYYY-MM-DD in that timezone. */
  date: string;
  /** HH:MM in that timezone. */
  time: string;
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Returns a valid IANA zone, falling back to UTC for unknown or empty values. */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localParts(instant: Date, timeZone: string): LocalParts {
  const tz = safeTimeZone(timeZone);
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(instant)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: WEEKDAY_SHORT.indexOf(parts.weekday ?? 'Sun'),
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
  };
}

function offsetMs(instant: number, tz: string): number {
  const p = localParts(new Date(instant), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Converts a wall-clock date and time in `tz` to the UTC instant. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const tz = safeTimeZone(timeZone);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(result, tz);
  if (second !== result) result = second;
  return new Date(result);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** "today", "tomorrow", "Thursday", "Oct 3" relative to `ref` (both YYYY-MM-DD). */
export function relativeDayLabel(date: string, ref: string): string {
  const diff = daysBetween(ref, date);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return WEEKDAY_NAMES[weekdayOf(date)]!;
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${MONTHS_SHORT[m - 1]} ${d}`;
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const MONTH_RE =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const monthIndex = (s: string) =>
  MONTHS_SHORT.findIndex((m) => s.toLowerCase().startsWith(m.toLowerCase()));

const WEEKDAY_FULL_RE = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const WEEKDAY_ABBR_RE = 'sun|mon|tues?|wed|thu(?:rs?)?|fri|sat';
const weekdayIndex = (s: string) => {
  const k = s.toLowerCase().slice(0, 3);
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(k);
};
const NUM_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

const PREP = '(?:(?:by|before|on|until|till|due|no later than|for)\\s+)?';

export type ResolvedDue = {
  /** YYYY-MM-DD, local to the reference date's timezone. */
  date: string;
  /** HH:MM if a time was stated ("5pm", "EOD"), else null. */
  time: string | null;
  /** The matched phrase, e.g. "by Thursday". */
  phrase: string;
};

type Candidate = { index: number; phrase: string; date: string };

function nextWeekday(ref: string, target: number, includeToday: boolean): string {
  const cur = weekdayOf(ref);
  let diff = (target - cur + 7) % 7;
  if (diff === 0 && !includeToday) diff = 7;
  return addDays(ref, diff);
}

function monthDay(ref: string, month: number, day: number): string | null {
  const refYear = Number(ref.slice(0, 4));
  let date = `${refYear}-${pad(month + 1)}-${pad(day)}`;
  if (!isIsoDate(date)) return null;
  if (daysBetween(ref, date) < -7) date = `${refYear + 1}-${pad(month + 1)}-${pad(day)}`;
  return isIsoDate(date) ? date : null;
}

function findDates(text: string, ref: string): Candidate[] {
  const out: Candidate[] = [];
  const add = (re: RegExp, fn: (m: RegExpExecArray) => string | null) => {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      const date = fn(m);
      if (date) out.push({ index: m.index, phrase: m[0].trim(), date });
    }
  };

  add(new RegExp(`${PREP}\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`), (m) => {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return isIsoDate(d) ? d : null;
  });
  add(new RegExp(`${PREP}\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`), (m) =>
    monthDay(ref, monthIndex(m[1]!), Number(m[2])),
  );
  add(new RegExp(`${PREP}\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b`), (m) =>
    monthDay(ref, monthIndex(m[2]!), Number(m[1])),
  );
  add(new RegExp(`${PREP}\\b(\\d{1,2})\\/(\\d{1,2})\\b(?!\\/)`), (m) =>
    monthDay(ref, Number(m[1]) - 1, Number(m[2])),
  );
  add(
    new RegExp(`${PREP}\\b(today|tonight|eod|end of (?:the )?day|cob|close of business)\\b`),
    () => ref,
  );
  add(new RegExp(`${PREP}\\b(tomorrow|tmrw|tmr)\\b`), () => addDays(ref, 1));
  add(new RegExp(`${PREP}\\b(?:(this|next)\\s+)?(${WEEKDAY_FULL_RE})\\b`), (m) =>
    nextWeekday(ref, weekdayIndex(m[2]!), m[1]?.toLowerCase() === 'this'),
  );
  add(new RegExp(`\\b(?:by|on|before|until|till|this|next)\\s+(${WEEKDAY_ABBR_RE})\\b\\.?`), (m) =>
    nextWeekday(ref, weekdayIndex(m[1]!), false),
  );
  add(new RegExp(`${PREP}\\b(?:end of (?:the |this )?week|eow)\\b`), () =>
    nextWeekday(ref, 5, true),
  );
  add(new RegExp(`${PREP}\\b(?:end of (?:the |this )?month|eom)\\b`), () => {
    const [y, m] = ref.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  });
  add(new RegExp(`${PREP}\\bnext week\\b`), () => nextWeekday(ref, 1, false));
  add(
    new RegExp(
      `\\bwithin\\s+(\\d+|a|an|one|two|three|four|five)\\s+(day|days|week|weeks)\\b|\\bin\\s+(\\d+|a|an|one|two|three|four|five)\\s+(day|days|week|weeks)\\b`,
    ),
    (m) => {
      const nRaw = (m[1] ?? m[3])!.toLowerCase();
      const unit = (m[2] ?? m[4])!.toLowerCase();
      const n = NUM_WORDS[nRaw] ?? Number(nRaw);
      if (!Number.isFinite(n) || n > 365) return null;
      return addDays(ref, unit.startsWith('week') ? n * 7 : n);
    },
  );
  return out;
}

function findTime(text: string): { time: string; index: number; phrase: string } | null {
  const m12 = /\b(?:by\s+|at\s+|before\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (m12) {
    let h = Number(m12[1]) % 12;
    if (m12[3]!.toLowerCase() === 'pm') h += 12;
    const min = Number(m12[2] ?? 0);
    if (h < 24 && min < 60)
      return { time: `${pad(h)}:${pad(min)}`, index: m12.index, phrase: m12[0] };
  }
  const noon = /\b(?:by\s+)?noon\b/i.exec(text);
  if (noon) return { time: '12:00', index: noon.index, phrase: noon[0] };
  const eod = /\b(eod|end of (?:the )?day|cob|close of business)\b/i.exec(text);
  if (eod) return { time: '17:00', index: eod.index, phrase: eod[0] };
  const m24 = /\b(?:by|at|before)\s+([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(text);
  if (m24) return { time: `${pad(Number(m24[1]))}:${m24[2]}`, index: m24.index, phrase: m24[0] };
  return null;
}

/**
 * Finds the first due-date phrase in `text` and resolves it against `ref`
 * (the local date the message was received, YYYY-MM-DD).
 * "by Thursday" → next Thursday after ref; "tomorrow EOD" → ref+1 at 17:00.
 */
export function resolveDueDate(text: string, ref: string): ResolvedDue | null {
  if (!isIsoDate(ref)) return null;
  const dates = findDates(text, ref).sort((a, b) => a.index - b.index);
  const time = findTime(text);
  const first = dates[0];
  if (first) {
    let phrase = first.phrase;
    if (time && Math.abs(time.index - (first.index + first.phrase.length)) <= 2) {
      phrase = `${phrase} ${time.phrase.trim()}`;
    }
    return { date: first.date, time: time?.time ?? null, phrase };
  }
  if (time && /\b(by|before)\b/i.test(time.phrase)) {
    return { date: ref, time: time.time, phrase: time.phrase.trim() };
  }
  return null;
}
