import { AccountFilters } from '@hub/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectorError,
  MissingScopeError,
  ReconnectRequiredError,
  RetryableError,
} from '../errors';
import { sha256Hex } from '../lib/crypto';
import { fixture, mockFetch } from '../lib/fake';
import {
  enabledSources,
  identitiesOf,
  type ConnectorContext,
  type ExecuteResult,
  type OAuthTokens,
} from '../types';
import type { AtlassianConfig } from './config';
import { createAtlassianConnector, type AtlassianRecord } from './connector';
import type { ConfluenceContent as ConfluencePage } from './api-types';
import { parseCursor, type TimeCursor } from './cursor';
import { execPropertyKey } from './execute';
import { resetMentionFallback, type JiraRecord } from './jira';
import { signJwt } from './webhooks';

const fx = <T = unknown>(name: string) => fixture<T>(import.meta.url, name);

const CLOUD = '1a2b3c4d-0000-4000-8000-00000000a001';
const ME = '5b10ac8d82e05b22cc7d4ef5';
const NOW = Date.parse('2026-09-28T10:10:00.000Z');
const JIRA = `/ex/jira/${CLOUD}/rest/api/3`;
const WIKI = `/ex/confluence/${CLOUD}/wiki/rest/api`;

const config: AtlassianConfig = {
  fake: false,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  gatewayUrl: 'https://gw.example',
};

type Routes = Parameters<typeof mockFetch>[0];

/** One route answering a sequence of recorded responses (the last one repeats). */
class Seq {
  constructor(readonly items: unknown[]) {}
}
const seq = (...responses: unknown[]) => new Seq(responses);

function setup(routes: Routes) {
  const seqs = new Map<string, unknown[]>();
  const plain: Routes = {};
  for (const [k, v] of Object.entries(routes)) {
    if (v instanceof Seq) seqs.set(k, [...v.items]);
    else plain[k] = v;
  }
  const base = mockFetch(plain);
  const fetch = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
    const list = seqs.get(key);
    if (!list) return base.fetch(input, init);
    const one = mockFetch({ [key]: list.length > 1 ? list.shift() : list[0] });
    const res = await one.fetch(input, init);
    base.calls.push(one.calls[0]!);
    return res;
  }) as typeof globalThis.fetch;
  const connector = createAtlassianConnector({ config, fetch, now: () => NOW });
  return { connector, calls: base.calls };
}

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext & { saved: OAuthTokens[] } {
  const saved: OAuthTokens[] = [];
  return {
    accountId: 'acc-1',
    externalId: CLOUD,
    tokens: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 },
    saveTokens: async (t) => {
      saved.push(t);
    },
    source: 'jira',
    cursor: null,
    filters: AccountFilters.parse({}),
    meta: { cloudId: CLOUD, siteUrl: 'https://acme.atlassian.net', atlassianAccountId: ME },
    subscription: null,
    saved,
    ...over,
  };
}

const bodyOf = (c: { body: string | undefined }) =>
  JSON.parse(c.body ?? '{}') as Record<string, unknown>;

beforeEach(() => resetMentionFallback());

