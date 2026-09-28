import { describe, expect, it } from 'vitest';
import { normalizeChat, tsKey, type ChatMessage, type ChatRecord, type ChatSpace } from './chat';
import { createGmailConnector } from './connector';
import { fixture } from './fixtures/index';
import { fail, recordedRest, testCtx } from './testing';

const CHAT = 'chat.googleapis.com/v1';
const EVENTS = 'workspaceevents.googleapis.com/v1';
const SELF = '108234567890123456789';
const spaces = fixture<{ spaces: ChatSpace[] }>('chat-spaces.json').spaces;
const spaceMsgs = fixture<{ messages: ChatMessage[] }>('chat-messages-space.json').messages;
const dmMsgs = fixture<{ messages: ChatMessage[] }>('chat-messages-dm.json').messages;
const rec = (m: ChatMessage, space: ChatSpace | null, selfUserId: string | null = SELF) =>
  ({ chatMessage: m, space, selfUserId }) satisfies ChatRecord;
const meta = { googleUserId: SELF };

describe('normalizeChat', () => {
  it('maps a space message: body = text, space and thread refs, url', () => {
    const item = normalizeChat(rec(spaceMsgs[0]!, spaces[0]!))!;
    expect(item).toMatchObject({
      kind: 'chat',
      externalId: 'spaces/AAAAq3Lk0aE/messages/Zx1Qm3pL0aE.Zx1Qm3pL0aE',
      threadId: 'spaces/AAAAq3Lk0aE/threads/Zx1Qm3pL0aE',
      authorAddress: 'users/112233445566778899001',
      title: 'Launch team',
      body: '@Alex can you own the launch checklist? Need it by Wednesday.',
      url: 'https://chat.google.com/room/AAAAq3Lk0aE?cls=11',
      fromMe: false,
    });
    expect(item.labels).toEqual([
      'gchat:space:spaces/AAAAq3Lk0aE',
      'gchat:thread:spaces/AAAAq3Lk0aE/threads/Zx1Qm3pL0aE',
      'gchat:type:SPACE',
      // The USER_MENTION annotation names the owner.
      'hub:mention',
    ]);
    expect(item.receivedAt.toISOString()).toBe('2026-09-28T09:01:02.123Z');
  });

  it('recognizes the owner by their Google account id', () => {
    const item = normalizeChat(rec(spaceMsgs[1]!, spaces[0]!))!;
    expect(item.fromMe).toBe(true);
    expect(item.author).toBe('You');
    expect(item.labels).toContain('gchat:reply:true');
    expect(item.labels).toContain('hub:from_me');
    expect(item.labels).not.toContain('hub:mention');
    const unknownOwner = normalizeChat(rec(spaceMsgs[1]!, spaces[0]!, null))!;
    expect(unknownOwner.fromMe).toBe(false);
    expect(unknownOwner.labels).not.toContain('hub:from_me');
  });

  it('hub:mention comes from annotations only, never from the text', () => {
    const other = { name: 'users/999', type: 'HUMAN' };
    const someoneElse = {
      ...spaceMsgs[0]!,
      annotations: [{ type: 'USER_MENTION', userMention: { user: other, type: 'MENTION' } }],
    };
    expect(normalizeChat(rec(someoneElse, spaces[0]!))!.labels).not.toContain('hub:mention');
    const textOnly = { ...spaceMsgs[0]!, text: `@Alex users/${SELF} ping`, annotations: [] };
    expect(normalizeChat(rec(textOnly, spaces[0]!))!.labels).not.toContain('hub:mention');
  });

  it('titles DMs, flags them hub:dm, and drops deleted messages', () => {
    const dm = normalizeChat(rec(dmMsgs[0]!, spaces[1]!))!;
    expect(dm.title).toBe('Direct message');
    expect(dm.labels).toContain('hub:dm');
    expect(normalizeChat(rec(spaceMsgs[0]!, spaces[0]!))!.labels).not.toContain('hub:dm');
    expect(
      normalizeChat(rec({ ...dmMsgs[0]!, deleteTime: '2026-09-28T10:00:00Z' }, spaces[1]!)),
    ).toBeNull();
  });

  it('orders timestamps with any fractional precision', () => {
    expect(tsKey('2026-09-28T09:05:12Z') < tsKey('2026-09-28T09:05:12.000001Z')).toBe(true);
    expect(tsKey('2026-09-28T14:35:12+05:30')).toBe(tsKey('2026-09-28T09:05:12.000Z'));
  });
});

