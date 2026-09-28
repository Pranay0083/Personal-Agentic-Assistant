import { ConnectorError } from '../errors';
import type { Store } from '../lib/fake';
import type { FetchFn } from '../lib/http';
import {
  accessToken,
  authorizeUrl,
  createHttp,
  exchangeCode,
  toTokens,
  type OAuth2Config,
} from '../lib';
import type { Connector, ConnectorContext, ConnectorInfo, SubscriptionInfo } from '../types';
import {
  createGithubClient,
  repoOf,
  type GithubClient,
  type GithubInstallation,
  type GithubIssue,
} from './client';
import {
  GITHUB_API,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  githubConfigFromEnv,
  githubInstallUrl,
  githubWebhookSecret,
  type GithubConfig,
} from './config';
import { fakeGithubFetch, fakeGithubStore, pickFakeUser, type FakeGithubState } from './fake';
import { githubItemId, normalizeGithub, type GithubRecord } from './normalize';
import { verifyGithubWebhook } from './webhook';

export const GITHUB_INFO: ConnectorInfo = {
  name: 'GitHub',
  covers: 'Only repos you pick',
  multiAccountNote: 'One sign-in per GitHub user. You pick repos when you install the Hub app.',
  sources: [
    {
      id: 'work',
      label: 'Issues and pull requests',
      hint: 'Assigned, review requested, mentioned or opened by you',
      kind: 'ticket',
      defaultOn: true,
    },
  ],
  options: [],
  writeActions: [],
};

export type GithubConnectorOptions = {
  config?: GithubConfig | (() => GithubConfig);
  /** Replaces the network (tests replay recorded fixtures through mockFetch). */
  fetch?: FetchFn;
  fakeStore?: Store<FakeGithubState>;
  /** Re-scan window for search-index lag (default 10 min). */
  overlapMs?: number;
  /** Items (with comments) returned per fetchDelta call; the rest come with hasMore. */
  maxItemsPerRun?: number;
  /** Search pages per query per delta run (the API serves at most 1000 results). */
  maxSearchPages?: number;
  searchPageSize?: number;
  /** Most recent comments added to the body. */
  commentCount?: number;
  now?: () => number;
};

/** Delta cursor: newest processed `updated_at` plus items already synced in the overlap window. */
export type GithubCursor = { t: string; seen: Record<string, string> };

export function parseGithubCursor(s: string): GithubCursor {
  try {
    const v = JSON.parse(s) as Partial<GithubCursor>;
    if (typeof v.t === 'string') return { t: v.t, seen: v.seen ?? {} };
  } catch {
    // A bare timestamp.
  }
  if (!Number.isFinite(Date.parse(s))) throw new ConnectorError('github', 'bad delta cursor');
  return { t: s, seen: {} };
}

/** `2026-09-28T10:00:00Z`: the search API's timestamp form. */
const searchTime = (ms: number) =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** A search hit plus the trusted signals the query that found it proves. */
type Found = { issue: GithubIssue; reviewRequested: boolean; mentioned: boolean };

export type WorkQuery = { q: string; reviewRequested: boolean; mentioned: boolean };

/**
 * With a user access token of a GitHub App, one search can't mix issues and PRs;
 * `involves:` (author, assignee, mentions, commenter) doesn't cover review requests and
 * doesn't say *why* an item matched. `mentions:@me` is a subset of `involves:` that proves
 * an @-mention (usually one page, so two cheap extra calls); `review-requested:@me` proves
 * a pending review request.
 */
export function workQueries(since: string): WorkQuery[] {
  const q = (s: string, flags: Partial<WorkQuery> = {}): WorkQuery => ({
    q: `${s} updated:>=${since}`,
    reviewRequested: false,
    mentioned: false,
    ...flags,
  });
  return [
    q('is:issue involves:@me'),
    q('is:pr involves:@me'),
    q('is:issue mentions:@me', { mentioned: true }),
    q('is:pr mentions:@me', { mentioned: true }),
    q('is:pr review-requested:@me', { reviewRequested: true }),
  ];
}

const WRITE_LEVELS = new Set(['write', 'admin']);