describe('connect', () => {
  it('builds the consent URL with audience, prompt=consent and read scopes only', () => {
    const { connector } = setup({});
    const u = new URL(
      connector.connect.authUrl({
        state: 's1',
        redirectUri: 'https://api.example/cb',
        access: 'read',
      }),
    );
    expect(u.origin + u.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(u.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(u.searchParams.get('prompt')).toBe('consent');
    const scopes = u.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual(
      expect.arrayContaining([
        'read:jira-work',
        'read:confluence-content.all',
        'read:me',
        'offline_access',
      ]),
    );
    expect(scopes.some((s) => s.startsWith('write:'))).toBe(false);

    const w = new URL(
      connector.connect.authUrl({
        state: 's2',
        redirectUri: 'https://api.example/cb',
        access: 'write',
      }),
    );
    expect(w.searchParams.get('scope')!.split(' ').sort()).toEqual(
      ['offline_access', 'read:me', 'write:jira-work'].sort(),
    );
  });

  it('exchanges one consent into one identity per site sharing the grant', async () => {
    const { connector, calls } = setup({
      'POST /oauth/token': fx('token.json'),
      'GET /oauth/token/accessible-resources': fx('accessible-resources.json'),
      'GET /me': fx('me.json'),
    });
    const r = await connector.connect.exchange({
      code: 'c1',
      redirectUri: 'https://api.example/cb',
      access: 'read',
    });
    const ids = identitiesOf(r);
    expect(ids.map((i) => i.externalId)).toEqual([CLOUD, '1a2b3c4d-0000-4000-8000-00000000b002']);
    expect(r.externalId).toBe(CLOUD);
    expect(ids[0]).toMatchObject({
      displayName: 'acme',
      routeKeys: [CLOUD],
      meta: {
        cloudId: CLOUD,
        siteUrl: 'https://acme.atlassian.net',
        siteName: 'acme',
        atlassianAccountId: ME,
        products: ['jira', 'confluence'],
      },
    });
    expect(ids[1]!.meta!.products).toEqual(['jira']);
    expect(r.tokens.refreshToken).toBe('eyJraWQiOiJmYWtlIn0.refresh-1.sig');

    // Sources follow what each site granted: the second site has no Confluence.
    const f = { sources: {} };
    expect(enabledSources(connector.info, f, ids[0]!.meta)).toEqual(['jira', 'confluence']);
    expect(enabledSources(connector.info, f, ids[1]!.meta)).toEqual(['jira']);

    const token = bodyOf(calls[0]!);
    expect(token).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c1',
      client_id: 'client-id',
      redirect_uri: 'https://api.example/cb',
    });
    expect(calls[1]!.headers.authorization).toMatch(/^Bearer /);
  });

  it('checks scopes: read grants must not carry write scopes, write grants need write:jira-work', async () => {
    const withScope = (scope: string) =>
      setup({
        'POST /oauth/token': { ...fx<Record<string, unknown>>('token.json'), scope },
        'GET /oauth/token/accessible-resources': fx('accessible-resources.json'),
        'GET /me': fx('me.json'),
      }).connector;
    const read = fx<{ scope: string }>('token.json').scope;
    const ex = (scope: string, access: 'read' | 'write') =>
      withScope(scope).connect.exchange({ code: 'c', redirectUri: 'https://x/cb', access });

    await expect(ex(`${read} write:jira-work`, 'read')).rejects.toThrow(/write scopes/);
    await expect(ex(`${read} manage:jira-project`, 'read')).rejects.toBeInstanceOf(ConnectorError);
    await expect(ex(read.replace('read:me', ''), 'read')).rejects.toBeInstanceOf(MissingScopeError);
    await expect(ex('read:me offline_access', 'read')).rejects.toBeInstanceOf(MissingScopeError);
    // Confluence-only consent is fine; manage:jira-webhook is allowed in a read grant.
    await expect(
      ex('read:confluence-content.all search:confluence read:me offline_access', 'read'),
    ).resolves.toBeTruthy();
    await expect(ex('read:me offline_access', 'write')).rejects.toBeInstanceOf(MissingScopeError);
    await expect(ex('write:jira-work read:me offline_access', 'write')).resolves.toBeTruthy();
  });

  it('maps a refused code to a 400 connector error', async () => {
    const { connector } = setup({
      'POST /oauth/token': { status: 400, body: { error: 'invalid_grant' } },
    });
    const e = (await connector.connect
      .exchange({ code: 'bad', redirectUri: 'https://x/cb' })
      .catch((x: unknown) => x)) as ConnectorError;
    expect(e).toBeInstanceOf(ConnectorError);
    expect(e).not.toBeInstanceOf(ReconnectRequiredError);
    expect(e.status).toBe(400);
  });
});

describe('jira delta', () => {
  const prev: TimeCursor = {
    v: 1,
    t: '2026-09-28T10:00:00.000Z',
    seen: { '10477': Date.parse('2026-09-28T10:00:00.000Z') },
  };

  it('starts from now without fetching when there is no cursor', async () => {
    const { connector, calls } = setup({});
    const r = await connector.fetchDelta(ctx());
    expect(r.records).toEqual([]);
    expect(parseCursor(r.cursor)!.t).toBe(new Date(NOW).toISOString());
    expect(calls).toHaveLength(0);
  });

  it('pages the enhanced search with an overlap window and dedupes what it already saw', async () => {
    const { connector, calls } = setup({
      [`POST ${JIRA}/search/jql`]: seq(
        fx('search-page-1.json'),
        fx('search-blocked-assignees.json'),
        fx('search-page-2.json'),
      ),
    });
    const r = await connector.fetchDelta(ctx({ cursor: JSON.stringify(prev) }));
    const keys = (r.records as JiraRecord[]).map((x) => x.issue.key);
    expect(keys).toEqual(['PROJ-482', 'PROJ-500']);
    expect(r.hasMore).toBeUndefined();

    const [first, blocked, second] = calls.map(bodyOf);
    // 10:10 - 10:00 + 1 minute overlap.
    expect(first!.jql).toBe(
      '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser() OR description ~ currentUser() OR comment ~ currentUser()) AND updated >= -11m ORDER BY updated ASC',
    );
    expect(first!.nextPageToken).toBeUndefined();
    expect(first!.fields).toEqual(
      expect.arrayContaining(['status', 'priority', 'assignee', 'issuelinks']),
    );
    expect(blocked!.jql).toBe('key in (PROJ-490,PROJ-491)');
    expect(second!.nextPageToken).toBe('CAEaAggB');

    const next = parseCursor(r.cursor)!;
    expect(next.t).toBe('2026-09-28T10:06:30.000Z');
    // PROJ-482 (10:05:00) is older than the new overlap floor; PROJ-500 is remembered.
    expect(next.seen).toEqual({ '10500': Date.parse('2026-09-28T10:06:30.000Z') });

    const rec = r.records[0] as JiraRecord;
    expect(rec.blockingPeople).toBe(2);
    expect(rec).toMatchObject({ cloudId: CLOUD, me: ME, siteUrl: 'https://acme.atlassian.net' });
  });

  it('does not re-emit an issue that comes back in the overlap unchanged', async () => {
    const page = fx<{ issues: unknown[] }>('search-page-2.json');
    const { connector } = setup({ [`POST ${JIRA}/search/jql`]: page });
    const cursor = JSON.stringify({
      v: 1,
      t: '2026-09-28T10:06:30.000Z',
      seen: { '10500': Date.parse('2026-09-28T10:06:30.000Z') },
    });
    const r = await connector.fetchDelta(ctx({ cursor }));
    expect(r.records).toEqual([]);
    expect(parseCursor(r.cursor)!.t).toBe('2026-09-28T10:06:30.000Z');
  });

  it('drops the mention clauses when the site rejects them', async () => {
    const { connector, calls } = setup({
      [`POST ${JIRA}/search/jql`]: seq(
        { status: 400, body: { errorMessages: ['bad'] } },
        fx('search-page-2.json'),
      ),
    });
    const r = await connector.fetchDelta(ctx({ cursor: JSON.stringify(prev) }));
    expect(r.records).toHaveLength(1);
    expect(bodyOf(calls[1]!).jql).toBe(
      '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -11m ORDER BY updated ASC',
    );
  });

  it('stops after a page budget and reports hasMore with a resumable cursor', async () => {
    const endless = { ...fx<Record<string, unknown>>('search-page-2.json'), isLast: false };
    let n = 0;
    const { connector } = setup({
      [`POST ${JIRA}/search/jql`]: {
        status: 200,
        body: () => ({ ...endless, nextPageToken: `t${n++}` }),
      },
    });
    const r = await connector.fetchDelta(ctx({ cursor: JSON.stringify(prev) }));
    expect(r.hasMore).toBe(true);
    expect(n).toBe(5);
    expect(parseCursor(r.cursor)!.t).toBe('2026-09-28T10:06:30.000Z');
  });

  it('backfills newest first with the next page token', async () => {
    const { connector, calls } = setup({
      [`POST ${JIRA}/search/jql`]: seq(
        fx('search-page-1.json'),
        fx('search-blocked-assignees.json'),
      ),
    });
    const r = await connector.backfill(ctx(), { days: 14 });
    expect(r.records).toHaveLength(2);
    expect(r.nextPageToken).toBe('CAEaAggB');
    expect(bodyOf(calls[0]!).jql).toMatch(/updated >= -14d ORDER BY updated DESC$/);
  });
});

