import { localParts } from '@hub/models';

export type QuietHours = { start: string; end: string };

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return (h % 24) * 60 + m;
};

/**
 * Whether `now` falls inside quiet hours in the user's timezone. The window may cross
 * midnight (22:00–07:00). Start is inclusive, end exclusive; start === end means off.
 */
export function isQuietHours(now: Date, timezone: string, qh: QuietHours): boolean {
  const p = localParts(now, timezone);
  const cur = p.hour * 60 + p.minute;
  const s = minutes(qh.start);
  const e = minutes(qh.end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** Milliseconds from `now` until quiet hours end (0 if not in quiet hours). */
export function msUntilQuietEnd(now: Date, timezone: string, qh: QuietHours): number {
  if (!isQuietHours(now, timezone, qh)) return 0;
  const p = localParts(now, timezone);
  const cur = p.hour * 60 + p.minute;
  const diffMin = (minutes(qh.end) - cur + 1440) % 1440;
  return diffMin * 60_000 - p.second * 1000 - now.getMilliseconds();
}
