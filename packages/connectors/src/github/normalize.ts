import type { NormalizedItem } from '../types';
import { repoOf, type GithubComment, type GithubIssue } from './client';

/** One issue or PR involving the user, with the context normalize needs. */
export type GithubRecord = {
  issue: GithubIssue;
  /** Found by `review-requested:@me`: a review from the user is pending. */
  reviewRequested: boolean;
  /** Found by `mentions:@me`: the user was @-mentioned. */
  mentioned?: boolean;
  /** Most recent comments, oldest first. Untrusted; never log. */
  comments: GithubComment[];
  /** The connected user. */
  me: { id: number; login: string };
};

export const BODY_CHARS = 16_000;
const COMMENT_CHARS = 2_000;
const SUMMARY_CHARS = 240;

export const githubItemId = (repo: string, n: number) => `${repo}#${n}`;

export function buildBody(issue: GithubIssue, comments: GithubComment[]): string | null {
  const parts: string[] = [];
  const main = (issue.body ?? '').trim();
  if (main) parts.push(main);
  if (comments.length) {
    parts.push('--- Recent comments ---');
    for (const c of comments) {
      const text = (c.body ?? '').trim().slice(0, COMMENT_CHARS);
      if (text) parts.push(`@${c.user?.login ?? 'ghost'} (${c.created_at}):\n${text}`);
    }
  }
  const body = parts.join('\n\n');
  if (!body) return null;
  return body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS - 1)}…` : body;
}

export function normalizeGithub(r: GithubRecord): NormalizedItem {
  const { issue } = r;
  const repo = repoOf(issue);
  const isPr = !!issue.pull_request;
  const merged = !!issue.pull_request?.merged_at;
  const state = merged ? 'merged' : issue.state;
  const labels = [
    `github:repo:${repo}`,
    `github:number:${issue.number}`,
    `github:type:${isPr ? 'pr' : 'issue'}`,
    `github:state:${state}`,
  ];
  const isMe = (u: { id: number } | null | undefined) =>
    !!u && Number.isFinite(r.me.id) && r.me.id > 0 && u.id === r.me.id;
  const assigned = !!issue.assignees?.some(isMe);
  const fromMe = isMe(issue.user);
  if (r.reviewRequested) labels.push('github:review_requested');
  if (assigned) labels.push('github:assigned');
  if (isPr && issue.draft) labels.push('github:draft');
  for (const l of issue.labels ?? []) {
    const name = typeof l === 'string' ? l : l.name;
    if (name) labels.push(`github:label:${name}`);
  }
  // Trusted signals, from GitHub's metadata and which search matched (never from text).
  if (r.reviewRequested && isPr && issue.state === 'open' && !merged) {
    labels.push('hub:review_requested');
  }
  if (assigned) labels.push('hub:assigned');
  if (r.mentioned) labels.push('hub:mention');
  if (fromMe) labels.push('hub:from_me');
  const body = buildBody(issue, r.comments);
  const main = (issue.body ?? '').trim();
  const id = githubItemId(repo, issue.number);
  return {
    kind: 'ticket',
    externalId: id,
    threadId: id,
    author: issue.user?.login ?? null,
    authorAddress: null,
    title: `${repo}#${issue.number} ${issue.title}`,
    summary: main ? main.replace(/\s+/g, ' ').slice(0, SUMMARY_CHARS) : null,
    body,
    url: issue.html_url,
    labels,
    receivedAt: new Date(issue.updated_at),
    fromMe,
  };
}
