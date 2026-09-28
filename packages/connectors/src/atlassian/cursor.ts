/**
 * Time-based delta cursor for Jira (JQL `updated`) and Confluence (CQL `lastmodified`).
 *
 * Jira and Confluence evaluate absolute dates in the *searching user's* profile time zone
 * and only to the minute, so the query uses a relative window instead
 * (`updated >= -Nm`, `lastmodified >= now("-Nm")`), computed from the cursor time plus an
 * overlap. Records seen at the edge of the window are remembered by id and last-modified
 * time so the overlap does not re-emit them.
 */
export const OVERLAP_MS = 60_000;

export type TimeCursor = {
  v: 1;
  /** Latest last-modified time seen (ISO, UTC). */
  t: string;
  /** id → last-modified epoch ms, for records within OVERLAP_MS of `t`. */
  seen: Record<string, number>;
};

export function startCursor(now: number): string {
  return JSON.stringify({ v: 1, t: new Date(now).toISOString(), seen: {} } satisfies TimeCursor);
}

export function parseCursor(raw: string | null | undefined): TimeCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<TimeCursor>;
    if (c.v !== 1 || typeof c.t !== 'string' || !Number.isFinite(Date.parse(c.t))) return null;
    return { v: 1, t: c.t, seen: c.seen && typeof c.seen === 'object' ? c.seen : {} };
  } catch {
    // A plain ISO timestamp also works as a starting point.
    return Number.isFinite(Date.parse(raw))
      ? { v: 1, t: new Date(raw).toISOString(), seen: {} }
      : null;
  }
}

/** Whole minutes to look back from `now` to cover the cursor plus the overlap. */
export function windowMinutes(c: TimeCursor, now: number): number {
  return Math.max(1, Math.ceil((now - Date.parse(c.t) + OVERLAP_MS) / 60_000));
}

/** Parses Jira (`2026-09-28T10:15:30.123+0000`) and Confluence (`...Z`) timestamps. */
export function parseTime(s: string | undefined | null): number {
  if (!s) return NaN;
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Date.parse(fixed);
}

/** Folds one page of records into the cursor; returns the records not already emitted. */
export class CursorTracker<T> {
  private maxT: number;
  private seen: Record<string, number>;
  /** Anything older was inside the previous query's window already. */
  private readonly floor: number;

  constructor(
    prev: TimeCursor,
    private readonly idOf: (r: T) => string,
    private readonly timeOf: (r: T) => number,
  ) {
    this.maxT = Date.parse(prev.t);
    this.seen = { ...prev.seen };
    this.floor = this.maxT - OVERLAP_MS;
  }

  take(records: T[]): T[] {
    const out: T[] = [];
    for (const r of records) {
      const id = this.idOf(r);
      const t = this.timeOf(r);
      if (!Number.isFinite(t)) {
        out.push(r);
        continue;
      }
      if (t < this.floor || this.seen[id] === t) continue;
      this.seen[id] = t;
      if (t > this.maxT) this.maxT = t;
      out.push(r);
    }
    return out;
  }

  cursor(): string {
    const floor = this.maxT - OVERLAP_MS;
    const seen = Object.fromEntries(Object.entries(this.seen).filter(([, t]) => t >= floor));
    return JSON.stringify({
      v: 1,
      t: new Date(this.maxT).toISOString(),
      seen,
    } satisfies TimeCursor);
  }
}