describe('normalize', () => {
  it('turns a Jira issue into a ticket with status, priority and blocking info', () => {
    const { connector } = setup({});
    const issue = fx<{ issues: JiraRecord['issue'][] }>('search-page-1.json').issues[1]!;
    const item = connector.normalize({
      type: 'jira',
      cloudId: CLOUD,
      siteUrl: 'https://acme.atlassian.net',
      me: ME,
      issue,
      blockingPeople: 2,
    } satisfies AtlassianRecord)!;
    expect(item).toMatchObject({
      kind: 'ticket',
      externalId: 'jira:10482',
      threadId: 'PROJ-482',
      title: 'PROJ-482: Checkout fails when the promo code is applied twice',
      url: 'https://acme.atlassian.net/browse/PROJ-482',
      author: 'Priya Raman',
      summary: 'In Progress · High priority · assigned to you · blocking 2 people',
      fromMe: false,
    });
    expect(item.labels).toEqual(
      expect.arrayContaining([
        'jira:key:PROJ-482',
        'jira:status:In Progress',
        'jira:priority:High',
        'jira:assignee:me',
        'jira:blocks:2',
        'jira:blocking_people:2',
      ]),
    );
    expect(item.body).toContain('returns a 500 from the cart service');
    expect(item.body).toContain('Latest comments:');
    expect(item.body).toContain('Priya Raman (2026-09-28):\n@Alex Kim any update?');
    expect(item.receivedAt.toISOString()).toBe('2026-09-28T10:05:00.000Z');
  });

  it('turns a Confluence page into a note', () => {
    const { connector } = setup({});
    const page = fx<{ results: { content: never }[] }>('confluence-search.json').results[0]!
      .content;
    const item = connector.normalize({
      type: 'confluence',
      cloudId: CLOUD,
      siteUrl: 'https://acme.atlassian.net',
      me: ME,
      page,
    })!;
    expect(item).toMatchObject({
      kind: 'note',
      externalId: 'confluence:65601',
      title: 'Q3 launch plan',
      author: 'Priya Raman',
      url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/65601/Q3+launch+plan',
      summary: 'Engineering · edited by Priya Raman',
      fromMe: false,
    });
    expect(item.labels).toEqual([
      'confluence:page:65601',
      'confluence:space:ENG',
      'confluence:creator:me',
      'hub:mention',
    ]);
    expect(item.body).toContain('Ship checkout v2 by Oct 15');
  });

  describe('trusted hub: signals', () => {
    const issues = fx<{ issues: JiraRecord['issue'][] }>('search-page-1.json').issues;
    const jira = (issue: JiraRecord['issue'], blockingPeople: number | null = null) => {
      const item = setup({}).connector.normalize({
        type: 'jira',
        cloudId: CLOUD,
        siteUrl: null,
        me: ME,
        issue,
        blockingPeople,
      })!;
      return { item, hub: item.labels.filter((l) => l.startsWith('hub:')).sort() };
    };
    const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

    it('Jira: assigned, blocking (people when known), mention from ADF nodes', () => {
      const { item, hub } = jira(issues[1]!, 2);
      expect(hub).toEqual(['hub:assigned', 'hub:blocking:2', 'hub:mention']);
      expect(item.labels).toEqual(
        expect.arrayContaining([
          'jira:key:PROJ-482',
          'jira:status:In Progress',
          'jira:assignee:me',
        ]),
      );
      expect(item.fromMe).toBe(false);
    });

    it('Jira: falls back to the open blocks count when people are unknown', () => {
      const three = clone(issues[1]!);
      three.fields.issuelinks!.push({
        type: { name: 'Blocks', outward: 'blocks' },
        outwardIssue: {
          key: 'PROJ-600',
          fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } },
        },
      });
      expect(jira(three, null).hub).toContain('hub:blocking:3');
      // Done and non-"Blocks" links never count.
      const none = clone(issues[1]!);
      none.fields.issuelinks = none.fields.issuelinks!.slice(2);
      expect(jira(none, 0).hub.some((l) => l.startsWith('hub:blocking'))).toBe(false);
    });

    it('Jira: a name in plain text is not a mention', () => {
      const plain = clone(issues[1]!);
      plain.fields.comment!.comments = [
        {
          id: '1',
          author: { accountId: 'someone-else', displayName: 'Sam' },
          created: '2026-09-28T10:05:00.000+0000',
          body: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '@Alex Kim 5b10ac8d82e05b22cc7d4ef5 please look' }],
              },
            ],
          },
        },
      ];
      expect(jira(plain).hub).not.toContain('hub:mention');
      // A mention node for someone else does not count either.
      const other = clone(issues[1]!);
      other.fields.comment!.comments[1]!.body = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'mention', attrs: { id: 'someone-else', text: '@Sam' } }],
          },
        ],
      };
      expect(jira(other).hub).not.toContain('hub:mention');
      // Mention in the description counts.
      const desc = clone(plain);
      desc.fields.description = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'mention', attrs: { id: ME, text: '@Alex Kim' } }],
          },
        ],
      };
      expect(jira(desc).hub).toContain('hub:mention');
    });

    it('Jira: from_me when I reported it or wrote the latest comment', () => {
      const reported = jira(issues[0]!);
      expect(reported.hub).toEqual(['hub:from_me']);
      expect(reported.item.fromMe).toBe(true);

      const mine = clone(issues[1]!);
      mine.fields.comment!.comments.push({
        id: '30002',
        author: { accountId: ME, displayName: 'Alex Kim' },
        created: '2026-09-28T10:06:00.000+0000',
        body: { type: 'doc', version: 1, content: [] },
      });
      expect(jira(mine, 2).hub).toContain('hub:from_me');
    });

    it('Confluence: mention from user-link nodes, from_me when I was the last editor', () => {
      const page = fx<{ results: { content: ConfluencePage }[] }>('confluence-search.json')
        .results[0]!.content;
      const conf = (p: ConfluencePage) =>
        setup({})
          .connector.normalize({
            type: 'confluence',
            cloudId: CLOUD,
            siteUrl: null,
            me: ME,
            page: p,
          })!
          .labels.filter((l) => l.startsWith('hub:'));
      expect(conf(page)).toEqual(['hub:mention']);

      const edited = clone(page);
      edited.version!.by = { accountId: ME, displayName: 'Alex Kim' };
      edited.body!.storage!.value = '<p>Alex Kim 5b10ac8d82e05b22cc7d4ef5 wrote this</p>';
      expect(conf(edited)).toEqual(['hub:from_me']);
    });
  });

  it('ignores unknown records', () => {
    expect(setup({}).connector.normalize({ type: 'nope' } as never)).toBeNull();
  });
});

