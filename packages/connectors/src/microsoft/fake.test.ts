import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../lib/index';
import type { Connector, ConnectorContext } from '../types';
import { createMicrosoftConnector } from './connector';
import { memoryFakeMsStore } from './fake-store';
import type { MsRecord } from './graph-types';
import { defaultFilters, testConfig } from './test-helpers';

const WORK = 'avery.chen@contoso.example';
const PERSONAL = 'sam.rivera@outlook.example';

function setup() {
  const store = memoryFakeMsStore();
  const connector = createMicrosoftConnector({
    config: testConfig({ fake: true, gatewayUrl: 'http://localhost:4001', now: undefined }),
    fakeStore: store,
  });
  return { store, connector };
}

async function connect(
  connector: Connector<MsRecord>,
  hint: string,
  access: 'read' | 'write' = 'read',
) {
  const url = new URL(
    connector.connect.authUrl({
      state: 'st',
      redirectUri: 'http://localhost:4000/cb',
      access,
      loginHint: hint,
    }),
  );
  expect(url.origin).toBe('http://localhost:4000');
  expect(url.searchParams.get('state')).toBe('st');
  const code = url.searchParams.get('code')!;
  expect(code).toBe(`${access === 'write' ? 'fake-write' : 'fake'}:${hint}`);
  return connector.connect.exchange({ code, redirectUri: 'http://localhost:4000/cb', access });
}

function ctxFrom(
  ex: Awaited<ReturnType<typeof connect>>,
  source: string,
  cursor: string | null = null,
): ConnectorContext {
  return {
    accountId: 'a1',
    externalId: ex.externalId,
    tokens: ex.tokens,
    saveTokens: async () => {},
    source,
    cursor,
    filters: defaultFilters(),
    meta: ex.identities![0]!.meta!,
  };
}

