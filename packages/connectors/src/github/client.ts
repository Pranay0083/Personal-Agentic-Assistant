import { createHttp, type FetchFn } from '../lib/http';
import { GITHUB_API, GITHUB_API_VERSION } from './config';

export type GithubUser = { id: number; login: string; name?: string | null; type?: string };

export type GithubInstallation = {
  id: number;
  account: { login: string; id?: number; type?: string } | null;
  repository_selection?: 'all' | 'selected';
  permissions?: Record<string, string>;
  app_slug?: string;
};

export type GithubRepo = { id: number; full_name: string; private?: boolean };

/** An issue or PR as returned by the search API. */
export type GithubIssue = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  user: { login: string; id: number } | null;
  assignees?: { login: string; id: number }[];
  labels?: ({ name?: string } | string)[];
  comments?: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  html_url: string;
  repository_url: string;
  draft?: boolean;
  pull_request?: { url?: string; html_url?: string; merged_at?: string | null };
};

export type GithubComment = {
  id: number;
  user: { login: string; id: number } | null;
  body?: string | null;
  created_at: string;
};

export type SearchResult = {
  total_count: number;
  incomplete_results: boolean;
  items: GithubIssue[];
};

/**
 * GitHub answers a primary or secondary rate limit with 403 (or 429) plus rate-limit headers.
 * Rewrites those to 429 with Retry-After so the lib raises a RetryableError the queue backs off on.
 */
export function rateLimitAware(base: FetchFn, now = Date.now): FetchFn {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    const res = await base(input, init);
    if (res.status !== 403 && res.status !== 429) return res;
    const retryAfter = res.headers.get('retry-after');
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (!retryAfter && remaining !== '0') return res;
    const secs =
      retryAfter ??
      String(Number.isFinite(reset) ? Math.max(1, Math.ceil(reset - now() / 1000)) : 60);
    return new Response(null, { status: 429, headers: { 'retry-after': secs } });
  }) as FetchFn;
}

export function createGithubClient(opts: { token: string; fetch?: FetchFn; now?: () => number }) {
  const http = createHttp({
    provider: 'github',
    baseUrl: GITHUB_API,
    fetch: rateLimitAware(opts.fetch ?? fetch, opts.now),
    headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION },
  });
  const get = <T>(path: string, query?: Record<string, string | number | undefined>) =>
    http.request<T>(path, { token: opts.token, ...(query ? { query } : {}) });

  async function allPages<T>(path: string, key: string, max = 10): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= max; page++) {
      const res = await get<Record<string, unknown>>(path, { per_page: 100, page });
      const items = (res[key] ?? []) as T[];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  return {
    user: () => get<GithubUser>('/user'),
    installations: () => allPages<GithubInstallation>('/user/installations', 'installations'),
    installationRepos: (id: number) =>
      allPages<GithubRepo>(`/user/installations/${id}/repositories`, 'repositories', 20),
    search: (q: string, page: number, perPage: number) =>
      get<SearchResult>('/search/issues', {
        q,
        sort: 'updated',
        order: 'asc',
        per_page: perPage,
        page,
      }),
    comments: (repo: string, n: number, page: number, perPage: number) =>
      get<GithubComment[]>(`/repos/${repo}/issues/${n}/comments`, { per_page: perPage, page }),
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;

/** `owner/name` from `https://api.github.com/repos/owner/name`. */
export function repoOf(issue: Pick<GithubIssue, 'repository_url'>): string {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url);
  return m ? m[1]! : issue.repository_url;
}
