import { randomBytes } from 'node:crypto';
import type { FetchFn } from '../lib/http';
import type { OAuthTokens } from '../types';
import type { AdfNode } from './text';
import { READ_SCOPES, WRITE_SCOPES, ATLASSIAN_SCOPES } from './config';
import {
  jiraTimestamp,
  type FakeAtlassianState,
  type FakeAtlassianStore,
  type FakeIssue,
  type FakePage,
  type FakeSite,
} from './fake-store';

/**
 * A fake Atlassian served as a `fetch`: the real connector code (token exchange, search,
 * webhooks, writes) runs unchanged against it. Tokens are checked like Atlassian would:
 * read endpoints need a read-consent token, write endpoints a write-consent token.
 */

export const FAKE_STATUSES = [
  { transitionId: '11', id: '1', name: 'To Do', category: 'new' },
  { transitionId: '21', id: '3', name: 'In Progress', category: 'indeterminate' },
  { transitionId: '31', id: '10001', name: 'In Review', category: 'indeterminate' },
  { transitionId: '41', id: '10002', name: 'Done', category: 'done' },
] as const;

type Kind = 'r' | 'w';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const noContent = () => new Response(null, { status: 204 });
const err = (status: number, message: string) =>
  json({ errorMessages: [message], errors: {} }, status);

function newTokens(kind: Kind): OAuthTokens & { scope: string } {
  return {
    accessToken: `fake-atl-access.${kind}.${randomBytes(6).toString('hex')}`,
    refreshToken: `fake-atl-refresh.${kind}.${randomBytes(6).toString('hex')}`,
    expiresAt: Date.now() + 3600_000,
    scope: (kind === 'w' ? WRITE_SCOPES : READ_SCOPES).join(' '),
  };
}

function tokenResponse(t: OAuthTokens & { scope: string }) {
  return {
    access_token: t.accessToken,
    refresh_token: t.refreshToken,
    expires_in: 3600,
    scope: t.scope,
    token_type: 'Bearer',
  };
}

/** Fake consent screen: redirects straight back with a code. */
export function fakeAuthUrl(opts: {
  state: string;
  redirectUri: string;
  access: 'read' | 'write';
}) {
  const url = new URL(opts.redirectUri);
  url.searchParams.set('code', `fake-atl:${opts.access}`);
  url.searchParams.set('state', opts.state);
  return url.toString();
}

function person(s: FakeAtlassianState, id: string | null | undefined) {
  if (!id) return null;
  const p = s.people[id];
  return {
    accountId: id,
    displayName: p?.displayName ?? 'Unknown',
    ...(p?.emailAddress ? { emailAddress: p.emailAddress } : {}),
    active: true,
  };
}

function siteScopes(site: FakeSite, kind: Kind): string[] {
  if (kind === 'w') return site.products.includes('jira') ? [ATLASSIAN_SCOPES.jiraWrite] : [];
  const out: string[] = [];
  if (site.products.includes('jira'))
    out.push(ATLASSIAN_SCOPES.jiraRead, ATLASSIAN_SCOPES.jiraUser, ATLASSIAN_SCOPES.jiraWebhooks);
  if (site.products.includes('confluence'))
    out.push(ATLASSIAN_SCOPES.confluenceRead, ATLASSIAN_SCOPES.confluenceSearch);
  return out;
}

function mentions(doc: unknown, id: string): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const n = doc as AdfNode;
  if (n.type === 'mention' && n.attrs?.id === id) return true;
  return (n.content ?? []).some((c) => mentions(c, id));
}

function involves(issue: FakeIssue, me: string): boolean {
  const f = issue.fields;
  return (
    f.assignee === me ||
    f.reporter === me ||
    issue.watchers.includes(me) ||
    mentions(f.description, me) ||
    f.comment.comments.some((c) => mentions(c.body, me))
  );
}