describe('confluence delta', () => {
  it('searches with CQL over a relative window and follows the next cursor', async () => {
    const { connector, calls } = setup({
      [`GET ${WIKI}/search`]: seq(fx('confluence-search.json'), { results: [], _links: {} }),
    });
    const cursor = JSON.stringify({ v: 1, t: '2026-09-28T09:40:00.000Z', seen: {} });
    const r = await connector.fetchDelta(ctx({ source: 'confluence', cursor }));
    expect(r.records).toHaveLength(1);
    const q = calls[0]!.url.searchParams;
    expect(q.get('cql')).toBe(
      'type = page AND (creator = currentUser() OR watcher = currentUser() OR mention = currentUser()) AND lastmodified >= now("-31m") ORDER BY lastmodified ASC',
    );
    expect(q.get('expand')).toContain('content.body.storage');
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('_f_MjU=_sa_WyJcdDY1NjAxIl0=');
    expect(parseCursor(r.cursor)!.t).toBe('2026-09-28T10:02:00.000Z');
  });

  it('is polled: subscribe registers nothing', async () => {
    const { connector, calls } = setup({});
    const s = await connector.subscribe(ctx({ source: 'confluence' }));
    expect(s).toMatchObject({ externalSubId: null, expiresAt: null, meta: { polling: true } });
    expect(calls).toHaveLength(0);
  });
});

