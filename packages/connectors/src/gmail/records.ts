import type { AccountFilters } from '@hub/shared';
import type { NormalizedItem } from '../types';
import { calendarAccepts, normalizeCalendar, type CalendarRecord } from './calendar';
import { normalizeChat, type ChatRecord } from './chat';
import type { GmailMessage } from './client';
import { driveAccepts, normalizeDrive, type DriveRecord } from './drive';
import { gmailAccepts } from './filters';
import { normalizeGmail, type GmailRecord } from './normalize';
import type { GoogleSource } from './scopes';

/** What fetchDelta/backfill return, per source. */
export type GoogleRecord = GmailRecord | CalendarRecord | DriveRecord | ChatRecord;

const isObj = (r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object';

/** Which source a record came from, by shape (for callers that don't pass `source`). */
export function recordSource(raw: unknown): GoogleSource {
  if (isObj(raw)) {
    if ('event' in raw && 'calendarId' in raw) return 'calendar';
    if ('change' in raw) return 'drive';
    if ('chatMessage' in raw) return 'chat';
  }
  return 'mail';
}

export function normalizeGoogle(
  raw: GoogleRecord | GmailMessage,
  source?: string,
): NormalizedItem | null {
  const shape = recordSource(raw);
  const s = source ?? shape;
  // A record from another source than claimed is dropped rather than misread.
  if (s !== shape) return null;
  switch (s) {
    case 'calendar':
      return normalizeCalendar(raw as CalendarRecord);
    case 'drive':
      return normalizeDrive(raw as DriveRecord);
    case 'chat':
      return normalizeChat(raw as ChatRecord);
    case 'mail':
      return normalizeGmail(raw as GmailRecord | GmailMessage);
    default:
      return null;
  }
}

/** Scope-screen filters, per source (inferred from the item kind when not given). */
export function googleAccepts(
  item: NormalizedItem,
  filters: AccountFilters,
  source?: string,
): boolean {
  const s =
    source ??
    (item.kind === 'event'
      ? 'calendar'
      : item.kind === 'file'
        ? 'drive'
        : item.kind === 'chat'
          ? 'chat'
          : 'mail');
  switch (s) {
    case 'calendar':
      return calendarAccepts(item, filters);
    case 'drive':
      return driveAccepts(item, filters);
    case 'chat':
      return true;
    default:
      return gmailAccepts(item.labels, filters);
  }
}