const parseJiraTime = (t: string) => Date.parse(t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

function relativeFloor(q: string, now: number): number | null {
  const m = /(?:updated|lastmodified)\s*>=\s*(?:now\(")?-(\d+)([mhd])/i.exec(q);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return now - n * (unit === 'm' ? 60_000 : unit === 'h' ? 3600_000 : 86400_000);
}

function serveIssue(s: FakeAtlassianState, site: FakeSite, i: FakeIssue, fields?: string[]) {
  const all: Record<string, unknown> = {
    ...i.fields,
    assignee: person(s, i.fields.assignee),
    reporter: person(s, i.fields.reporter),
    comment: {
      comments: i.fields.comment.comments.map((c) => serveComment(s, c)),
      total: i.fields.comment.comments.length,
      maxResults: i.fields.comment.comments.length,
      startAt: 0,
    },
  };
  const picked =
    fields && fields.length && !fields.includes('*all')
      ? Object.fromEntries(Object.entries(all).filter(([k]) => fields.includes(k)))
      : all;
  return {
    id: i.id,
    key: i.key,
    self: `https://api.atlassian.com/ex/jira/${site.cloudId}/rest/api/3/issue/${i.id}`,
    fields: picked,
  };
}

function serveComment(
  s: FakeAtlassianState,
  c: FakeIssue['fields']['comment']['comments'][number],
  withProps = false,
) {
  return {
    id: c.id,
    author: person(s, c.author),
    body: c.body,
    created: c.created,
    updated: c.updated,
    ...(withProps ? { properties: c.properties ?? [] } : {}),
  };
}

function servePage(s: FakeAtlassianState, p: FakePage) {
  const u = (id: string) => {
    const x = person(s, id);
    return x
      ? { accountId: x.accountId, displayName: x.displayName, publicName: x.displayName }
      : null;
  };
  return {
    id: p.id,
    type: p.type,
    status: p.status,
    title: p.title,
    space: p.space,
    history: { createdBy: u(p.history.createdBy), createdDate: p.history.createdDate },
    version: { when: p.version.when, number: p.version.number, by: u(p.version.by) },
    body: { storage: p.body.storage },
    _links: p._links,
  };
}

export type FakeFetchOptions = { now?: () => number };

export function fakeAtlassianFetch(
  store: FakeAtlassianStore,
  opts: FakeFetchOptions = {},
): FetchFn {
  const now = opts.now ?? Date.now;

  return (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === 'string' && init.body
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    // --- OAuth token endpoint -----------------------------------------------------------
    if (url.host === 'auth.atlassian.com' && url.pathname === '/oauth/token' && method === 'POST') {
      if (body.grant_type === 'authorization_code') {
        const m = /^fake-atl:(read|write)$/.exec(String(body.code ?? ''));
        if (!m) return json({ error: 'invalid_grant' }, 400);
        store.update((s) => {
          s.revoked = false;
        });
        return json(tokenResponse(newTokens(m[1] === 'write' ? 'w' : 'r')));
      }
      if (body.grant_type === 'refresh_token') {
        const m = /^fake-atl-refresh\.([rw])\./.exec(String(body.refresh_token ?? ''));
        if (!m || store.read().revoked) return json({ error: 'invalid_grant' }, 400);
        // Rotating refresh tokens, like Atlassian.
        return json(tokenResponse(newTokens(m[1] as Kind)));
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.host !== 'api.atlassian.com') return err(404, 'not found');

    // --- Auth -------------------------------------------------------------------------
    const bearer = /^Bearer (fake-atl-access\.([rw])\.[0-9a-f]+)$/.exec(
      headers.get('authorization') ?? '',
    );
    const state = store.read();
    if (!bearer || state.revoked) return err(401, 'Unauthorized');
    const kind = bearer[2] as Kind;
    const needs = (k: Kind) => kind === k;
    const scopeError = () => err(401, 'Unauthorized; scope does not match');

    if (url.pathname === '/oauth/token/accessible-resources') {
      return json(
        state.sites
          .map((site) => ({
            id: site.cloudId,
            url: site.url,
            name: site.name,
            scopes: siteScopes(site, kind),
            avatarUrl:
              'https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png',
          }))
          .filter((r) => r.scopes.length),
      );
    }
    if (url.pathname === '/me') {
      return json({ ...state.user, picture: null, extended_profile: {} });
    }

    const m = /^\/ex\/(jira|confluence)\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) return err(404, 'not found');
    const [, product, cloudId, rest] = m as unknown as [string, string, string, string];
    const site = state.sites.find((x) => x.cloudId === cloudId);
    if (!site || !site.products.includes(product as 'jira' | 'confluence'))
      return err(404, 'Site not found');
    const me = state.user.account_id;

    if (product === 'confluence') {
      if (rest !== '/wiki/rest/api/search' || method !== 'GET') return err(404, 'not found');
      if (!needs('r')) return scopeError();
      const cql = url.searchParams.get('cql') ?? '';
      const floor = relativeFloor(cql, now());
      const desc = /DESC/i.test(cql);
      const pages = site.pages
        .filter(
          (p) =>
            p.history.createdBy === me ||
            (p.watchers ?? []).includes(me) ||
            (p.mentions ?? []).includes(me),
        )
        .filter((p) => floor === null || Date.parse(p.version.when) >= floor)
        .sort(
          (a, b) => (Date.parse(a.version.when) - Date.parse(b.version.when)) * (desc ? -1 : 1),
        );
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const start = Number(url.searchParams.get('cursor') ?? 0) || 0;
      const slice = pages.slice(start, start + limit);
      const next = start + limit < pages.length ? start + limit : null;
      return json({
        results: slice.map((p) => ({
          content: servePage(state, p),
          title: p.title,
          lastModified: p.version.when,
        })),
        start,
        limit,
        size: slice.length,
        totalSize: pages.length,
        _links: {
          base: `${site.url}/wiki`,
          context: '/wiki',
          ...(next !== null
            ? {
                next: `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}&cursor=${next}`,
              }
            : {}),
        },
      });
    }

    // --- Jira -------------------------------------------------------------------------
    const api = rest.replace(/^\/rest\/api\/3/, '');
    const writes = (fn: (s: FakeAtlassianState, site: FakeSite) => Response) =>
      store.update((s) =>
        fn(
          s,
          s.sites.find((x) => x.cloudId === cloudId)!,
        ),
      );

    if (api === '/search/jql' && method === 'POST') {
      if (!needs('r')) return scopeError();
      const jql = String(body.jql ?? '');
      const fields = Array.isArray(body.fields) ? (body.fields as string[]) : undefined;
      const keys = /key in \(([^)]*)\)/i
        .exec(jql)?.[1]
        ?.split(',')
        .map((k) => k.trim());
      let list: FakeIssue[];
      if (keys) {
        const missing = keys.filter((k) => !site.issues.some((i) => i.key === k));
        if (missing.length) return err(400, `An issue with key '${missing[0]}' does not exist.`);
        list = site.issues.filter((i) => keys.includes(i.key));
      } else {
        const floor = relativeFloor(jql, now());
        const desc = /ORDER BY updated DESC/i.test(jql);
        list = site.issues
          .filter((i) => involves(i, me))
          .filter((i) => floor === null || parseJiraTime(i.fields.updated) >= floor)
          .sort(
            (a, b) =>
              (parseJiraTime(a.fields.updated) - parseJiraTime(b.fields.updated)) * (desc ? -1 : 1),
          );
      }
      const size = Math.min(Number(body.maxResults ?? 50) || 50, 100);
      const start = Number(body.nextPageToken ?? 0) || 0;
      const slice = list.slice(start, start + size);
      const more = start + size < list.length;
      return json({
        issues: slice.map((i) => serveIssue(state, site, i, fields)),
        ...(more ? { nextPageToken: String(start + size) } : {}),
        isLast: !more,
      });
    }

    if (api === '/webhook') {
      if (!needs('r')) return scopeError();
      if (method === 'GET') {
        return json({
          values: site.webhooks ?? [],
          isLast: true,
          startAt: 0,
          maxResults: 100,
          total: (site.webhooks ?? []).length,
        });
      }
      if (method === 'POST') {
        return writes((s, st) => {
          st.webhooks ??= [];
          const hooks = (body.webhooks as { jqlFilter: string; events: string[] }[]) ?? [];
          const results = hooks.map((h) => {
            if (st.webhooks!.length >= 5) return { errors: ['Maximum number of webhooks reached'] };
            const id = Number(allocId(s));
            st.webhooks!.push({
              id,
              url: String(body.url),
              jqlFilter: h.jqlFilter,
              events: h.events,
              expirationDate: new Date(now() + 30 * 86400_000).toISOString(),
            });
            return { createdWebhookId: id };
          });
          return json({ webhookRegistrationResult: results });
        });
      }
      if (method === 'DELETE') {
        const ids = (body.webhookIds as number[]) ?? [];
        return writes((_s, st) => {
          st.webhooks = (st.webhooks ?? []).filter((h) => !ids.includes(h.id));
          return new Response(null, { status: 202 });
        });
      }
    }
    if (api === '/webhook/refresh' && method === 'PUT') {
      if (!needs('r')) return scopeError();
      const ids = (body.webhookIds as number[]) ?? [];
      const expirationDate = new Date(now() + 30 * 86400_000).toISOString();
      return writes((_s, st) => {
        for (const h of st.webhooks ?? [])
          if (ids.includes(h.id)) h.expirationDate = expirationDate;
        return json({ expirationDate });
      });
    }

    const im = /^\/issue\/([^/]+)(\/.*)?$/.exec(api);
    if (im) {
      const key = decodeURIComponent(im[1]!);
      const sub = im[2] ?? '';
      const issue = site.issues.find((i) => i.key === key || i.id === key);
      if (!issue) return err(404, 'Issue does not exist or you do not have permission to see it.');

      if (sub === '' && method === 'GET') {
        if (!needs('r')) return scopeError();
        const f = url.searchParams.get('fields');
        return json(serveIssue(state, site, issue, f ? f.split(',') : undefined));
      }
      if (sub === '/transitions') {
        if (method === 'GET') {
          if (!needs('r')) return scopeError();
          return json({
            transitions: FAKE_STATUSES.filter((x) => x.name !== issue.fields.status.name).map(
              (x) => ({
                id: x.transitionId,
                name: x.name,
                to: { id: x.id, name: x.name, statusCategory: { key: x.category } },
              }),
            ),
          });
        }
        if (method === 'POST') {
          if (!needs('w')) return scopeError();
          const tid = String((body.transition as { id?: string } | undefined)?.id ?? '');
          const to = FAKE_STATUSES.find((x) => x.transitionId === tid);
          if (!to || to.name === issue.fields.status.name)
            return err(400, 'Transition is not valid.');
          return writes((s, st) => {
            const i = st.issues.find((x) => x.id === issue.id)!;
            const t = jiraTimestamp(now());
            i.fields.status = {
              id: to.id,
              name: to.name,
              statusCategory: { key: to.category, name: to.name },
            };
            i.fields.updated = t;
            const add = (body.update as { comment?: { add?: { body?: unknown } }[] } | undefined)
              ?.comment?.[0]?.add?.body;
            if (add)
              i.fields.comment.comments.push({
                id: allocId(s),
                author: me,
                created: t,
                updated: t,
                body: add,
              });
            return noContent();
          });
        }
      }
      if (sub === '/comment') {
        if (method === 'GET') {
          if (!needs('r')) return scopeError();
          const withProps = (url.searchParams.get('expand') ?? '').includes('properties');
          const all = issue.fields.comment.comments.map((c) => serveComment(state, c, withProps));
          if (url.searchParams.get('orderBy') === '-created') all.reverse();
          const max = Number(url.searchParams.get('maxResults') ?? 50);
          return json({
            comments: all.slice(0, max),
            startAt: 0,
            maxResults: max,
            total: all.length,
          });
        }
        if (method === 'POST') {
          if (!needs('w')) return scopeError();
          return writes((s, st) => {
            const i = st.issues.find((x) => x.id === issue.id)!;
            const t = jiraTimestamp(now());
            const c = {
              id: allocId(s),
              author: me,
              created: t,
              updated: t,
              body: body.body,
              properties: (body.properties as { key: string; value: unknown }[]) ?? [],
            };
            i.fields.comment.comments.push(c);
            i.fields.updated = t;
            return json(serveComment(s, c), 201);
          });
        }
      }
      const pm = /^\/properties\/([^/]+)$/.exec(sub);
      if (pm) {
        const prop = decodeURIComponent(pm[1]!);
        if (method === 'GET') {
          if (!needs('r')) return scopeError();
          const v = issue.properties?.[prop];
          return v === undefined
            ? err(404, 'The property was not found.')
            : json({ key: prop, value: v });
        }
        if (method === 'PUT') {
          if (!needs('w')) return scopeError();
          return writes((_s, st) => {
            const i = st.issues.find((x) => x.id === issue.id)!;
            const existed = !!i.properties && prop in i.properties;
            i.properties = { ...(i.properties ?? {}), [prop]: body };
            return existed ? json(null, 200) : json(null, 201);
          });
        }
      }
    }
    return err(404, 'not found');
  }) as FetchFn;
}

export function allocId(s: FakeAtlassianState): string {
  s.nextId = (s.nextId ?? 40000) + 1;
  return String(s.nextId);
}