describe('chat delta', () => {
  const connector = (routes: Parameters<typeof recordedRest>[0], eventsTopic?: string) => {
    const r = recordedRest(routes);
    return {
      ...r,
      c: createGmailConnector({
        config: { fake: false, ...(eventsTopic ? { eventsTopic } : {}) },
        restFactory: r.factory,
        sleep: async () => {},
      }),
    };
  };
  const routes = {
    [`GET ${CHAT}/spaces`]: fixture('chat-spaces.json'),
    [`GET ${CHAT}/spaces/AAAAq3Lk0aE/messages`]: fixture('chat-messages-space.json'),
    [`GET ${CHAT}/spaces/AAAAdmPr1ya/messages`]: fixture('chat-messages-dm.json'),
    [`GET ${CHAT}/spaces/AAAAoldGrp9/messages`]: fixture('chat-messages-empty.json'),
  };

  it('lists messages newer than the cursor in spaces active since then', async () => {
    const { c, calls } = connector(routes);
    const cursor = '2026-09-28T08:00:00.000000Z';
    const delta = await c.fetchDelta(testCtx('chat', { cursor, meta }));
    const listed = calls.filter((x) => x.key.endsWith('/messages'));
    // The group chat was last active in January: not queried.
    expect(listed.map((x) => x.key.split('/')[3])).toEqual(['AAAAq3Lk0aE', 'AAAAdmPr1ya']);
    expect(listed[0]!.params?.filter).toBe(`createTime > "${cursor}"`);
    expect(delta.cursor).toBe('2026-09-28T09:05:12.345678Z');
    const items = delta.records.map((r) => c.normalize(r, 'chat')!);
    expect(items.map((i) => i.body)).toEqual([
      'Did legal sign off on the vendor contract?',
      '@Alex can you own the launch checklist? Need it by Wednesday.',
      'Yes, on it.',
    ]);
    expect(items.map((i) => i.fromMe)).toEqual([false, false, true]);
  });

  it('without a cursor starts from now', async () => {
    const { c, calls } = connector(routes);
    const d = await c.fetchDelta(testCtx('chat'));
    expect(d.records).toEqual([]);
    expect(Math.abs(Date.parse(d.cursor!) - Date.now())).toBeLessThan(5000);
    expect(calls).toHaveLength(0);
  });

  it('a consumer account (403/404) yields nothing instead of an error', async () => {
    for (const [status, body] of [
      [403, fixture('chat-403.json')],
      [404, fixture('chat-404.json')],
    ] as const) {
      const { c } = connector({ [`GET ${CHAT}/spaces`]: fail(status, body) });
      const cursor = '2026-09-28T08:00:00Z';
      expect(await c.fetchDelta(testCtx('chat', { cursor }))).toEqual({ records: [], cursor });
    }
  });

  it('subscribe on a consumer account marks the source unavailable; later syncs skip it', async () => {
    const { c, calls } = connector({ [`GET ${CHAT}/spaces`]: fail(403, fixture('chat-403.json')) });
    const sub = await c.subscribe(testCtx('chat'));
    expect(sub).toEqual({
      externalSubId: null,
      expiresAt: null,
      meta: { unavailable: 'not_workspace' },
    });
    calls.length = 0;
    const ctx = testCtx('chat', { cursor: 'c1', subscription: { ...sub, meta: sub.meta! } });
    expect(await c.fetchDelta(ctx)).toEqual({ records: [], cursor: 'c1' });
    expect(await c.backfill(ctx, { days: 7 })).toEqual({ records: [], nextPageToken: null });
    expect(calls).toHaveLength(0);
  });

  it('a 404 (no Chat app configured for the project) is reported apart from consumer accounts', async () => {
    const { c } = connector({ [`GET ${CHAT}/spaces`]: fail(404, fixture('chat-404.json')) });
    expect((await c.subscribe(testCtx('chat'))).meta).toEqual({
      unavailable: 'chat_app_not_configured',
    });
  });

  it('backfill walks active spaces one page at a time', async () => {
    const { c } = connector(routes);
    const ctx = testCtx('chat', { meta });
    const seen: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await c.backfill(ctx, { days: 36500, ...(token ? { pageToken: token } : {}) });
      seen.push(...page.records.map((r) => c.normalize(r, 'chat')!.externalId));
      if (!page.nextPageToken) break;
      token = page.nextPageToken;
    }
    expect(seen).toHaveLength(3);
  });
});

