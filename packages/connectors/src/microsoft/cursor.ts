/**
 * Per-source cursors, stored as small JSON strings in subscriptions.cursor. Links are the
 * Graph `@odata.nextLink` (mid-round) or `@odata.deltaLink` (round complete); both resume.
 */
export type MailCursor = { v: 1; inbox?: string | null; sent?: string | null };
export type CalendarCursor = { v: 1; link: string | null; start: string; end: string };
/** Teams chats have no delta API: `since` is a time watermark; `until`/`next` resume a round. */
export type TeamsCursor = { v: 1; since: string; until?: string; next?: string };
export type ChannelsCursor = { v: 1; since: string; until?: string; offset?: number };
export type DriveCursor = { v: 1; link: string | null };

export function parseCursor<T extends { v: 1 }>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as T;
    return c && typeof c === 'object' && c.v === 1 ? c : null;
  } catch {
    return null;
  }
}

export const encodeCursor = <T extends { v: 1 }>(c: T) => JSON.stringify(c);
