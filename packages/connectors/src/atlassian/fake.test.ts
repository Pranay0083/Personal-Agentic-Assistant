import { AccountFilters } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../lib/crypto';
import { identitiesOf, type ConnectorContext, type Identity, type OAuthTokens } from '../types';
import { FAKE_CLIENT_SECRET, type AtlassianConfig } from './config';
import { createAtlassianConnector } from './connector';
import { memoryFakeStore } from './fake-store';
import type { JiraRecord } from './jira';
import { resetMentionFallback } from './jira';
import { signJwt } from './webhooks';

const config: AtlassianConfig = { fake: true, gatewayUrl: 'http://localhost:4001' };

function ctxFor(
  id: Identity,
  tokens: OAuthTokens,
  over: Partial<ConnectorContext> = {},
): ConnectorContext {
  return {
    accountId: `acc-${id.externalId}`,
    externalId: id.externalId,
    tokens,
    saveTokens: async () => {},
    cursor: null,
    filters: AccountFilters.parse({}),
    meta: id.meta ?? {},
    source: 'jira',
    ...over,
  };
}

describe('fake Atlassian (CONNECTORS_FAKE=1)', () => {
  it('runs the whole flow: consent, two sites, webhooks, sync, execute and lookup', async () => {
    resetMentionFallback();
    const store = memoryFakeStore();
    const connector = createAtlassianConnector({ config, fakeStore: store });
    expect(connector.configured()).toBe(true);

    // Fake consent screen redirects straight back with a code.
    const back = new URL(
      connector.connect.authUrl({
        state: 'st',
        redirectUri: 'http://localhost:4000/cb',
        access: 'read',
      }),
    );
    expect(back.searchParams.get('state')).toBe('st');
    const read = await connector.connect.exchange({
      code: back.searchParams.get('code')!,
      redirectUri: 'http://localhost:4000/cb',
      access: 'read',
    });
    const sites = identitiesOf(read);
    expect(sites.map((s) => s.displayName)).toEqual(['acme', 'acme-labs']);
    const [acme, labs] = sites as [Identity, Identity];

    // Jira push: webhooks registered in the fake site, with the secret only in the URL.
    const sub = await connector.subscribe(ctxFor(acme, read.tokens));
    const hooks = store.read().sites[0]!.webhooks!;
    expect(hooks).toHaveLength(2);
    const secret = new URL(hooks[0]!.url).searchParams.get('t')!;
    expect(sub.meta!.secretHash).toBe(sha256Hex(secret));

    // Backfill: my issues only (PROJ-490/491 belong to teammates), with blocking info.
    const page = await connector.backfill(ctxFor(acme, read.tokens), { days: 30 });
    const keys = (page.records as JiraRecord[]).map((r) => r.issue.key).sort();
    expect(keys).toEqual(['PROJ-477', 'PROJ-482']);
    const blocked = page.records
      .map((r) => connector.normalize(r)!)
      .find((i) => i.threadId === 'PROJ-482')!;
    expect(blocked.summary).toContain('blocking 2 people');
    expect(blocked.labels).toContain('jira:status:In Progress');

    const labsPage = await connector.backfill(ctxFor(labs, read.tokens), { days: 30 });
    expect((labsPage.records as JiraRecord[]).map((r) => r.issue.key)).toEqual(['LAB-12']);

    const pages = await connector.backfill(ctxFor(acme, read.tokens, { source: 'confluence' }), {
      days: 30,
    });
    expect(pages.records.map((r) => connector.normalize(r)!.title).sort()).toEqual([
      'Public API spec v2',
      'Q3 launch plan',
    ]);

    // Delta: start, then a teammate comments on PROJ-482.
    const start = await connector.fetchDelta(ctxFor(acme, read.tokens));
    store.update((s) => {
      const i = s.sites[0]!.issues.find((x) => x.key === 'PROJ-482')!;
      const t = new Date(Date.now() + 1000).toISOString().replace('Z', '+0000');
      i.fields.comment.comments.push({
        id: '50001',
        author: '5c3a1f0e9b7d4a0012f3a911',
        created: t,
        updated: t,
        body: null,
      });
      i.fields.updated = t;
    });
    const delta = await connector.fetchDelta(ctxFor(acme, read.tokens, { cursor: start.cursor }));
    expect((delta.records as JiraRecord[]).map((r) => r.issue.key)).toEqual(['PROJ-482']);
    const again = await connector.fetchDelta(ctxFor(acme, read.tokens, { cursor: delta.cursor }));
    expect(again.records).toEqual([]);

    // Webhook delivery signed like Atlassian does, with the fake client secret.
    const sec = Math.floor(Date.now() / 1000);
    const v = await connector.verifyWebhook({
      headers: {
        authorization: `Bearer ${signJwt({ iat: sec, exp: sec + 60 }, FAKE_CLIENT_SECRET)}`,
      },
      query: { sub: sub.externalSubId!, t: secret },
      body: { webhookEvent: 'comment_created', issue: { id: '10482', key: 'PROJ-482' } },
      rawBody: '',
    });
    expect(v.ok && v.events[0]!.externalSubId).toBe(sub.externalSubId);

    // Write consent is separate; the read token cannot write, the write token cannot read.
    const write = await connector.connect.exchange({
      code: 'fake-atl:write',
      redirectUri: 'http://localhost:4000/cb',
      access: 'write',
    });
    const payload = {
      issueKey: 'PROJ-482',
      transitionId: '31',
      toStatus: 'In Review',
      comment: 'Fix merged in #219, ready for QA.',
    };
    await expect(
      connector.execute!(ctxFor(acme, read.tokens), 'jira.transition', payload, 'idem-1'),
    ).rejects.toThrow();
    const fresh = createAtlassianConnector({ config, fakeStore: store });
    expect(
      await (fresh.findExecuted as (...a: unknown[]) => Promise<unknown>)(
        ctxFor(acme, read.tokens),
        'jira.transition',
        'idem-1',
        payload,
      ),
    ).toBeNull();

    const res = await connector.execute!(
      ctxFor(acme, write.tokens),
      'jira.transition',
      payload,
      'idem-1',
    );
    expect(res.externalId).toBe('PROJ-482');
    const issue = store.read().sites[0]!.issues.find((i) => i.key === 'PROJ-482')!;
    expect(issue.fields.status.name).toBe('In Review');
    expect(issue.fields.comment.comments.at(-1)!.author).toBe('5b10ac8d82e05b22cc7d4ef5');

    // A retry in a new process finds the marker with the read token and does not re-send.
    const found = await (fresh.findExecuted as (...a: unknown[]) => Promise<unknown>)(
      ctxFor(acme, read.tokens),
      'jira.transition',
      'idem-1',
      payload,
    );
    expect(found).toMatchObject({ externalId: 'PROJ-482', toStatus: 'In Review' });

    // Comment, then crash before the marker: the comment marker still finds it.
    const c = await connector.execute!(
      ctxFor(acme, write.tokens),
      'jira.comment',
      { issueKey: 'PROJ-477', body: 'On it.' },
      'idem-2',
    );
    store.update((s) => {
      s.sites[0]!.issues.find((i) => i.key === 'PROJ-477')!.properties = {};
    });
    expect(
      await (fresh.findExecuted as (...a: unknown[]) => Promise<unknown>)(
        ctxFor(acme, read.tokens),
        'jira.comment',
        'idem-2',
        { issueKey: 'PROJ-477', body: 'On it.' },
      ),
    ).toMatchObject({ externalId: c.externalId });

    // Renew refreshes the same webhooks.
    const renewed = await connector.renew(
      ctxFor(acme, read.tokens, {
        subscription: {
          externalSubId: sub.externalSubId,
          expiresAt: sub.expiresAt,
          meta: sub.meta!,
        },
      }),
    );
    expect(renewed.externalSubId).toBe(sub.externalSubId);
    expect(store.read().sites[0]!.webhooks).toHaveLength(2);
  });

  it('rotates refresh tokens and fails for good once revoked', async () => {
    const store = memoryFakeStore();
    const connector = createAtlassianConnector({ config, fakeStore: store });
    const read = await connector.connect.exchange({
      code: 'fake-atl:read',
      redirectUri: 'http://x/cb',
    });
    const saved: OAuthTokens[] = [];
    const c = ctxFor(
      identitiesOf(read)[0]!,
      { ...read.tokens, expiresAt: Date.now() - 1 },
      {
        saveTokens: async (t) => {
          saved.push(t);
        },
      },
    );
    await connector.fetchDelta({ ...c, cursor: null });
    await connector.backfill(c, { days: 1 });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.refreshToken).not.toBe(read.tokens.refreshToken);

    store.update((s) => {
      s.revoked = true;
    });
    await expect(connector.backfill(c, { days: 1 })).rejects.toThrow(/401|refused/);
  });
});