describe('fake mode (CONNECTORS_FAKE=1)', () => {
  it('connects a work tenant and a personal account', async () => {
    const { connector } = setup();
    expect(connector.configured()).toBe(true);
    const work = await connect(connector, WORK);
    const personal = await connect(connector, PERSONAL);
    expect(work.identities![0]!.meta).toMatchObject({ personal: false, upn: WORK });
    expect(personal.identities![0]!.meta).toMatchObject({
      personal: true,
      tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
    });
  });

  it('syncs new mail end to end: subscribe, init cursor, deliver, delta, normalize', async () => {
    const { connector, store } = setup();
    const ex = await connect(connector, WORK);
    const ctx = ctxFrom(ex, 'mail');
    const sub = await connector.subscribe(ctx);
    const recorded = store.read().subscriptions[sub.externalSubId!]!;
    expect(sha256Hex(recorded.clientState)).toBe(sub.meta!.secretHash);

    const init = await connector.fetchDelta(ctx);
    expect(init.records).toEqual([]);
    store.addMail(WORK, {
      from: 'dana@fabrikam.example',
      fromName: 'Dana',
      subject: 'Invoice',
      body: '<p>Due <b>Friday</b></p>',
      html: true,
    });
    const next = await connector.fetchDelta({ ...ctx, cursor: init.cursor });
    expect(next.records).toHaveLength(1);
    const item = connector.normalize(next.records[0]!, 'mail')!;
    expect(item).toMatchObject({
      kind: 'email',
      title: 'Invoice',
      body: 'Due Friday',
      fromMe: false,
    });
    expect(connector.accepts!(item, ctx.filters, 'mail')).toBe(true);
    // Nothing new: empty delta.
    const again = await connector.fetchDelta({ ...ctx, cursor: next.cursor });
    expect(again.records).toEqual([]);
  });

  it('reports an expired delta token as fullResyncRequired', async () => {
    const { connector, store } = setup();
    const ex = await connect(connector, WORK);
    const ctx = ctxFrom(ex, 'mail');
    const init = await connector.fetchDelta(ctx);
    store.expireDelta(WORK);
    const out = await connector.fetchDelta({ ...ctx, cursor: init.cursor });
    expect(out.fullResyncRequired).toBe(true);
  });

  it('pages mail backfill and seeds calendar, teams and onedrive', async () => {
    const { connector, store } = setup();
    const ex = await connect(connector, WORK);
    const mail = await connector.backfill(ctxFrom(ex, 'mail'), { days: 30 });
    expect(mail.records.length).toBeGreaterThan(0);
    const cal = await connector.fetchDelta(ctxFrom(ex, 'calendar'));
    expect(cal.records.map((r) => connector.normalize(r)!.title)).toEqual(
      expect.arrayContaining(['1:1 Priya / Avery', 'Q3 board prep']),
    );
    const teams0 = await connector.fetchDelta(ctxFrom(ex, 'teams'));
    store.addChatMessage(WORK, { fromName: 'Priya Raman', text: 'Ping' }, Date.now() - 5);
    const teams = await connector.fetchDelta(ctxFrom(ex, 'teams', teams0.cursor));
    expect(teams.records.map((r) => connector.normalize(r)!.body)).toContain('Ping');
    const drive0 = await connector.fetchDelta(ctxFrom(ex, 'onedrive'));
    store.addDriveChange(WORK, { name: 'Plan.docx', byName: 'Jordan Lee' });
    const drive = await connector.fetchDelta(ctxFrom(ex, 'onedrive', drive0.cursor));
    expect(drive.records.map((r) => connector.normalize(r)!.title)).toEqual(['Plan.docx']);
  });

  it('keeps personal accounts out of Teams', async () => {
    const { connector } = setup();
    const ex = await connect(connector, PERSONAL);
    const sub = await connector.subscribe(ctxFrom(ex, 'teams'));
    expect(sub.externalSubId).toBeNull();
    const out = await connector.fetchDelta(ctxFrom(ex, 'teams'));
    expect(out.records).toEqual([]);
  });

  it('sends once per idempotency key: findExecuted sees the marker in Sent Items', async () => {
    const { connector, store } = setup();
    const read = await connect(connector, WORK);
    const write = await connect(connector, WORK, 'write');
    const readCtx = ctxFrom(read, 'mail');
    const writeCtx = ctxFrom(write, 'mail');
    const payload = { to: ['priya.raman@contoso.example'], subject: 'Numbers', body: 'Attached.' };

    expect(await connector.findExecuted!(readCtx, 'outlook.send', 'key-1')).toBeNull();
    await connector.execute!(writeCtx, 'outlook.send', payload, 'key-1');
    const found = await connector.findExecuted!(readCtx, 'outlook.send', 'key-1');
    expect(found?.externalId).toBeTruthy();
    expect(await connector.findExecuted!(readCtx, 'outlook.send', 'key-2')).toBeNull();

    // Scopes are enforced like Graph: the read token cannot send, the write token cannot read.
    await expect(connector.execute!(readCtx, 'outlook.send', payload, 'key-3')).rejects.toThrow();
    await expect(connector.findExecuted!(writeCtx, 'outlook.send', 'key-1')).rejects.toThrow();

    // Reply threads into the original conversation.
    const original = store.user(WORK)!.messages.find((m) => m.folder === 'inbox')!.message;
    await connector.execute!(
      writeCtx,
      'outlook.send',
      { ...payload, inReplyTo: original.id },
      'key-4',
    );
    const reply = await connector.findExecuted!(readCtx, 'outlook.send', 'key-4');
    expect(reply?.threadId).toBe(original.conversationId);
  });

  it('refuses revoked grants with reconnect', async () => {
    const { connector, store } = setup();
    const ex = await connect(connector, WORK);
    store.setRevoked(WORK, true);
    await expect(connector.fetchDelta(ctxFrom(ex, 'onedrive'))).rejects.toMatchObject({
      name: 'ReconnectRequiredError',
    });
  });
});