describe('webhooks', () => {
  it('registers two JQL-filtered webhooks with a secret URL and stores only its hash', async () => {
    const { connector, calls } = setup({ [`POST ${JIRA}/webhook`]: fx('webhook-register.json') });
    const s = await connector.subscribe(ctx());
    const req = bodyOf(calls[0]!) as {
      url: string;
      webhooks: { jqlFilter: string; events: string[] }[];
    };
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe('https://gw.example/hooks/atlassian');
    const secret = url.searchParams.get('t')!;
    expect(url.searchParams.get('sub')).toBe(s.externalSubId);
    expect(req.webhooks.map((w) => w.jqlFilter)).toEqual([
      `assignee = "${ME}"`,
      `reporter = "${ME}"`,
    ]);
    expect(req.webhooks[0]!.events).toContain('comment_created');
    expect(s.meta).toEqual({
      secretHash: sha256Hex(secret),
      webhookIds: [1000, 1001],
      cloudId: CLOUD,
    });
    expect(JSON.stringify(s.meta)).not.toContain(secret);
    expect(s.expiresAt!.getTime()).toBe(NOW + 30 * 86400_000);
    expect(parseCursor(s.cursor)!.t).toBe(new Date(NOW).toISOString());
  });

  it('fails when Jira rejects every webhook', async () => {
    const { connector } = setup({
      [`POST ${JIRA}/webhook`]: {
        webhookRegistrationResult: [{ errors: ['limit'] }, { errors: ['limit'] }],
      },
    });
    await expect(connector.subscribe(ctx())).rejects.toThrow(/registration failed/);
  });

  const sub = {
    externalSubId: 'atl_abcdefghijklmnop',
    expiresAt: new Date(NOW),
    meta: { secretHash: 'h', webhookIds: [1000, 1001], cloudId: CLOUD },
  };

  it('renews by refreshing the existing webhooks', async () => {
    const { connector, calls } = setup({
      [`GET ${JIRA}/webhook`]: fx('webhook-list.json'),
      [`PUT ${JIRA}/webhook/refresh`]: fx('webhook-refresh.json'),
    });
    const r = await connector.renew(ctx({ subscription: sub }));
    expect(r).toEqual({
      externalSubId: sub.externalSubId,
      expiresAt: new Date('2026-10-28T10:10:00.000Z'),
      meta: sub.meta,
    });
    expect(bodyOf(calls[1]!)).toEqual({ webhookIds: [1000, 1001] });
    expect('cursor' in r).toBe(false);
  });

  it('re-registers when Jira dropped a webhook', async () => {
    const list = fx<{ values: unknown[] }>('webhook-list.json');
    const { connector, calls } = setup({
      [`GET ${JIRA}/webhook`]: { ...list, values: list.values.slice(0, 1) },
      [`DELETE ${JIRA}/webhook`]: { status: 202 },
      [`POST ${JIRA}/webhook`]: fx('webhook-register.json'),
    });
    const r = await connector.renew(ctx({ subscription: sub }));
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'POST']);
    expect(bodyOf(calls[1]!)).toEqual({ webhookIds: [1000] });
    expect(r.externalSubId).not.toBe(sub.externalSubId);
    expect(r.meta!.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect('cursor' in r).toBe(false);
  });

  it('unsubscribe deletes the webhooks', async () => {
    const { connector, calls } = setup({ [`DELETE ${JIRA}/webhook`]: { status: 202 } });
    await connector.unsubscribe!(ctx({ subscription: sub }));
    expect(bodyOf(calls[0]!)).toEqual({ webhookIds: [1000, 1001] });
  });

  const delivery = fx('webhook-delivery.json');
  const req = (over: { headers?: Record<string, string>; query?: Record<string, string> } = {}) => {
    const sec = Math.floor(NOW / 1000);
    return {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signJwt({ iat: sec, exp: sec + 180 }, 'client-secret')}`,
        'x-atlassian-webhook-identifier': 'delivery-1',
        ...over.headers,
      },
      query: over.query ?? { sub: 'atl_abcdefghijklmnop', t: 'the-secret' },
      body: delivery,
      rawBody: JSON.stringify(delivery),
    };
  };

  it('accepts a delivery signed with the client secret and routes it by subscription', async () => {
    const { connector } = setup({});
    const r = await connector.verifyWebhook(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events).toEqual([
      {
        providerEventId: 'jira:atl_abcdefghijklmnop:delivery-1',
        externalSubId: 'atl_abcdefghijklmnop',
        source: 'jira',
        subscriptionSecret: 'the-secret',
        payload: {
          webhookEvent: 'jira:issue_updated',
          issueKey: 'PROJ-482',
          issueId: '10482',
          matchedWebhookIds: [1000],
          timestamp: 1790590200000,
        },
      },
    ]);
    // No issue text leaves the gateway in the event.
    expect(JSON.stringify(r.events)).not.toContain('promo');
  });

  it('rejects bad signatures, algorithms, expired tokens and missing parts', async () => {
    const { connector } = setup({});
    const sec = Math.floor(NOW / 1000);
    const bad = async (r: ReturnType<typeof req>) => {
      const v = await connector.verifyWebhook(r);
      return v.ok ? 'ok' : v.reason;
    };
    expect(
      await bad(
        req({ headers: { authorization: `Bearer ${signJwt({ exp: sec + 60 }, 'other')}` } }),
      ),
    ).toBe('bad token signature');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    expect(await bad(req({ headers: { authorization: `Bearer ${none}` } }))).toBe(
      'unexpected token algorithm',
    );
    expect(
      await bad(
        req({
          headers: { authorization: `Bearer ${signJwt({ exp: sec - 600 }, 'client-secret')}` },
        }),
      ),
    ).toBe('token expired');
    expect(await bad(req({ headers: { authorization: '' } }))).toBe('missing bearer token');
    expect(await bad(req({ query: { t: 'x' } }))).toBe('missing subscription');
    expect(await bad(req({ query: { sub: 'atl_abcdefghijklmnop' } }))).toBe('missing subscription');

    const unconfigured = createAtlassianConnector({
      config: { ...config, clientSecret: undefined },
      now: () => NOW,
    });
    const v = await unconfigured.verifyWebhook(req());
    expect(v.ok).toBe(false);
  });
});

describe('execute', () => {
  const transition = {
    issueKey: 'PROJ-482',
    transitionId: '31',
    toStatus: 'In Review',
    comment: 'Fix merged in #219, ready for QA.',
  };
  const prop = `${JIRA}/issue/PROJ-482/properties/${execPropertyKey('key-1')}`;

  it('transitions with a comment and records the idempotency property', async () => {
    const { connector, calls } = setup({
      [`POST ${JIRA}/issue/PROJ-482/transitions`]: { status: 204 },
      [`PUT ${prop}`]: { status: 201 },
    });
    const r = await connector.execute!(ctx(), 'jira.transition', transition, 'key-1');
    expect(r).toMatchObject({ externalId: 'PROJ-482', toStatus: 'In Review' });
    // The pending marker is written before the transition.
    expect(calls[0]!.url.pathname).toBe(prop);
    expect(bodyOf(calls[0]!)).toMatchObject({ action: 'jira.transition', state: 'pending' });
    expect(bodyOf(calls[0]!).result).toBeUndefined();
    const body = bodyOf(calls[1]!) as {
      transition: { id: string };
      update: { comment: { add: { body: { type: string } } }[] };
    };
    expect(body.transition).toEqual({ id: '31' });
    expect(body.update.comment[0]!.add.body.type).toBe('doc');
    expect(calls[2]!.url.pathname).toBe(prop);
    expect(execPropertyKey('key-1')).toMatch(/^hub\.exec\.[0-9a-f]{32}$/);
    expect(bodyOf(calls[2]!)).toMatchObject({
      action: 'jira.transition',
      result: { externalId: 'PROJ-482' },
    });
  });

  it('falls back to a separate comment when the transition screen has no comment field', async () => {
    const { connector, calls } = setup({
      [`POST ${JIRA}/issue/PROJ-482/transitions`]: seq({ status: 400, body: {} }, { status: 204 }),
      [`POST ${JIRA}/issue/PROJ-482/comment`]: { status: 201, body: fx('comment-created.json') },
      [`PUT ${prop}`]: { status: 200 },
    });
    await connector.execute!(ctx(), 'jira.transition', transition, 'key-1');
    expect(calls.map((c) => `${c.method} ${c.url.pathname.split('/').slice(-1)[0]}`)).toEqual([
      `PUT ${execPropertyKey('key-1')}`,
      'POST transitions',
      'POST transitions',
      `PUT ${execPropertyKey('key-1')}`,
      'POST comment',
      `PUT ${execPropertyKey('key-1')}`,
    ]);
    expect(bodyOf(calls[2]!).update).toBeUndefined();
    // Progress is recorded between the transition and the separate comment.
    expect(bodyOf(calls[3]!)).toMatchObject({ state: 'transitioned' });
    expect(bodyOf(calls[5]!)).toMatchObject({ result: { externalId: 'PROJ-482' } });
  });

  it('resumes a crash between the transition and its separate comment: comment only', async () => {
    const posted = {
      ...fx<Record<string, unknown>>('comment-created.json'),
      properties: [{ key: 'hub.exec', value: { k: sha256Hex('key-1').slice(0, 32) } }],
    };
    let commented = false;
    const { connector, calls } = setup({
      [`GET ${prop}`]: {
        key: 'x',
        value: { action: 'jira.transition', at: 'x', state: 'transitioned' },
      },
      [`GET ${JIRA}/issue/PROJ-482/comment`]: {
        status: 200,
        body: () => ({ comments: commented ? [posted] : [], startAt: 0, maxResults: 50 }),
      },
      [`POST ${JIRA}/issue/PROJ-482/comment`]: {
        status: 201,
        body: () => {
          commented = true;
          return fx('comment-created.json');
        },
      },
      [`POST ${JIRA}/issue/PROJ-482/transitions`]: { status: 204 },
      [`PUT ${prop}`]: { status: 200 },
    });
    // A new process: the lookup (read token) finds the progress but no comment.
    expect(await connector.findExecuted!(ctx(), 'jira.transition', 'key-1', transition)).toBeNull();
    const r = await connector.execute!(ctx(), 'jira.transition', transition, 'key-1');
    expect(r).toMatchObject({ externalId: 'PROJ-482', toStatus: 'In Review' });
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => c.url.pathname);
    expect(writes).toEqual([`${JIRA}/issue/PROJ-482/comment`, prop]);
    // The comment exists now: a further lookup reports done.
    expect(
      await connector.findExecuted!(ctx(), 'jira.transition', 'key-1', transition),
    ).toMatchObject({ externalId: 'PROJ-482', commentId: '30010' });
  });

  it('comments in ADF with a comment marker', async () => {
    const { connector, calls } = setup({
      [`POST ${JIRA}/issue/PROJ-482/comment`]: { status: 201, body: fx('comment-created.json') },
      [`PUT ${prop}`]: { status: 201 },
    });
    const r = await connector.execute!(
      ctx(),
      'jira.comment',
      { issueKey: 'PROJ-482', body: 'Looking now.' },
      'key-1',
    );
    expect(r).toEqual({ externalId: '30010', issueKey: 'PROJ-482', commentId: '30010' });
    const body = bodyOf(calls[0]!) as {
      body: unknown;
      properties: { key: string; value: { k: string } }[];
    };
    expect(body.body).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looking now.' }] }],
    });
    expect(body.properties[0]).toEqual({
      key: 'hub.exec',
      value: { k: sha256Hex('key-1').slice(0, 32) },
    });
  });

  it('validates payloads and actions', async () => {
    const { connector, calls } = setup({});
    await expect(
      connector.execute!(ctx(), 'jira.transition', { issueKey: 'bad key' }, 'k'),
    ).rejects.toThrow();
    await expect(connector.execute!(ctx(), 'jira.delete', {}, 'k')).rejects.toBeInstanceOf(
      ConnectorError,
    );
    expect(calls).toHaveLength(0);
  });

  it('findExecuted reads the property, then the status or the comment marker', async () => {
    type Find = (
      c: ConnectorContext,
      a: string,
      k: string,
      p?: Record<string, unknown>,
    ) => Promise<ExecuteResult | null>;

    // Property present.
    let m = setup({
      [`GET ${prop}`]: {
        key: 'x',
        value: {
          action: 'jira.transition',
          at: 'x',
          result: { externalId: 'PROJ-482', toStatus: 'In Review' },
        },
      },
    });
    let f = m.connector.findExecuted as Find;
    expect(await f(ctx(), 'jira.transition', 'key-1', transition)).toMatchObject({
      externalId: 'PROJ-482',
    });

    // No property, but the issue is already in the target status: that alone proves
    // nothing (someone else may have moved it), so it is not executed.
    const inReview = {
      id: '10482',
      key: 'PROJ-482',
      fields: { status: { name: 'In Review' }, updated: 'x' },
    };
    m = setup({
      [`GET ${prop}`]: { status: 404 },
      [`GET ${JIRA}/issue/PROJ-482`]: inReview,
    });
    f = m.connector.findExecuted as Find;
    expect(await f(ctx(), 'jira.transition', 'key-1', transition)).toBeNull();

    // Our pending marker (crash between the transition and the final marker) plus the
    // target status: done.
    m = setup({
      [`GET ${prop}`]: {
        key: 'x',
        value: { action: 'jira.transition', at: 'x', state: 'pending' },
      },
      [`GET ${JIRA}/issue/PROJ-482`]: inReview,
    });
    f = m.connector.findExecuted as Find;
    expect(await f(ctx(), 'jira.transition', 'key-1', transition)).toMatchObject({
      alreadyInStatus: true,
    });

    // Pending marker, not in the target status: not executed.
    m = setup({
      [`GET ${prop}`]: {
        key: 'x',
        value: { action: 'jira.transition', at: 'x', state: 'pending' },
      },
      [`GET ${JIRA}/issue/PROJ-482`]: {
        id: '10482',
        key: 'PROJ-482',
        fields: { status: { name: 'In Progress' }, updated: 'x' },
      },
    });
    f = m.connector.findExecuted as Find;
    expect(await f(ctx(), 'jira.transition', 'key-1', transition)).toBeNull();

    // Comment posted but the marker property was never written (crash in between).
    const posted = {
      ...fx<Record<string, unknown>>('comment-created.json'),
      properties: [{ key: 'hub.exec', value: { k: sha256Hex('key-1').slice(0, 32) } }],
    };
    m = setup({
      [`GET ${prop}`]: { status: 404 },
      [`GET ${JIRA}/issue/PROJ-482/comment`]: {
        comments: [posted],
        startAt: 0,
        maxResults: 50,
        total: 1,
      },
    });
    f = m.connector.findExecuted as Find;
    expect(await f(ctx(), 'jira.comment', 'key-1', { issueKey: 'PROJ-482', body: 'x' })).toEqual({
      externalId: '30010',
      issueKey: 'PROJ-482',
      commentId: '30010',
    });
    expect(m.calls[1]!.url.searchParams.get('expand')).toBe('properties');

    // Without the payload it refuses to answer "not sent".
    await expect(f(ctx(), 'jira.comment', 'unknown-key')).rejects.toBeInstanceOf(ConnectorError);
  });

  it('remembers targets it executed, so a same-process lookup works without the payload', async () => {
    const { connector } = setup({
      [`POST ${JIRA}/issue/PROJ-482/transitions`]: { status: 204 },
      [`PUT ${prop}`]: { status: 201 },
      [`GET ${prop}`]: {
        key: 'x',
        value: { action: 'jira.transition', at: 'x', result: { externalId: 'PROJ-482' } },
      },
    });
    await connector.execute!(ctx(), 'jira.transition', transition, 'key-1');
    expect(await connector.findExecuted!(ctx(), 'jira.transition', 'key-1')).toMatchObject({
      externalId: 'PROJ-482',
    });
  });
});

describe('tokens and errors', () => {
  it('refreshes an expiring token and saves the rotated refresh token', async () => {
    const { connector, calls } = setup({
      'POST /oauth/token': fx('token-refresh.json'),
      [`GET ${JIRA}/webhook`]: fx('webhook-list.json'),
      [`PUT ${JIRA}/webhook/refresh`]: fx('webhook-refresh.json'),
    });
    const c = ctx({
      tokens: { accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() + 10_000 },
      subscription: {
        externalSubId: 'atl_abcdefghijklmnop',
        expiresAt: null,
        meta: { secretHash: 'h', webhookIds: [1000, 1001] },
      },
    });
    await connector.renew(c);
    expect(bodyOf(calls[0]!)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-id',
    });
    expect(c.saved).toHaveLength(1);
    expect(c.saved[0]!.refreshToken).toBe('eyJraWQiOiJmYWtlIn0.refresh-2-rotated.sig');
    expect(calls[1]!.headers.authorization).toBe(
      'Bearer eyJraWQiOiJmYWtlIiwiYWxnIjoiUlMyNTYifQ.read-access-2.sig',
    );
  });

  it('refreshes once on a 401 and retries', async () => {
    const { connector, calls } = setup({
      'POST /oauth/token': fx('token-refresh.json'),
      [`POST ${JIRA}/search/jql`]: seq(
        { status: 401, body: fx('error-401.json') },
        fx('search-page-2.json'),
      ),
    });
    const c = ctx({ cursor: JSON.stringify({ v: 1, t: '2026-09-28T10:00:00.000Z', seen: {} }) });
    const r = await connector.fetchDelta(c);
    expect(r.records).toHaveLength(1);
    expect(c.saved[0]!.refreshToken).toBe('eyJraWQiOiJmYWtlIn0.refresh-2-rotated.sig');
    expect(calls.map((x) => x.method)).toEqual(['POST', 'POST', 'POST']);
  });

  it('on a 401 picks up a token a sibling already rotated instead of refreshing', async () => {
    const { connector, calls } = setup({
      'POST /oauth/token': { status: 400, body: { error: 'invalid_grant' } },
      [`POST ${JIRA}/search/jql`]: seq(
        { status: 401, body: fx('error-401.json') },
        fx('search-page-2.json'),
      ),
    });
    const stored = {
      accessToken: 'at-sibling',
      refreshToken: 'rt-sibling',
      expiresAt: Date.now() + 3600_000,
    };
    const c = ctx({
      cursor: JSON.stringify({ v: 1, t: '2026-09-28T10:00:00.000Z', seen: {} }),
      reloadTokens: async () => stored,
    });
    const r = await connector.fetchDelta(c);
    expect(r.records).toHaveLength(1);
    expect(calls.some((x) => x.url.pathname === '/oauth/token')).toBe(false);
    expect(calls[1]!.headers.authorization).toBe('Bearer at-sibling');
    expect(c.tokens).toEqual(stored);
    expect(c.saved).toHaveLength(0);
  });

  it('on a 401 refreshes with the sibling-rotated refresh token when the stored one is stale', async () => {
    const { connector, calls } = setup({
      'POST /oauth/token': fx('token-refresh.json'),
      [`POST ${JIRA}/search/jql`]: seq(
        { status: 401, body: fx('error-401.json') },
        fx('search-page-2.json'),
      ),
    });
    const c = ctx({
      cursor: JSON.stringify({ v: 1, t: '2026-09-28T10:00:00.000Z', seen: {} }),
      reloadTokens: async () => ({
        accessToken: 'at-1',
        refreshToken: 'rt-sibling',
        expiresAt: Date.now() - 1,
      }),
    });
    await connector.fetchDelta(c);
    const refresh = calls.find((x) => x.url.pathname === '/oauth/token')!;
    expect(bodyOf(refresh)).toMatchObject({ refresh_token: 'rt-sibling' });
    expect(c.saved[0]!.refreshToken).toBe('eyJraWQiOiJmYWtlIn0.refresh-2-rotated.sig');
  });

  it('asks for a reconnect when the grant is gone', async () => {
    const { connector } = setup({
      'POST /oauth/token': { status: 400, body: { error: 'invalid_grant' } },
      [`POST ${JIRA}/search/jql`]: { status: 401, body: fx('error-401.json') },
    });
    const c = ctx({ cursor: JSON.stringify({ v: 1, t: '2026-09-28T10:00:00.000Z', seen: {} }) });
    await expect(connector.fetchDelta(c)).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(c.saved).toHaveLength(0);
  });

  it('maps 429 to a retryable error with Retry-After, without leaking the query', async () => {
    const { connector } = setup({
      [`POST ${JIRA}/search/jql`]: { status: 429, headers: { 'retry-after': '7' }, body: {} },
    });
    const c = ctx({ cursor: JSON.stringify({ v: 1, t: '2026-09-28T10:00:00.000Z', seen: {} }) });
    const e = (await connector.fetchDelta(c).catch((x: unknown) => x)) as RetryableError;
    expect(e).toBeInstanceOf(RetryableError);
    expect(e.retryAfterMs).toBe(7000);
    expect(e.message).not.toContain('currentUser');
  });
});

describe('info', () => {
  it('describes the catalog entry', () => {
    const { connector } = setup({});
    expect(connector.info).toMatchObject({
      name: 'Atlassian',
      covers: 'Jira, Confluence · per site',
      multiAccountNote: 'One account per site',
      writeActions: ['jira.transition', 'jira.comment'],
    });
    expect(connector.info.sources.map((s) => [s.id, s.kind])).toEqual([
      ['jira', 'ticket'],
      ['confluence', 'note'],
    ]);
    expect(connector.info.sources[1]!.hint).toMatch(/catch-up/);
    expect(connector.configured()).toBe(true);
    expect(
      createAtlassianConnector({ config: { ...config, clientId: undefined } }).configured(),
    ).toBe(false);
  });
});
