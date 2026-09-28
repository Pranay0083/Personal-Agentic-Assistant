import type { AccountFilters } from '@hub/shared';

/** Never ingested, whatever the filters say. */
const ALWAYS_EXCLUDED = ['SPAM', 'TRASH', 'DRAFT', 'CHAT'];
/** The Scope screen's "Promotions and Social" toggle covers both categories. */
const BULK_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];

/**
 * Gmail read filters (Scope screen):
 * - included if (inbox && INBOX) || (sent && SENT) || it carries one of `filters.labels`
 *   (Gmail label ids such as `Label_123`, or the label name for system labels);
 * - then dropped if it is Promotions/Social and `promotions` is off (unless it is the
 *   owner's own sent mail).
 */
export function gmailAccepts(labels: string[], filters: AccountFilters): boolean {
  if (labels.some((l) => ALWAYS_EXCLUDED.includes(l))) return false;
  const has = (l: string) => labels.includes(l);
  const wanted = new Set(filters.labels ?? []);
  const included =
    (filters.inbox && has('INBOX')) ||
    (filters.sent && has('SENT')) ||
    labels.some((l) => wanted.has(l));
  if (!included) return false;
  if (!filters.promotions && !has('SENT') && labels.some((l) => BULK_CATEGORIES.includes(l))) {
    return false;
  }
  return true;
}

/** Label ids passed to users.watch so Gmail only notifies for mail we would ingest. */
export function watchLabelIds(filters: AccountFilters): string[] {
  const ids = new Set<string>();
  if (filters.inbox) ids.add('INBOX');
  if (filters.sent) ids.add('SENT');
  for (const l of filters.labels ?? []) ids.add(l);
  if (ids.size === 0) ids.add('INBOX');
  return [...ids];
}

/**
 * Search query for backfill. Exact filtering happens afterwards with gmailAccepts;
 * the query only trims what we page through.
 */
export function backfillQuery(days: number, filters: AccountFilters): string {
  const parts = [
    `newer_than:${Math.max(1, Math.floor(days))}d`,
    '-in:spam',
    '-in:trash',
    '-in:drafts',
  ];
  if (!filters.promotions) parts.push('-category:promotions', '-category:social');
  if ((filters.labels ?? []).length === 0) {
    if (filters.inbox && !filters.sent) parts.push('in:inbox');
    else if (filters.sent && !filters.inbox) parts.push('in:sent');
  }
  return parts.join(' ');
}
