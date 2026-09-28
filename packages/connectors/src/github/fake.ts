import { randomBytes } from 'node:crypto';
import { defaultFakePath, JsonFileStore, type Store } from '../lib/fake';
import type { FetchFn } from '../lib/http';

/**
 * Fake GitHub for CONNECTORS_FAKE=1 (local demo) and tests: a JSON store at
 * `<repo>/.dev/fake-github.json` served through a fetch that speaks the GitHub REST shapes
 * (token endpoint, /user, /user/installations, /search/issues, comments), so the real
 * client, refresh, paging and normalize run unchanged. Synthetic content only.
 */

export type FakeGithubUser = { id: number; login: string; name: string };

export type FakeGithubInstallation = {
  id: number;
  account: { login: string; id: number; type: 'User' | 'Organization' };
  /** Logins that can see this installation (members who authorized the app). */
  users: string[];
  repos: string[];
  permissions: Record<string, string>;
};

export type FakeGithubComment = { id: number; author: string; body: string; createdAt: string };

export type FakeGithubIssue = {
  repo: string;
  number: number;
  type: 'issue' | 'pr';
  title: string;
  body: string;
  state: 'open' | 'closed';
  mergedAt: string | null;
  author: string;
  assignees: string[];
  reviewers: string[];
  mentions: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: FakeGithubComment[];
};

export type FakeGithubState = {
  version: 1;
  connectCounter: number;
  nextId: number;
  users: FakeGithubUser[];
  installations: FakeGithubInstallation[];
  issues: FakeGithubIssue[];
  /** Logins whose grant was revoked: refresh and API calls fail. */
  revoked: string[];
};

const iso = (ms: number) =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export function seedFakeGithub(now = Date.now()): FakeGithubState {
  const h = (n: number) => iso(now - n * 3600_000);
  const READ = { issues: 'read', pull_requests: 'read', metadata: 'read' };
  return {
    version: 1,
    connectCounter: 0,
    nextId: 5000,
    users: [
      { id: 1001, login: 'alexkim', name: 'Alex Kim' },
      { id: 1002, login: 'priyar', name: 'Priya Raman' },
      { id: 1003, login: 'sam-oss', name: 'Sam Lee' },
    ],
    installations: [
      {
        id: 7001,
        account: { login: 'acme', id: 9001, type: 'Organization' },
        users: ['alexkim', 'priyar'],
        repos: ['acme/web', 'acme/api'],
        permissions: READ,
      },
      {
        id: 7002,
        account: { login: 'sam-oss', id: 1003, type: 'User' },
        users: ['sam-oss'],
        repos: ['sam-oss/tool'],
        permissions: READ,
      },
    ],
    revoked: [],
    issues: [
      {
        repo: 'acme/web',
        number: 42,
        type: 'pr',
        title: 'Add pricing page',
        body: 'Adds the new pricing page. @alexkim can you review the copy?',
        state: 'open',
        mergedAt: null,
        author: 'priyar',
        assignees: [],
        reviewers: ['alexkim'],
        mentions: ['alexkim'],
        labels: ['frontend'],
        createdAt: h(30),
        updatedAt: h(2),
        comments: [{ id: 4001, author: 'priyar', body: 'Rebased on main.', createdAt: h(2) }],
      },
      {
        repo: 'acme/api',
        number: 17,
        type: 'issue',
        title: 'Rate limit the export endpoint',
        body: 'Exports can take the API down. Proposal: 10 per minute per user.',
        state: 'open',
        mergedAt: null,
        author: 'alexkim',
        assignees: ['alexkim'],
        reviewers: [],
        mentions: [],
        labels: ['bug'],
        createdAt: h(50),
        updatedAt: h(20),
        comments: [],
      },
      {
        repo: 'sam-oss/tool',
        number: 3,
        type: 'issue',
        title: 'Crash on empty config',
        body: 'Running with an empty file crashes.',
        state: 'open',
        mergedAt: null,
        author: 'sam-oss',
        assignees: [],
        reviewers: [],
        mentions: [],
        labels: [],
        createdAt: h(10),
        updatedAt: h(9),
        comments: [],
      },
    ],
  };
}

export function fakeGithubStore(file = defaultFakePath('github')): Store<FakeGithubState> {
  return new JsonFileStore<FakeGithubState>(file, () => seedFakeGithub());
}

export function pickFakeUser(store: Store<FakeGithubState>, hint?: string): FakeGithubUser {
  return store.update((s) => {
    const byHint = hint ? s.users.find((u) => u.login === hint.toLowerCase()) : undefined;
    if (byHint) return byHint;
    // Round-robin over users that have an installation, so the demo has data.
    const withInstall = s.users.filter((u) =>
      s.installations.some((i) => i.users.includes(u.login)),
    );
    const pool = withInstall.length ? withInstall : s.users;
    const u = pool[s.connectCounter % pool.length]!;
    s.connectCounter++;
    return u;
  });
}

