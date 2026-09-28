import { microsToTs, tsToMicros, type SearchResponse, type SlackMessage } from './api';

/**
 * Delta via `search.messages`, not per-conversation `conversations.history`. Why:
 * - One query covers every conversation the user can see, including thread replies and
 *   DMs. `conversations.history` never returns thread replies (they need a
 *   `conversations.replies` call per active thread), and needs one call per channel.
 * - Cost stays flat as the user joins more channels. Slack's 2025 limits for
 *   non-Marketplace apps cap `conversations.history`/`replies` at 1 request per minute
 *   per method, which makes per-channel polling unworkable for a distributed app.
 * - Matches carry a `permalink`, so no `chat.getPermalink` call per message.
 * Costs: `search:read`, and the index lags by a few seconds. We rescan an overlap window
 * below the high-water mark and remember the ids seen in it, so a message indexed late
 * is still picked up once (items also dedupe on external id). `after:` is day-granular
 * and timezone-dependent, so the query starts two days early and we filter by `ts`.
 *
 * Results are sorted newest first, so a scan stops at the high-water mark. If a scan
 * needs more pages than one call allows, the cursor records where to resume (`scan`)
 * and the call returns `hasMore`; the high-water mark moves only when a scan completes,
 * so nothing between the old mark and the resume point is skipped.
 */
export type DeltaCursor = {
  v: 1;
  /** High-water mark: newest message ts processed by a completed scan. */
  ts: string;
  /** `<channel>:<ts>` ids already returned within the overlap window. */
  seen?: string[];
  /** Unfinished scan: resume at `page`, skipping ts above `below`, then advance to `top`. */
  scan?: { top: string; below: string; page: number };
};

export const DELTA_OVERLAP_US = 15 * 60 * 1_000_000;
const MAX_SEEN = 500;
const MAX_SEARCH_PAGE = 100; // search.messages refuses page > 100

export function initialCursor(nowMs: number): DeltaCursor {
  return { v: 1, ts: microsToTs(nowMs * 1000) };
}

export const encodeCursor = (c: DeltaCursor) => JSON.stringify(c);

const TS = /^\d{9,11}\.\d{6}$/;

/** Null when missing or unreadable (the caller restarts from now and asks for a backfill). */
export function decodeCursor(raw: string | null): DeltaCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<DeltaCursor>;
    if (c?.v !== 1 || typeof c.ts !== 'string' || !TS.test(c.ts)) return null;
    const out: DeltaCursor = { v: 1, ts: c.ts };
    if (Array.isArray(c.seen)) out.seen = c.seen.filter((s) => typeof s === 'string');
    const s = c.scan;
    if (s && TS.test(s.top) && TS.test(s.below) && Number.isInteger(s.page) && s.page >= 1) {
      out.scan = { top: s.top, below: s.below, page: s.page };
    }
    return out;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` (UTC) for a search `after:` modifier. */
export function searchDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Search query for a scan from `c`: two days below the overlap floor (see above). */
export function deltaQuery(c: DeltaCursor): string {
  const floorMs = (tsToMicros(c.ts) - DELTA_OVERLAP_US) / 1000;
  return `after:${searchDate(floorMs - 2 * 86_400_000)}`;
}

const idOf = (m: SlackMessage) => `${m.channel!.id}:${m.ts}`;
const tsOfId = (id: string) => tsToMicros(id.slice(id.lastIndexOf(':') + 1));

export async function scanDelta(opts: {
  cursor: DeltaCursor;
  /** One search.messages page (1-based), newest first. */
  search: (page: number) => Promise<SearchResponse>;
  maxPages: number;
}): Promise<{ matches: SlackMessage[]; cursor: DeltaCursor; hasMore: boolean }> {
  const cur = opts.cursor;
  const floor = tsToMicros(cur.ts);
  const lowest = floor - DELTA_OVERLAP_US;
  const seen = new Set(cur.seen ?? []);
  const below = cur.scan ? tsToMicros(cur.scan.below) : Number.POSITIVE_INFINITY;
  let top = cur.scan ? Math.max(floor, tsToMicros(cur.scan.top)) : floor;
  let low = below;
  let page = cur.scan?.page ?? 1;
  const out: SlackMessage[] = [];
  let done = false;

  for (let i = 0; i < opts.maxPages && !done; i++) {
    const res = await opts.search(page);
    const matches = res.messages?.matches ?? [];
    for (const m of matches) {
      if (!m.ts || !TS.test(m.ts) || !m.channel?.id) continue;
      const us = tsToMicros(m.ts);
      const id = idOf(m);
      // Already handled by an earlier call of this scan.
      if (us > below || (us === below && seen.has(id))) continue;
      if (us <= lowest) {
        done = true;
        break;
      }
      low = Math.min(low, us);
      if (seen.has(id)) continue;
      seen.add(id);
      top = Math.max(top, us);
      out.push(m);
    }
    const pages = res.messages?.paging?.pages ?? res.messages?.pagination?.page_count ?? page;
    if (matches.length === 0 || page >= pages || page >= MAX_SEARCH_PAGE) done = true;
    else if (!done) page += 1;
  }

  // `top` >= floor: the mark the next completed scan will stand on.
  const keptSeen = [...seen]
    .filter((id) => tsOfId(id) > top - DELTA_OVERLAP_US)
    .sort((a, b) => tsOfId(b) - tsOfId(a))
    .slice(0, MAX_SEEN);
  const cursor: DeltaCursor = done
    ? { v: 1, ts: microsToTs(top), ...(keptSeen.length ? { seen: keptSeen } : {}) }
    : {
        v: 1,
        ts: cur.ts,
        ...(keptSeen.length ? { seen: keptSeen } : {}),
        scan: {
          top: microsToTs(top),
          below: microsToTs(Number.isFinite(low) ? low : top),
          page,
        },
      };
  return { matches: out, cursor, hasMore: !done };
}
