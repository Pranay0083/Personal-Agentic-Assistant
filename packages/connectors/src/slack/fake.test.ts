import { AccountFilters } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { ReconnectRequiredError } from '../errors';
import type { ConnectorContext, OAuthTokens } from '../types';
import type { SlackConfig } from './config';
import { createSlackConnector } from './connector';
import { memoryFakeSlackStore } from './fake';
import { slackSignature } from './webhook';

const fakeConfig: SlackConfig = {
  fake: true,
  apiBase: 'https://slack.com/api',
  authorizeUrl: 'https://slack.com/oauth/v2/authorize',
};

function setup() {
  let now = Date.UTC(2026, 8, 28, 12);
  const store = memoryFakeSlackStore(now);
  const connector = createSlackConnector({
    config: fakeConfig,
    fakeStore: store,
    now: () => now,
    pageSize: 3,
  });
  return { store, connector, tick: (ms: number) => (now += ms), now: () => now };
}

async function connect(
  c: ReturnType<typeof setup>['connector'],
  access: 'read' | 'write',
  loginHint?: string,
) {
  const url = new URL(
    c.connect.authUrl({
      state: 'st',
      redirectUri: 'http://localhost:4000/cb',
      access,
      ...(loginHint ? { loginHint } : {}),
    }),
  );
  expect(url.origin).toBe('http://localhost:4000');
  const code = url.searchParams.get('code')!;
  return c.connect.exchange({ code, redirectUri: 'http://localhost:4000/cb', access });
}

function ctxFor(externalId: string, tokens: OAuthTokens, cursor: string | null): ConnectorContext {
  return {
    accountId: `acc-${externalId}`,
    externalId,
    tokens,
    saveTokens: async () => {},
    source: 'messages',
    cursor,
    filters: AccountFilters.parse({}),
  };
}

describe('fake Slack (CONNECTORS_FAKE=1)', () => {
  it('redirects with code=fake:<workspace> and connects both workspaces in turn', async () => {
    const { connector } = setup();
    const a = await connect(connector, 'read');
    const b = await connect(connector, 'read');
    expect([a.externalId, b.externalId]).toEqual([
      'T0ACME0001:U0ALEX0001',
      'T0SIDE0001:U0ME000002',
    ]);
    expect(a.identities?.[0]?.routeKeys).toEqual(['T0ACME0001']);
    expect(a.identities?.[0]?.meta).toMatchObject({ teamDomain: 'acme-eng' });
    const hinted = await connect(connector, 'read', 'side-project');
    expect(hinted.externalId).toBe('T0SIDE0001:U0ME000002');
  });

  it('backfills seeded history without bots, joins or unjoined channels', async () => {
    const { connector } = setup();
    const a = await connect(connector, 'read', 'T0ACME0001');
    const ctx = ctxFor(a.externalId, a.tokens, null);
    const texts: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await connector.backfill(ctx, { days: 7, ...(pageToken ? { pageToken } : {}) });
      texts.push(...page.records.map((r) => connector.normalize(r)!.externalId));
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
    expect(texts).toHaveLength(6);
    expect(texts.some((t) => t.startsWith('C0RANDOM01'))).toBe(false);
  });

  it('syncs a new message, posts with the write consent and finds the post again', async () => {
    const { connector, store, tick } = setup();
    const read = await connect(connector, 'read', 'T0ACME0001');
    const sub = await connector.subscribe(ctxFor(read.externalId, read.tokens, null));
    tick(60_000);
    const posted = store.appendMessage(
      'T0ACME0001',
      { channel: 'D0PRIYA001', user: 'U0PRIYA001', text: 'Ping <@U0ALEX0001>' },
      Date.UTC(2026, 8, 28, 12, 1),
    );
    const delta = await connector.fetchDelta(
      ctxFor(read.externalId, read.tokens, sub.cursor ?? null),
    );
    const items = delta.records.map((r) => connector.normalize(r)!);
    expect(items.map((i) => i.externalId)).toEqual([`D0PRIYA001:${posted.ts}`]);
    expect(items[0]).toMatchObject({ author: 'Priya', body: 'Ping @Alex', fromMe: false });

    // The read token cannot post; the write consent can.
    await expect(
      connector.execute!(
        ctxFor(read.externalId, read.tokens, null),
        'slack.post',
        { channel: 'D0PRIYA001', text: 'x' },
        'k0',
      ),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    const write = await connect(connector, 'write', 'T0ACME0001');
    expect(write.externalId).toBe(read.externalId);
    const res = await connector.execute!(
      ctxFor(write.externalId, write.tokens, null),
      'slack.post',
      { channel: 'D0PRIYA001', text: 'Will do', threadTs: posted.ts },
      'idem-1',
    );
    expect(res.channel).toBe('D0PRIYA001');
    const found = await connector.findExecuted!(
      ctxFor(read.externalId, read.tokens, null),
      'slack.post',
      'idem-1',
    );
    expect(found).toMatchObject({ externalId: res.externalId, threadTs: posted.ts });
    expect(
      await connector.findExecuted!(
        ctxFor(read.externalId, read.tokens, null),
        'slack.post',
        'idem-2',
      ),
    ).toBeNull();
  });

  it('revoked grants need a reconnect; a fresh consent restores them', async () => {
    const { connector, store } = setup();
    const a = await connect(connector, 'read', 'T0ACME0001');
    await connector.connect.revoke(a.tokens);
    await expect(
      connector.backfill(ctxFor(a.externalId, a.tokens, null), { days: 1 }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    store.revokeAll('T0ACME0001');
    const again = await connect(connector, 'read', 'T0ACME0001');
    await expect(
      connector.backfill(ctxFor(again.externalId, again.tokens, null), { days: 1 }),
    ).resolves.toBeTruthy();
  });

  it('accepts pushes signed with the fake signing secret', async () => {
    const { connector, now } = setup();
    const body = { type: 'url_verification', challenge: 'abc' };
    const rawBody = JSON.stringify(body);
    const ts = String(Math.floor(now() / 1000));
    const r = await connector.verifyWebhook({
      headers: {
        'x-slack-signature': slackSignature('fake-signing-secret', ts, rawBody),
        'x-slack-request-timestamp': ts,
      },
      body,
      rawBody,
    });
    expect(r).toMatchObject({ ok: true, reply: { body: { challenge: 'abc' } } });
  });
});
