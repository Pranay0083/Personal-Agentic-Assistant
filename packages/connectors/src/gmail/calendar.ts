import type { AccountFilters } from '@hub/shared';
import type { BackfillPage, DeltaResult, NormalizedItem } from '../types';
import { httpStatusOf } from './client';
import { decodeEntities, htmlToText } from './normalize';
import { GOOGLE_API, type GoogleRest } from './rest';

/**
 * Google Calendar source: events on the user's primary calendar, which holds the events
 * they organize and the ones they are invited to. Delta = events.list with a syncToken
 * (410 → full resync); push = events.watch channel (see channels.ts).
 */

export type CalendarPerson = {
  id?: string;
  email?: string;
  displayName?: string;
  self?: boolean;
};
export type CalendarAttendee = CalendarPerson & {
  organizer?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
};
export type CalendarEventTime = { date?: string; dateTime?: string; timeZone?: string };

/** The events#resource fields the connector reads. */
export type CalendarEvent = {
  kind?: string;
  etag?: string;
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: CalendarPerson;
  organizer?: CalendarPerson;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  recurringEventId?: string;
  originalStartTime?: CalendarEventTime;
  iCalUID?: string;
  sequence?: number;
  attendees?: CalendarAttendee[];
  hangoutLink?: string;
  eventType?: string;
  [k: string]: unknown;
};

export type CalendarEventList = {
  kind?: string;
  etag?: string;
  summary?: string;
  updated?: string;
  timeZone?: string;
  nextPageToken?: string;
  nextSyncToken?: string;
  items?: CalendarEvent[];
};

export type CalendarRecord = {
  event: CalendarEvent;
  calendarId: string;
  accountEmail: string | null;
};

export const CALENDAR_ID = 'primary';
const EVENTS_URL = `${GOOGLE_API.calendar}/calendars/${CALENDAR_ID}/events`;
/** Event types that are not meetings: never put in the feed. */
const SKIPPED_TYPES = new Set(['workingLocation', 'focusTime', 'outOfOffice', 'birthday']);
const MAX_BODY_CHARS = 20_000;

/**
 * A sync token for "from now on" without downloading the calendar: pages through the
 * future events with only the paging fields until Google hands out nextSyncToken.
 */
export async function calendarSyncToken(rest: GoogleRest, now = Date.now()): Promise<string> {
  let pageToken: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await rest<CalendarEventList>({
      url: EVENTS_URL,
      params: {
        timeMin: new Date(now).toISOString(),
        maxResults: 2500,
        showDeleted: false,
        fields: 'nextPageToken,nextSyncToken',
        pageToken,
      },
    });
    if (res.nextSyncToken) return res.nextSyncToken;
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  throw new Error('calendar: no sync token returned');
}

export async function calendarDelta(
  rest: GoogleRest,
  opts: { cursor: string | null; accountEmail: string },
): Promise<DeltaResult<CalendarRecord>> {
  if (!opts.cursor) return { records: [], cursor: await calendarSyncToken(rest) };
  const records: CalendarRecord[] = [];
  let pageToken: string | undefined;
  try {
    for (;;) {
      const res = await rest<CalendarEventList>({
        url: EVENTS_URL,
        params: { syncToken: opts.cursor, maxResults: 250, pageToken },
      });
      for (const event of res.items ?? []) {
        records.push({ event, calendarId: CALENDAR_ID, accountEmail: opts.accountEmail });
      }
      if (res.nextSyncToken) return { records, cursor: res.nextSyncToken };
      if (!res.nextPageToken) return { records, cursor: opts.cursor };
      pageToken = res.nextPageToken;
    }
  } catch (e) {
    if (httpStatusOf(e) === 410) {
      // Sync token expired: start again from now; the caller backfills.
      return { records: [], cursor: await calendarSyncToken(rest), fullResyncRequired: true };
    }
    throw e;
  }
}

