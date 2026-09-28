import { describe, expect, it } from 'vitest';
import { ReconnectRequiredError } from '../errors';
import type { ConnectorContext, SubscriptionInfo } from '../types';
import { channelSecretMatches } from './channels';
import { createGmailConnector } from './connector';
import { FakeGmailStore, seedFakeState } from './fake-store';
import { testCtx } from './testing';

const WORK = 'alex@company.example';
const PERSONAL = 'alex.personal@gmail.example';

async function setup(email = WORK) {
  const store = FakeGmailStore.memory();
  const c = createGmailConnector({
    config: { fake: true, gatewayUrl: 'http://localhost:4001' },
    fakeStore: store,
    sleep: async () => {},
  });
  const out = await c.connect.exchange({ code: `fake:${email}`, redirectUri: '', access: 'read' });
  const meta = out.identities![0]!.meta!;
  const ctx = (source: string, cursor: string | null = null, sub?: SubscriptionInfo) => {
    const x: ConnectorContext = testCtx(source, {
      externalId: email,
      tokens: out.tokens,
      cursor,
      meta,
      ...(sub ? { subscription: { ...sub, meta: sub.meta ?? {} } } : {}),
    });
    return x;
  };
  return { store, c, ctx };
}

describe('Google Workspace in fake mode', () => {
  it('calendar: subscribe opens a channel, an invite arrives through the delta, 410 after expiry', async () => {
    const { store, c, ctx } = await setup();
    const sub = await c.subscribe(ctx('calendar'));
    const channel = store.google(WORK)!.channels[0]!;
    expect(channel).toMatchObject({ id: sub.externalSubId, source: 'calendar' });
    expect(channel.address).toBe('http://localhost:4001/hooks/gmail/channel');
    expect(channelSecretMatches(sub.meta, channel.token)).toBe(true);

    store.addCalendarEvent(WORK, { title: 'Budget sync', organizerName: 'Priya Raman' });
    const delta = await c.fetchDelta(ctx('calendar', sub.cursor!));
    const items = delta.records.map((r) => c.normalize(r, 'calendar')!);
    expect(items.map((i) => i.title)).toEqual(['Budget sync']);
    expect(items[0]!.labels.some((l) => l.startsWith('gcal:start:'))).toBe(true);
    expect(items[0]!.labels.some((l) => l.startsWith('gcal:end:'))).toBe(true);
    expect(items[0]!.labels).toContain('hub:rsvp_needed');
    expect((await c.fetchDelta(ctx('calendar', delta.cursor))).records).toEqual([]);

    store.expireCalendarSync(WORK);
    const stale = await c.fetchDelta(ctx('calendar', delta.cursor));
    expect(stale.fullResyncRequired).toBe(true);

    await c.unsubscribe!(ctx('calendar', null, sub));
    expect(store.google(WORK)!.channels).toEqual([]);
  });

  it('calendar backfill returns the seeded events', async () => {
    const { c, ctx } = await setup();
    const page = await c.backfill(ctx('calendar'), { days: 30 });
    const titles = page.records.map((r) => c.normalize(r, 'calendar')?.title).filter(Boolean);
    expect(titles).toEqual(['Q3 roadmap review', '1:1 Alex / Sam', 'Company offsite']);
  });

  it('drive: a share arrives through changes; renew swaps the channel; 404 after expiry', async () => {
    const { store, c, ctx } = await setup();
    const sub = await c.subscribe(ctx('drive'));
    expect(sub.cursor).toBeTruthy();
    store.shareDriveFile(WORK, { name: 'Launch plan', fromName: 'Sam Ortiz' });
    const delta = await c.fetchDelta(ctx('drive', sub.cursor!));
    expect(delta.records.map((r) => c.normalize(r, 'drive')!.summary)).toEqual([
      'Sam Ortiz shared “Launch plan” with you',
    ]);

    const renewed = await c.renew(ctx('drive', delta.cursor, sub));
    const ids = store.google(WORK)!.channels.map((ch) => ch.id);
    expect(ids).toEqual([renewed.externalSubId]);
    expect(renewed.externalSubId).not.toBe(sub.externalSubId);

    store.expireDriveChanges(WORK);
    expect((await c.fetchDelta(ctx('drive', delta.cursor))).fullResyncRequired).toBe(true);
  });

  it('chat: Workspace Events subscription, new message through the delta', async () => {
    const { store, c, ctx } = await setup();
    const sub = await c.subscribe(ctx('chat'));
    const es = store.google(WORK)!.eventSubscriptions;
    expect(es.map((s) => s.name)).toEqual([sub.externalSubId]);
    expect(es[0]!.topic).toBe('projects/hub-fake/topics/workspace-events');

    store.addChatMessage(WORK, {
      space: 'Launch team',
      text: 'Can you review the PR today?',
      mentionOwner: true,
    });
    const delta = await c.fetchDelta(ctx('chat', sub.cursor!));
    const items = delta.records.map((r) => c.normalize(r, 'chat')!);
    expect(items.map((i) => [i.title, i.body])).toEqual([
      ['Launch team', 'Can you review the PR today?'],
    ]);
    expect(items[0]!.labels).toContain('hub:mention');
    expect(items[0]!.fromMe).toBe(false);
    expect((await c.fetchDelta(ctx('chat', delta.cursor))).records).toEqual([]);

    // Without a space, the message goes to the first space (not a nameless DM).
    expect(store.addChatMessage(WORK, { text: 'x' }).space.displayName).toBe('Launch team');

    // Subscribing again (e.g. after a reconnect) reuses the one Google already has.
    const again = await c.subscribe(ctx('chat'));
    expect(again.externalSubId).toBe(sub.externalSubId);
    expect(store.google(WORK)!.eventSubscriptions).toHaveLength(1);
  });

  it('chat on a consumer account is unavailable, without errors', async () => {
    const { c, ctx } = await setup(PERSONAL);
    const sub = await c.subscribe(ctx('chat'));
    expect(sub.meta).toEqual({ unavailable: 'not_workspace' });
    expect(await c.fetchDelta(ctx('chat', '2026-01-01T00:00:00Z'))).toEqual({
      records: [],
      cursor: '2026-01-01T00:00:00Z',
    });
  });

  it('revoked grants surface as ReconnectRequiredError on every source', async () => {
    const { store, c, ctx } = await setup();
    store.setRevoked(WORK, true);
    for (const s of ['calendar', 'drive', 'chat']) {
      await expect(c.fetchDelta(ctx(s, 'x'))).rejects.toBeInstanceOf(ReconnectRequiredError);
    }
  });

  it('refreshes expired tokens for REST sources and saves them', async () => {
    const { c, ctx } = await setup();
    const x = ctx('drive');
    const saved: unknown[] = [];
    x.tokens = { ...x.tokens, expiresAt: Date.now() - 1000 };
    x.saveTokens = async (t) => {
      saved.push(t);
    };
    await c.fetchDelta(x);
    expect(saved).toHaveLength(1);
    expect(x.tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('fills in Google data for stores written before Phase 5', () => {
    const old = seedFakeState();
    for (const mb of Object.values(old.mailboxes)) delete mb.google;
    const store = FakeGmailStore.memory(old);
    expect(store.google(WORK)!.chat.spaces.length).toBeGreaterThan(0);
    expect(store.google(PERSONAL)!.workspace).toBe(false);
  });
});