export const involves = (i: FakeGithubIssue, login: string) =>
  i.author === login ||
  i.assignees.includes(login) ||
  i.mentions.includes(login) ||
  i.comments.some((c) => c.author === login);

/** Opens an issue or PR, requests a review, or comments. Used by `fake:github`. */
export function fakeGithubAction(
  store: Store<FakeGithubState>,
  p:
    | {
        kind: 'open';
        repo: string;
        title: string;
        body: string;
        by: string;
        assignee?: string;
        pr?: boolean;
      }
    | {
        kind: 'review';
        repo: string;
        number?: number;
        title?: string;
        by: string;
        reviewer: string;
      }
    | { kind: 'comment'; repo: string; number: number; body: string; by: string },
  now = Date.now(),
): { issue: FakeGithubIssue; installationId: number } {
  return store.update((s) => {
    const inst = s.installations.find((i) => i.repos.includes(p.repo));
    if (!inst) throw new Error(`no fake installation covers ${p.repo}`);
    const t = iso(now);
    const nextNumber = () =>
      Math.max(0, ...s.issues.filter((i) => i.repo === p.repo).map((i) => i.number)) + 1;
    const mentionsIn = (text: string) =>
      [...text.matchAll(/@([a-z0-9-]+)/gi)].map((m) => m[1]!.toLowerCase());
    let issue: FakeGithubIssue | undefined;
    if (p.kind === 'open' || (p.kind === 'review' && p.number === undefined)) {
      const body = p.kind === 'open' ? p.body : `Please review, @${p.reviewer}.`;
      issue = {
        repo: p.repo,
        number: nextNumber(),
        type: p.kind === 'review' || p.pr ? 'pr' : 'issue',
        title: p.title ?? 'Untitled',
        body,
        state: 'open',
        mergedAt: null,
        author: p.by,
        assignees: p.kind === 'open' && p.assignee ? [p.assignee] : [],
        reviewers: p.kind === 'review' ? [p.reviewer] : [],
        mentions: mentionsIn(body),
        labels: [],
        createdAt: t,
        updatedAt: t,
        comments: [],
      };
      s.issues.push(issue);
    } else {
      const n = p.number;
      issue = s.issues.find((i) => i.repo === p.repo && i.number === n);
      if (!issue) throw new Error(`no fake issue ${p.repo}#${n}`);
      if (p.kind === 'review') {
        if (issue.type !== 'pr') throw new Error(`${p.repo}#${n} is not a pull request`);
        if (!issue.reviewers.includes(p.reviewer)) issue.reviewers.push(p.reviewer);
      } else {
        issue.comments.push({ id: s.nextId++, author: p.by, body: p.body, createdAt: t });
        for (const m of mentionsIn(p.body)) if (!issue.mentions.includes(m)) issue.mentions.push(m);
      }
      issue.updatedAt = t;
    }
    return { issue, installationId: inst.id };
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const ACCESS_TTL = 8 * 3600_000;

/** Access tokens embed their expiry so the fake can answer 401 once they lapse, like GitHub. */
function issueTokens(login: string, now: number) {
  const exp = now + ACCESS_TTL;
  return {
    access_token: `fake-gh.${login}.${exp}.${randomBytes(6).toString('hex')}`,
    expires_in: ACCESS_TTL / 1000,
    refresh_token: `fake-ghr.${login}.${randomBytes(6).toString('hex')}`,
    refresh_token_expires_in: 15_897_600,
    scope: '',
    token_type: 'bearer',
  };
}

export function fakeGithubFetch(
  store: Store<FakeGithubState>,
  now: () => number = Date.now,
): FetchFn {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const s = store.read();

    if (
      url.host === 'github.com' &&
      method === 'POST' &&
      url.pathname === '/login/oauth/access_token'
    ) {
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      if (form.get('grant_type') === 'refresh_token') {
        const m = /^fake-ghr\.([^.]+)\./.exec(form.get('refresh_token') ?? '');
        if (!m || s.revoked.includes(m[1]!)) return json(200, { error: 'bad_refresh_token' });
        return json(200, issueTokens(m[1]!, now()));
      }
      const m = /^fake-github:(.+)$/.exec(form.get('code') ?? '');
      const user = m ? s.users.find((u) => u.login === m[1]) : undefined;
      if (!user) return json(200, { error: 'bad_verification_code' });
      if (s.revoked.includes(user.login))
        store.update((st) => void (st.revoked = st.revoked.filter((x) => x !== user.login)));
      return json(200, issueTokens(user.login, now()));
    }
    if (
      url.host === 'api.github.com' &&
      method === 'DELETE' &&
      /^\/applications\/[^/]+\/grant$/.test(url.pathname)
    ) {
      return new Response(null, { status: 204 });
    }

    const auth = /^Bearer fake-gh\.([^.]+)\.(\d+)\./.exec(headers.get('authorization') ?? '');
    const me = auth ? s.users.find((u) => u.login === auth[1]) : undefined;
    if (!me || s.revoked.includes(me.login) || Number(auth![2]) <= now()) {
      return json(401, { message: 'Bad credentials', status: '401' });
    }
    const insts = s.installations.filter((i) => i.users.includes(me.login));
    const visible = new Set(insts.flatMap((i) => i.repos));
    const path = url.pathname;
    const pageOf = <T>(all: T[]) => {
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      return all.slice((page - 1) * per, page * per);
    };

    if (method === 'GET' && path === '/user')
      return json(200, { id: me.id, login: me.login, name: me.name, type: 'User' });
    if (method === 'GET' && path === '/user/installations') {
      const all = insts.map((i) => ({
        id: i.id,
        account: i.account,
        repository_selection: 'selected',
        permissions: i.permissions,
        app_slug: 'hub-fake',
      }));
      return json(200, { total_count: all.length, installations: pageOf(all) });
    }
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (method === 'GET' && repos) {
      const inst = insts.find((i) => i.id === Number(repos[1]));
      if (!inst) return json(404, { message: 'Not Found' });
      const all = inst.repos.map((r, i) => ({
        id: inst.id * 100 + i,
        full_name: r,
        private: true,
      }));
      return json(200, { total_count: all.length, repositories: pageOf(all) });
    }
    if (method === 'GET' && path === '/search/issues') {
      const q = url.searchParams.get('q') ?? '';
      const type = /\bis:(issue|pr)\b/.exec(q)?.[1];
      if (!type)
        return json(422, {
          message: 'Validation Failed: issues and pull requests need separate queries',
        });
      const since = /updated:>=(\S+)/.exec(q)?.[1];
      const rr = /review-requested:@me/.test(q);
      const inv = /involves:@me/.test(q);
      const men = /mentions:@me/.test(q);
      const found = s.issues
        .filter((i) => visible.has(i.repo) && i.type === type)
        .filter((i) => (!since || i.updatedAt >= since) && (!rr || i.reviewers.includes(me.login)))
        .filter((i) => !inv || involves(i, me.login))
        .filter((i) => !men || i.mentions.includes(me.login))
        .sort(
          (a, b) =>
            (url.searchParams.get('order') === 'desc' ? -1 : 1) *
            a.updatedAt.localeCompare(b.updatedAt),
        );
      const items = pageOf(found).map((i) => toSearchItem(s, i));
      return json(200, { total_count: found.length, incomplete_results: false, items });
    }
    const comments = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (method === 'GET' && comments) {
      const issue = s.issues.find(
        (i) => i.repo === comments[1] && i.number === Number(comments[2]),
      );
      if (!issue || !visible.has(issue.repo)) return json(404, { message: 'Not Found' });
      return json(
        200,
        pageOf(issue.comments).map((c) => ({
          id: c.id,
          user: userRef(s, c.author),
          body: c.body,
          created_at: c.createdAt,
        })),
      );
    }
    return json(404, { message: 'Not Found' });
  }) as FetchFn;
}

const userRef = (s: FakeGithubState, login: string) => ({
  login,
  id: s.users.find((u) => u.login === login)?.id ?? 0,
});

function toSearchItem(s: FakeGithubState, i: FakeGithubIssue) {
  const kind = i.type === 'pr' ? 'pull' : 'issues';
  return {
    id: Number(`${i.number}${i.repo.length}`),
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    user: userRef(s, i.author),
    assignees: i.assignees.map((a) => userRef(s, a)),
    labels: i.labels.map((name) => ({ name })),
    comments: i.comments.length,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    closed_at: null,
    html_url: `https://github.com/${i.repo}/${kind}/${i.number}`,
    repository_url: `https://api.github.com/repos/${i.repo}`,
    ...(i.type === 'pr'
      ? {
          draft: false,
          pull_request: {
            url: `https://api.github.com/repos/${i.repo}/pulls/${i.number}`,
            html_url: `https://github.com/${i.repo}/pull/${i.number}`,
            merged_at: i.mergedAt,
          },
        }
      : {}),
  };
}