export function createGithubConnector(opts: GithubConnectorOptions = {}): Connector<GithubRecord> {
  const cfg = (): GithubConfig =>
    typeof opts.config === 'function' ? opts.config() : (opts.config ?? githubConfigFromEnv());
  const now = opts.now ?? Date.now;
  const overlap = opts.overlapMs ?? 10 * 60_000;
  const perRun = opts.maxItemsPerRun ?? 50;
  const maxPages = opts.maxSearchPages ?? 10;
  const pageSize = opts.searchPageSize ?? 100;
  const commentCount = opts.commentCount ?? 5;
  let store: Store<FakeGithubState> | undefined = opts.fakeStore;
  const fakeStore = () => (store ??= fakeGithubStore());

  const fetchFor = (c: GithubConfig): FetchFn | undefined =>
    opts.fetch ?? (c.fake ? fakeGithubFetch(fakeStore(), now) : undefined);

  const oauth = (c: GithubConfig): OAuth2Config => {
    const f = fetchFor(c);
    return {
      provider: 'github',
      authorizeUrl: GITHUB_AUTHORIZE_URL,
      tokenUrl: GITHUB_TOKEN_URL,
      clientId: c.clientId ?? (c.fake ? 'fake-github-client' : ''),
      clientSecret: c.clientSecret ?? (c.fake ? 'fake-github-secret-key' : ''),
      ...(f ? { fetch: f } : {}),
    };
  };

  const clientWith = (token: string): GithubClient => {
    const f = fetchFor(cfg());
    return createGithubClient({ token, ...(f ? { fetch: f } : {}), now });
  };

  /** Refreshes the 8-hour user token when needed (saved via ctx.saveTokens) and builds a client. */
  async function clientFor(ctx: ConnectorContext): Promise<GithubClient> {
    return clientWith(await accessToken(oauth(cfg()), ctx, now()));
  }

  function me(ctx: ConnectorContext) {
    const id = Number(ctx.externalId);
    const login = typeof ctx.meta?.login === 'string' ? ctx.meta.login : '';
    return { id, login };
  }

  /** Repos the user's installations of the app cover, read live (installs change). */
  async function allowedRepos(client: GithubClient): Promise<Set<string>> {
    const out = new Set<string>();
    for (const inst of await client.installations()) {
      for (const r of await client.installationRepos(inst.id)) out.add(r.full_name);
    }
    return out;
  }

  async function recentComments(client: GithubClient, issue: GithubIssue) {
    const total = issue.comments ?? 0;
    if (!total || commentCount <= 0) return [];
    const lastPage = Math.max(1, Math.ceil(total / commentCount));
    const page = await client.comments(repoOf(issue), issue.number, lastPage, commentCount);
    return page.slice(-commentCount);
  }

  async function toRecords(
    ctx: ConnectorContext,
    client: GithubClient,
    found: Found[],
  ): Promise<GithubRecord[]> {
    const who = me(ctx);
    const out: GithubRecord[] = [];
    for (const f of found) {
      out.push({ ...f, comments: await recentComments(client, f.issue), me: who });
    }
    return out;
  }

  const initialCursor = () =>
    JSON.stringify({ t: searchTime(now()), seen: {} } satisfies GithubCursor);

  async function subscribe(): Promise<SubscriptionInfo> {
    // App webhooks are configured once on the GitHub App, not per account.
    return { externalSubId: null, expiresAt: null, cursor: initialCursor() };
  }

  return {
    provider: 'github',
    info: GITHUB_INFO,
    configured() {
      const c = cfg();
      return c.fake || (!!c.clientId && !!c.clientSecret && !!c.appSlug);
    },

    connect: {
      authUrl({ state, redirectUri, access, loginHint }) {
        if (access !== 'read') throw new ConnectorError('github', 'GitHub is read-only in Hub');
        const c = cfg();
        if (c.fake) {
          const u = new URL(redirectUri);
          u.searchParams.set('code', `fake-github:${pickFakeUser(fakeStore(), loginHint).login}`);
          u.searchParams.set('state', state);
          return u.toString();
        }
        // No scopes: a GitHub App's permissions are set on the app (read-only Issues, PRs, Metadata).
        return authorizeUrl(oauth(c), {
          state,
          redirectUri,
          extra: { prompt: 'select_account', ...(loginHint ? { login: loginHint } : {}) },
        });
      },

      async exchange({ code, redirectUri, access }) {
        if (access === 'write') throw new ConnectorError('github', 'GitHub is read-only in Hub');
        const c = cfg();
        const tokens = toTokens(await exchangeCode(oauth(c), { code, redirectUri }), now());
        const client = clientWith(tokens.accessToken);
        const user = await client.user();
        const installations: GithubInstallation[] = await client.installations();
        const granted = new Set<string>();
        for (const inst of installations) {
          for (const [perm, level] of Object.entries(inst.permissions ?? {})) {
            if (WRITE_LEVELS.has(level)) {
              throw new ConnectorError(
                'github',
                `the GitHub App has ${level} access to ${perm}; Hub needs a read-only app`,
              );
            }
            granted.add(`${perm}:${level}`);
          }
        }
        const externalId = String(user.id);
        const meta = {
          login: user.login,
          installations: installations.map((i) => ({
            id: i.id,
            account: i.account?.login ?? null,
          })),
          grantedScopes: [...granted].sort(),
          needsInstall: installations.length === 0,
          installUrl: githubInstallUrl(c),
        };
        return {
          tokens,
          externalId,
          displayName: user.login,
          identities: [
            {
              externalId,
              displayName: user.login,
              routeKeys: installations.map((i) => String(i.id)),
              meta,
            },
          ],
        };
      },

      async revoke(tokens) {
        const o = oauth(cfg());
        const http = createHttp({
          provider: 'github',
          baseUrl: GITHUB_API,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        const basic = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64');
        // Deletes the user's authorization of the app (all its tokens). 404/422 = already gone.
        await http.request(`/applications/${encodeURIComponent(o.clientId)}/grant`, {
          method: 'DELETE',
          body: { access_token: tokens.accessToken },
          headers: { authorization: `Basic ${basic}`, accept: 'application/vnd.github+json' },
          allow: [404, 422],
        });
      },
    },

    subscribe,
    renew: subscribe,

    async verifyWebhook(req) {
      return verifyGithubWebhook(req, githubWebhookSecret(cfg()));
    },

    async fetchDelta(ctx) {
      if (!ctx.cursor) return { records: [], cursor: initialCursor() };
      const cur = parseGithubCursor(ctx.cursor);
      const client = await clientFor(ctx);
      const repos = await allowedRepos(client);
      if (repos.size === 0) return { records: [], cursor: ctx.cursor };

      const since = searchTime(Date.parse(cur.t) - overlap);
      const found = new Map<string, Found>();
      let capAt: string | null = null;
      for (const query of workQueries(since)) {
        for (let page = 1; ; page++) {
          const res = await client.search(query.q, page, pageSize);
          for (const issue of res.items) {
            const key = githubItemId(repoOf(issue), issue.number);
            const prev = found.get(key);
            found.set(key, {
              issue,
              reviewRequested: query.reviewRequested || !!prev?.reviewRequested,
              mentioned: query.mentioned || !!prev?.mentioned,
            });
          }
          const done = res.items.length < pageSize || page * pageSize >= res.total_count;
          if (done) break;
          if (page >= maxPages) {
            // Results beyond this query's last item were not read: stop the run there.
            const last = res.items.at(-1)!.updated_at;
            if (!capAt || last < capAt) capAt = last;
            break;
          }
        }
      }

      const fresh = [...found.entries()]
        .filter(([, f]) => repos.has(repoOf(f.issue)))
        .filter(([key, f]) => cur.seen[key] !== f.issue.updated_at)
        .filter(([, f]) => !capAt || f.issue.updated_at <= capAt)
        .sort(([, a], [, b]) => a.issue.updated_at.localeCompare(b.issue.updated_at));
      const batch = fresh.slice(0, perRun);
      const records = await toRecords(
        ctx,
        client,
        batch.map(([, f]) => f),
      );

      const last = batch.at(-1)?.[1].issue.updated_at;
      const t = last && Date.parse(last) > Date.parse(cur.t) ? last : cur.t;
      const keepFrom = Date.parse(t) - overlap;
      const seen: Record<string, string> = {};
      for (const [key, at] of Object.entries(cur.seen))
        if (Date.parse(at) >= keepFrom) seen[key] = at;
      for (const [key, f] of batch) seen[key] = f.issue.updated_at;
      return {
        records,
        cursor: JSON.stringify({ t, seen } satisfies GithubCursor),
        ...(fresh.length > batch.length || capAt ? { hasMore: true } : {}),
      };
    },

    /** pageToken = `<query index>:<page>` over the work queries. */
    async backfill(ctx, { days, pageToken }) {
      const client = await clientFor(ctx);
      const repos = await allowedRepos(client);
      if (repos.size === 0) return { records: [], nextPageToken: null };
      const [qi, page] = (pageToken ?? '0:1').split(':').map(Number) as [number, number];
      const queries = workQueries(searchTime(now() - days * 86400_000));
      const query = queries[qi];
      if (!query) return { records: [], nextPageToken: null };
      const per = Math.min(pageSize, 50);
      const res = await client.search(query.q, page, per);
      const keep = res.items.filter((i) => repos.has(repoOf(i)));
      const records = await toRecords(
        ctx,
        client,
        keep.map((issue) => ({
          issue,
          reviewRequested: query.reviewRequested,
          mentioned: query.mentioned,
        })),
      );
      const more = res.items.length === per && page * per < Math.min(res.total_count, 1000);
      const next = more ? `${qi}:${page + 1}` : qi + 1 < queries.length ? `${qi + 1}:1` : null;
      return { records, nextPageToken: next };
    },

    normalize: (raw) => normalizeGithub(raw),
  };
}
