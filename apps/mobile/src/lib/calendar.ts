import type { LabeledItemT } from './api';
import { dayDiff } from './format';

/** One calendar event for Today's "Next up". Times come from the item's label refs. */
export type TodayEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
};

const START = ['gcal:start:', 'mscal:start:'];
const END = ['gcal:end:', 'mscal:end:'];

function ref(labels: string[], prefixes: string[]): string | null {
  for (const l of labels) {
    const p = prefixes.find((x) => l.startsWith(x));
    if (p) return l.slice(p.length);
  }
  return null;
}

/** ISO date-time, or a bare YYYY-MM-DD for all-day events (read as a local date). */
function parseWhen(v: string | null): { at: Date; allDay: boolean } | null {
  if (!v) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day)
    return { at: new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])), allDay: true };
  const at = new Date(v);
  return Number.isNaN(at.getTime()) ? null : { at, allDay: false };
}

export function toEvent(item: LabeledItemT): TodayEvent | null {
  if (item.kind !== 'event') return null;
  const start = parseWhen(ref(item.labels, START));
  if (!start) return null;
  const end = parseWhen(ref(item.labels, END));
  return {
    id: item.id,
    title: item.title ?? '(no title)',
    start: start.at,
    end: end?.at ?? null,
    allDay: start.allDay,
  };
}

/** Events on today's date that haven't ended yet, all-day first, then by start time. */
export function todaysEvents(items: LabeledItemT[], now: Date): TodayEvent[] {
  const seen = new Set<string>();
  const out: TodayEvent[] = [];
  for (const item of items) {
    const e = toEvent(item);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    // All-day end dates are exclusive (the next day), like Google and Graph send them.
    const lastDay = e.end && e.allDay ? new Date(e.end.getTime() - 1) : (e.end ?? e.start);
    const today = dayDiff(e.start, now) <= 0 && dayDiff(lastDay, now) >= 0;
    if (!today) continue;
    if (!e.allDay && (e.end ?? e.start).getTime() < now.getTime()) continue;
    out.push(e);
  }
  return out.sort((a, b) =>
    a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.start.getTime() - b.start.getTime(),
  );
}

/** "15 min", "1 hr", "1 hr 30 min". Null without an end, or for all-day events. */
export function durationText(e: TodayEvent): string | null {
  if (!e.end || e.allDay) return null;
  const min = Math.round((e.end.getTime() - e.start.getTime()) / 60_000);
  if (min <= 0) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