describe('chat Workspace Events subscription', () => {
  const TOPIC = 'projects/hub-dev/topics/workspace-events';
  const setup = (routes: Parameters<typeof recordedRest>[0]) => {
    const r = recordedRest({ [`GET ${CHAT}/spaces`]: fixture('chat-spaces.json'), ...routes });
    return {
      ...r,
      c: createGmailConnector({
        config: { fake: false, eventsTopic: TOPIC },
        restFactory: r.factory,
        sleep: async () => {},
      }),
    };
  };

  it('creates a spaces/- subscription for new messages without resource data', async () => {
    const { c, calls } = setup({
      [`POST ${EVENTS}/subscriptions`]: fixture('events-operation.json'),
    });
    const sub = await c.subscribe(testCtx('chat'));
    const create = calls.find((x) => x.key === `POST ${EVENTS}/subscriptions`)!;
    expect(create.data).toEqual({
      targetResource: '//chat.googleapis.com/spaces/-',
      eventTypes: ['google.workspace.chat.message.v1.created'],
      notificationEndpoint: { pubsubTopic: TOPIC },
      payloadOptions: { includeResource: false },
      ttl: '604800s',
    });
    expect(sub.externalSubId).toBe('subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw');
    expect(sub.expiresAt).toEqual(new Date('2026-10-05T10:32:41.123Z'));
    expect(sub.meta).toEqual({ state: 'ACTIVE' });
    expect(typeof sub.cursor).toBe('string');
  });

  it('polls a running operation until done', async () => {
    const { c } = setup({
      [`POST ${EVENTS}/subscriptions`]: { name: 'operations/op-1', done: false },
      [`GET ${EVENTS}/operations/op-1`]: (_q: unknown, n: number) =>
        n === 0 ? { name: 'operations/op-1', done: false } : fixture('events-operation.json'),
    });
    const sub = await c.subscribe(testCtx('chat'));
    expect(sub.externalSubId).toBe('subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw');
  });

  it('409 ALREADY_EXISTS reuses and extends the existing subscription', async () => {
    const { c, calls } = setup({
      [`POST ${EVENTS}/subscriptions`]: fail(409, fixture('events-409.json')),
      [`GET ${EVENTS}/subscriptions`]: fixture('events-subscriptions-list.json'),
      [`PATCH ${EVENTS}/subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw`]:
        fixture('events-operation.json'),
    });
    const sub = await c.subscribe(testCtx('chat'));
    const list = calls.find((x) => x.key === `GET ${EVENTS}/subscriptions`)!;
    expect(list.params?.filter).toBe(
      'event_types:"google.workspace.chat.message.v1.created" AND target_resource="//chat.googleapis.com/spaces/-"',
    );
    const patch = calls.find((x) => x.method === 'PATCH')!;
    expect(patch.params).toEqual({ updateMask: 'ttl' });
    expect(patch.data).toEqual({ ttl: '604800s' });
    expect(sub.externalSubId).toBe('subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw');
  });

  it('renew extends the TTL, and recreates the subscription when it is gone', async () => {
    const name = 'subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw';
    const ctx = testCtx('chat', {
      cursor: 'keep',
      subscription: { externalSubId: name, expiresAt: new Date(), meta: {} },
    });
    const ok = setup({ [`PATCH ${EVENTS}/${name}`]: fixture('events-operation.json') });
    const renewed = await ok.c.renew(ctx);
    expect(renewed.expiresAt).toEqual(new Date('2026-10-05T10:32:41.123Z'));
    expect(renewed.cursor).toBeUndefined();

    const gone = setup({
      [`PATCH ${EVENTS}/${name}`]: fail(404, { error: { code: 404, status: 'NOT_FOUND' } }),
      [`POST ${EVENTS}/subscriptions`]: fixture('events-operation.json'),
    });
    expect((await gone.c.renew(ctx)).externalSubId).toBe(name);
    expect(gone.calls.map((x) => x.method ?? 'GET')).toContain('POST');
  });

  it('unsubscribe deletes the subscription (404 = already gone)', async () => {
    const name = 'subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw';
    const { c, calls } = setup({ [`DELETE ${EVENTS}/${name}`]: fail(404, {}) });
    await c.unsubscribe!(
      testCtx('chat', { subscription: { externalSubId: name, expiresAt: null, meta: {} } }),
    );
    expect(calls.map((x) => x.key)).toEqual([`DELETE ${EVENTS}/${name}`]);
  });
});