export async function calendarBackfill(
  rest: GoogleRest,
  opts: { days: number; pageToken?: string; accountEmail: string; pageSize?: number },
  now = Date.now(),
): Promise<BackfillPage<CalendarRecord>> {
  const res = await rest<CalendarEventList>({
    url: EVENTS_URL,
    params: {
      updatedMin: new Date(now - Math.max(1, opts.days) * 86400_000).toISOString(),
      showDeleted: false,
      maxResults: opts.pageSize ?? 250,
      pageToken: opts.pageToken,
    },
  });
  return {
    records: (res.items ?? []).map((event) => ({
      event,
      calendarId: CALENDAR_ID,
      accountEmail: opts.accountEmail,
    })),
    nextPageToken: res.nextPageToken ?? null,
  };
}

/** `2026-10-01T04:30:00.000Z` for timed events, `2026-10-09` for all-day ones. */
export function eventStartIso(t: CalendarEventTime | undefined): string | null {
  if (!t) return null;
  if (t.dateTime) {
    const ms = Date.parse(t.dateTime);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return t.date ?? null;
}

function describe(e: CalendarEvent): string | null {
  const parts: string[] = [];
  if (e.description) {
    const text = /<[a-z][\s\S]*>/i.test(e.description)
      ? htmlToText(e.description)
      : decodeEntities(e.description).trim();
    if (text) parts.push(text);
  }
  if (e.location) parts.push(`Location: ${e.location}`);
  const out = parts.join('\n\n');
  return out ? out.slice(0, MAX_BODY_CHARS) : null;
}

function whenLine(e: CalendarEvent): string | null {
  const s = e.start;
  if (s?.dateTime) return `${s.dateTime}${s.timeZone ? ` (${s.timeZone})` : ''}`;
  if (s?.date) return `${s.date} (all day)`;
  return null;
}

/** Maps an events#resource to a NormalizedItem (kind `event`). */
export function normalizeCalendar(rec: CalendarRecord): NormalizedItem | null {
  const e = rec.event;
  if (!e?.id) return null;
  if (e.eventType && SKIPPED_TYPES.has(e.eventType)) return null;
  // Incremental sync reports deletions as bare {id, status: cancelled}: nothing to show.
  if (e.status === 'cancelled' && !e.summary) return null;
  const organizer = e.organizer ?? e.creator;
  const self = e.attendees?.find((a) => a.self);
  const start = eventStartIso(e.start);
  const end = eventStartIso(e.end);
  const labels = [`gcal:event:${e.id}`, `gcal:calendar:${rec.calendarId}`];
  if (start) labels.push(`gcal:start:${start}`);
  if (end) labels.push(`gcal:end:${end}`);
  if (e.status) labels.push(`gcal:status:${e.status}`);
  if (self?.responseStatus) labels.push(`gcal:response:${self.responseStatus}`);
  if (organizer?.self) labels.push('gcal:role:organizer');
  else if (self) labels.push('gcal:role:attendee');
  if (e.recurringEventId) labels.push(`gcal:series:${e.recurringEventId}`);
  // Trusted signals, from event metadata only.
  if (self?.responseStatus === 'needsAction' && !organizer?.self && e.status !== 'cancelled') {
    labels.push('hub:rsvp_needed');
  }
  if (organizer?.self) labels.push('hub:from_me');
  const when = whenLine(e);
  const who = organizer?.self ? 'you' : (organizer?.displayName ?? organizer?.email ?? null);
  const summary = [
    e.status === 'cancelled' ? 'Cancelled' : null,
    when,
    who ? `organized by ${who}` : null,
    self?.responseStatus && !organizer?.self ? `your response: ${self.responseStatus}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const updated = Date.parse(e.updated ?? e.created ?? '');
  return {
    kind: 'event',
    externalId: e.id,
    threadId: e.recurringEventId ?? e.id,
    author: organizer?.displayName ?? organizer?.email ?? null,
    authorAddress: organizer?.email?.toLowerCase() ?? null,
    title: e.summary?.trim() || null,
    summary: summary || null,
    body: describe(e),
    url: e.htmlLink ?? null,
    labels,
    receivedAt: new Date(Number.isFinite(updated) ? updated : 0),
    fromMe: organizer?.self === true,
  };
}

/** Scope-screen option `calendar.hideDeclined` (default on): drop events you declined. */
export function calendarAccepts(item: NormalizedItem, filters: AccountFilters): boolean {
  const hide = filters.options?.['calendar.hideDeclined'];
  if (hide !== false && item.labels.includes('gcal:response:declined')) return false;
  return true;
}
