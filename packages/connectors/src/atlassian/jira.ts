import type { BackfillPage, DeltaResult, NormalizedItem } from '../types';
import type { JiraIssue, JiraIssueLink, JiraSearchPage } from './api-types';
import type { AtlassianClient } from './client';
import { CursorTracker, parseCursor, parseTime, startCursor, windowMinutes } from './cursor';
import { adfMentions, adfToText, cap } from './text';

/**
 * Jira source: issues where the user is assignee, reporter or watcher, or is mentioned in
 * the description or a comment. Uses the enhanced search endpoint
 * (`POST /rest/api/3/search/jql`, token paging), which replaced `/rest/api/3/search`.
 */

export type JiraRecord = {
  type: 'jira';
  cloudId: string;
  siteUrl: string | null;
  /** Atlassian account id of the connected user. */
  me: string | null;
  issue: JiraIssue;
  /** Distinct assignees of the unresolved issues this one blocks (null = not looked up). */
  blockingPeople: number | null;
};

const INVOLVED = 'assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()';
/** Mentions are indexed as text; some sites reject `~ currentUser()`, so it has a fallback. */
const MENTIONED = 'description ~ currentUser() OR comment ~ currentUser()';

export const SEARCH_FIELDS = [
  'summary',
  'status',
  'priority',
  'assignee',
  'reporter',
  'issuetype',
  'project',
  'created',
  'updated',
  'description',
  'issuelinks',
  'comment',
];

export const PAGE_SIZE = 50;
/** Pages per fetchDelta call; beyond that `hasMore` hands control back to the sync loop. */
export const MAX_PAGES = 5;
const COMMENTS_IN_BODY = 3;
/** Comments checked for an @-mention of the user. */
const COMMENTS_FOR_MENTION = 10;
export const BODY_CAP = 20_000;
const COMMENT_CAP = 2_000;

/** Sites whose JQL parser refused the mention clauses (per process). */
const noMentionSearch = new Set<string>();

export function involvementJql(cloudId: string): string {
  return noMentionSearch.has(cloudId) ? INVOLVED : `${INVOLVED} OR ${MENTIONED}`;
}

export function deltaJql(cloudId: string, minutes: number): string {
  return `(${involvementJql(cloudId)}) AND updated >= -${minutes}m ORDER BY updated ASC`;
}

export function backfillJql(cloudId: string, days: number): string {
  return `(${involvementJql(cloudId)}) AND updated >= -${days}d ORDER BY updated DESC`;
}

type SearchOpts = { jql: string; nextPageToken?: string; fields?: string[]; maxResults?: number };

/**
 * One page of enhanced search. A 400 on a query with the mention clauses drops them for
 * this site and retries (JQL text search on `currentUser()` is not accepted everywhere).
 */
async function search(
  api: AtlassianClient,
  cloudId: string,
  build: () => string,
  o: Omit<SearchOpts, 'jql'>,
): Promise<JiraSearchPage> {
  const body = (jql: string) => ({
    jql,
    maxResults: o.maxResults ?? PAGE_SIZE,
    fields: o.fields ?? SEARCH_FIELDS,
    ...(o.nextPageToken ? { nextPageToken: o.nextPageToken } : {}),
  });
  const hadMentions = !noMentionSearch.has(cloudId);
  const page = await api.jira<JiraSearchPage | null>('/search/jql', {
    method: 'POST',
    body: body(build()),
    allow: hadMentions ? [400] : [],
  });
  if (page) return page;
  noMentionSearch.add(cloudId);
  // The next-page token belongs to the old query; restart it.
  return api.jira<JiraSearchPage>('/search/jql', {
    method: 'POST',
    body: { ...body(build()), nextPageToken: undefined },
  });
}

/** Outward "Blocks" links to issues that are not done yet. */
export function blockedKeys(issue: JiraIssue): string[] {
  return (issue.fields.issuelinks ?? [])
    .filter(
      (l: JiraIssueLink) => /^blocks$/i.test(l.type.name) || /^blocks$/i.test(l.type.outward ?? ''),
    )
    .map((l) => l.outwardIssue)
    .filter((o): o is NonNullable<JiraIssueLink['outwardIssue']> => !!o)
    .filter((o) => o.fields?.status?.statusCategory?.key !== 'done')
    .map((o) => o.key);
}

/**
 * Counts the people waiting on each issue: distinct assignees of the unresolved issues it
 * blocks. One extra search per page, only when some issue on the page blocks others.
 */
async function blockingPeople(
  api: AtlassianClient,
  issues: JiraIssue[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys = [...new Set(issues.flatMap(blockedKeys))].slice(0, 100);
  if (!keys.length) return out;
  const page = await api.jira<JiraSearchPage | null>('/search/jql', {
    method: 'POST',
    body: { jql: `key in (${keys.join(',')})`, fields: ['assignee'], maxResults: 100 },
    // 400 = one of the keys is gone or hidden from this user; skip the count.
    allow: [400],
  });
  if (!page) return out;
  const assignee = new Map(page.issues.map((i) => [i.key, i.fields.assignee?.accountId ?? null]));
  for (const issue of issues) {
    const people = new Set(
      blockedKeys(issue)
        .map((k) => assignee.get(k))
        .filter((a): a is string => !!a),
    );
    out.set(issue.id, people.size);
  }
  return out;
}

type Site = { cloudId: string; siteUrl: string | null; me: string | null };

async function toRecords(api: AtlassianClient, site: Site, issues: JiraIssue[]) {
  const people = await blockingPeople(api, issues);
  return issues.map((issue): JiraRecord => ({
    type: 'jira',
    ...site,
    issue,
    blockingPeople: people.get(issue.id) ?? (blockedKeys(issue).length ? null : 0),
  }));
}

export async function jiraDelta(
  api: AtlassianClient,
  site: Site,
  cursor: string | null,
  now: number,
): Promise<DeltaResult<JiraRecord>> {
  const prev = parseCursor(cursor);
  if (!prev) return { records: [], cursor: startCursor(now) };
  const minutes = windowMinutes(prev, now);
  const tracker = new CursorTracker<JiraIssue>(
    prev,
    (i) => i.id,
    (i) => parseTime(i.fields.updated),
  );
  const records: JiraRecord[] = [];
  let token: string | undefined;
  let pages = 0;
  let more: boolean;
  do {
    const page = await search(api, site.cloudId, () => deltaJql(site.cloudId, minutes), {
      ...(token ? { nextPageToken: token } : {}),
    });
    pages++;
    const fresh = tracker.take(page.issues);
    if (fresh.length) records.push(...(await toRecords(api, site, fresh)));
    const next = page.isLast === true ? undefined : page.nextPageToken;
    // Guard against a token that does not advance (seen on the enhanced search endpoint).
    more = !!next && next !== token && page.issues.length > 0;
    token = next;
  } while (more && pages < MAX_PAGES);
  // Ordered by `updated` ascending, so the cursor is a safe resume point mid-way.
  return { records, cursor: tracker.cursor(), ...(more ? { hasMore: true } : {}) };
}

export async function jiraBackfill(
  api: AtlassianClient,
  site: Site,
  days: number,
  pageToken: string | undefined,
): Promise<BackfillPage<JiraRecord>> {
  const page = await search(api, site.cloudId, () => backfillJql(site.cloudId, days), {
    ...(pageToken ? { nextPageToken: pageToken } : {}),
  });
  const next = page.isLast === true ? null : (page.nextPageToken ?? null);
  return {
    records: await toRecords(api, site, page.issues),
    nextPageToken: next && next !== pageToken ? next : null,
  };
}

export function issueUrl(siteUrl: string | null, key: string): string | null {
  return siteUrl ? `${siteUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}` : null;
}

const labelValue = (s: string) => s.trim().replace(/\s+/g, ' ');

export function normalizeJira(r: JiraRecord): NormalizedItem {
  const { issue, me } = r;
  const f = issue.fields;
  const status = f.status?.name ?? null;
  const priority = f.priority?.name ?? null;
  const blocks = blockedKeys(issue).length;
  const assignedToMe = !!me && f.assignee?.accountId === me;

  const labels = [`jira:key:${issue.key}`];
  if (status) labels.push(`jira:status:${labelValue(status)}`);
  if (f.status?.statusCategory?.key)
    labels.push(`jira:status_category:${f.status.statusCategory.key}`);
  if (priority) labels.push(`jira:priority:${labelValue(priority)}`);
  if (f.issuetype?.name) labels.push(`jira:type:${labelValue(f.issuetype.name)}`);
  if (f.project?.key) labels.push(`jira:project:${f.project.key}`);
  if (assignedToMe) labels.push('jira:assignee:me');
  if (me && f.reporter?.accountId === me) labels.push('jira:reporter:me');
  if (blocks) labels.push(`jira:blocks:${blocks}`);
  if (r.blockingPeople) labels.push(`jira:blocking_people:${r.blockingPeople}`);

  const summaryParts = [
    status,
    priority ? `${priority} priority` : null,
    assignedToMe
      ? 'assigned to you'
      : f.assignee?.displayName
        ? `assigned to ${f.assignee.displayName}`
        : 'unassigned',
    r.blockingPeople
      ? `blocking ${r.blockingPeople} ${r.blockingPeople === 1 ? 'person' : 'people'}`
      : blocks
        ? `blocks ${blocks} ${blocks === 1 ? 'issue' : 'issues'}`
        : null,
  ].filter(Boolean);

  const comments = (f.comment?.comments ?? [])
    .slice()
    .sort((a, b) => parseTime(a.created) - parseTime(b.created));
  const latest = comments.slice(-COMMENTS_IN_BODY);
  const description = adfToText(f.description);
  const commentText = latest
    .map((c) => {
      const who = c.author?.displayName ?? 'Someone';
      return `${who} (${(c.created ?? '').slice(0, 10)}):\n${cap(adfToText(c.body), COMMENT_CAP)}`;
    })
    .join('\n\n');
  const body = cap(
    [description, commentText ? `Latest comments:\n\n${commentText}` : '']
      .filter(Boolean)
      .join('\n\n'),
    BODY_CAP,
  );

  const updated = parseTime(f.updated);
  const last = latest.at(-1);
  const reportedByMe = !!me && f.reporter?.accountId === me;
  // I reported it, or I wrote the latest comment.
  const fromMe = reportedByMe || (!!me && last?.author?.accountId === me);

  // Trusted signals, from issue metadata and ADF mention nodes only (never from text).
  const mentioned =
    adfMentions(f.description, me) ||
    comments.slice(-COMMENTS_FOR_MENTION).some((c) => adfMentions(c.body, me));
  if (assignedToMe) labels.push('hub:assigned');
  // People waiting on it when known, else the open issues it blocks.
  const waiting = r.blockingPeople || blocks;
  if (waiting) labels.push(`hub:blocking:${waiting}`);
  if (mentioned) labels.push('hub:mention');
  if (fromMe) labels.push('hub:from_me');

  return {
    kind: 'ticket',
    externalId: `jira:${issue.id}`,
    threadId: issue.key,
    author: f.reporter?.displayName ?? null,
    authorAddress: f.reporter?.emailAddress ?? null,
    title: `${issue.key}: ${f.summary ?? ''}`.trim(),
    summary: summaryParts.join(' · ') || null,
    body: body || null,
    url: issueUrl(r.siteUrl, issue.key),
    labels,
    receivedAt: new Date(Number.isFinite(updated) ? updated : Date.now()),
    fromMe,
  };
}

/** For tests. */
export function resetMentionFallback() {
  noMentionSearch.clear();
}
