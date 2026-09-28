import { describe, expect, it } from 'vitest';
import { ConnectorError, ReconnectRequiredError, RetryableError } from '../errors';
import type { MailCursor, TeamsCursor } from './cursor';
import type { MsRecord } from './graph-types';
import { NOW, byQuery, defaultFilters, fx, replay, replayWith, testCtx } from './test-helpers';

const INBOX = 'GET /v1.0/me/mailFolders/inbox/messages/delta';
const SENT = 'GET /v1.0/me/mailFolders/sentitems/messages/delta';

const inboxPages = byQuery((u) =>
  u.searchParams.get('$skiptoken') ? fx('mail-delta-inbox-2.json') : fx('mail-delta-inbox-1.json'),
);
const storedCursor = JSON.stringify({
  v: 1,
  inbox:
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=OLD_INBOX',
  sent: 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$deltatoken=OLD_SENT',
} satisfies MailCursor);

describe('mail delta', () => {
  it('starts both folders at "now" on the first run without enumerating the mailbox', async () => {
    const { connector, calls } = replay({
      [INBOX]: fx('mail-delta-empty-inbox.json'),
      [SENT]: fx('mail-delta-empty-sent.json'),
    });
    const out = await connector.fetchDelta(testCtx());
    expect(out.records).toEqual([]);
    const cur = JSON.parse(out.cursor!) as MailCursor;
    expect(cur.inbox).toContain('FreshInboxDeltaToken');
    expect(cur.sent).toContain('FreshSentDeltaToken');
    const first = calls[0]!.url;
    expect(first.searchParams.get('$filter')).toBe(
      `receivedDateTime ge ${new Date(NOW).toISOString()}`,
    );
    expect(first.searchParams.get('changeType')).toBe('created');
    expect(first.searchParams.get('$select')).toContain('conversationId');
    // Spaces are %20 and `$` stays literal for Graph's OData parser.
    expect(first.search).toContain('$filter=receivedDateTime%20ge%20');
    expect(calls[0]!.headers.prefer).toContain('IdType="ImmutableId"');
    expect(calls[0]!.headers.prefer).toContain('odata.maxpagesize=50');
  });

  it('pages through nextLinks to the deltaLink and skips @removed entries', async () => {
    const { connector, calls } = replay({
      [INBOX]: inboxPages,
      [SENT]: fx('mail-delta-sent.json'),
    });
    const out = await connector.fetchDelta(testCtx({ cursor: storedCursor }));
    expect(
      calls.map(
        (c) => c.url.searchParams.get('$deltatoken') ?? c.url.searchParams.get('$skiptoken'),
      ),
    ).toEqual(['OLD_INBOX', 'MSkYoWq8Fixture_Page2', 'OLD_SENT']);
    const recs = out.records as Extract<MsRecord, { source: 'mail' }>[];
    expect(recs.map((r) => [r.folder, r.message.subject])).toEqual([
      ['inbox', 'Budget sign-off for Q4'],
      ['inbox', 'Lunch?'],
      ['sent', 'RE: Offsite agenda'],
    ]);
    expect(out.hasMore).toBeUndefined();
    const cur = JSON.parse(out.cursor!) as MailCursor;
    expect(cur.inbox).toContain('$deltatoken=LztZwWjo5');
    expect(cur.sent).toContain('SentFixtureDeltaToken');
  });

  it('stops at the page budget, keeps the nextLink and reports hasMore', async () => {
    const { connector } = replay(
      { [INBOX]: inboxPages, [SENT]: fx('mail-delta-sent.json') },
      { maxPages: 1 },
    );
    const out = await connector.fetchDelta(testCtx({ cursor: storedCursor }));
    expect(out.hasMore).toBe(true);
    const cur = JSON.parse(out.cursor!) as MailCursor;
    expect(cur.inbox).toContain('$skiptoken=MSkYoWq8Fixture_Page2');
    expect(out.records).toHaveLength(2);
  });

  const expiringInbox = (status: number) =>
    replayWith((_m, u) => {
      if (u.pathname.endsWith('/sentitems/messages/delta'))
        return { body: fx('mail-delta-sent.json') };
      if (u.searchParams.get('$deltatoken') === 'OLD_INBOX') {
        return { status, body: fx('error-sync-state-not-found.json') };
      }
      return { body: fx('mail-delta-empty-inbox.json') };
    });

  it('restarts an expired delta token (410 SyncStateNotFound) and asks for a resync', async () => {
    const { connector, calls } = expiringInbox(410);
    const out = await connector.fetchDelta(testCtx({ cursor: storedCursor }));
    expect(out.fullResyncRequired).toBe(true);
    const cur = JSON.parse(out.cursor!) as MailCursor;
    expect(cur.inbox).toContain('FreshInboxDeltaToken_after_resync');
    // The restart begins at "now" again.
    expect(calls[1]!.url.searchParams.get('$filter')).toContain('receivedDateTime ge');
    // The healthy folder still advances.
    expect(cur.sent).toContain('SentFixtureDeltaToken');
  });

  it('also treats a 400 carrying a sync-state error code as expiry', async () => {
    const out = await expiringInbox(400).connector.fetchDelta(testCtx({ cursor: storedCursor }));
    expect(out.fullResyncRequired).toBe(true);
  });

  it('does not mistake other 400s for expiry', async () => {
    const { connector } = replayWith(() => ({
      status: 400,
      body: { error: { code: 'BadRequest' } },
    }));
    await expect(connector.fetchDelta(testCtx({ cursor: storedCursor }))).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });

  it('only reads the folders the filters include', async () => {
    const { connector, calls } = replay({ [SENT]: fx('mail-delta-sent.json') });
    const out = await connector.fetchDelta(
      testCtx({ cursor: storedCursor, filters: defaultFilters({ inbox: false }) }),
    );
    expect(calls.every((c) => c.url.pathname.includes('sentitems'))).toBe(true);
    // The unread folder keeps its old link.
    expect((JSON.parse(out.cursor!) as MailCursor).inbox).toContain('OLD_INBOX');
  });

  it('maps 401 to reconnect and 429 to a retry with Retry-After', async () => {
    const unauthorized = replay({ [INBOX]: { status: 401, body: fx('error-401.json') } });
    await expect(unauthorized.connector.fetchDelta(testCtx())).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
    const throttled = replay({
      [INBOX]: { status: 429, body: fx('error-429.json'), headers: { 'retry-after': '7' } },
    });
    const e = (await throttled.connector
      .fetchDelta(testCtx())
      .catch((x: unknown) => x)) as RetryableError;
    expect(e).toBeInstanceOf(RetryableError);
    expect(e.retryAfterMs).toBe(7000);
    expect(e.message).not.toContain('MailboxConcurrency');
  });

  it('refuses to follow a stored link to another host', async () => {
    const { connector, calls } = replay({});
    const evil = JSON.stringify({ v: 1, inbox: 'https://attacker.example/steal?x=1', sent: null });
    await expect(
      connector.fetchDelta(testCtx({ cursor: evil, filters: defaultFilters({ sent: false }) })),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(calls).toHaveLength(0);
  });

  it('backfills Inbox then Sent Items with a received-date filter', async () => {
    const { connector, calls } = replay({
      'GET /v1.0/me/mailFolders/inbox/messages': fx('mail-delta-inbox-2.json'),
      'GET /v1.0/me/mailFolders/sentitems/messages': fx('mail-delta-sent.json'),
    });
    const p1 = await connector.backfill(testCtx(), { days: 7 });
    expect(p1.records).toHaveLength(1);
    expect(p1.nextPageToken).toBe(JSON.stringify({ f: 'sent' }));
    const p2 = await connector.backfill(testCtx(), { days: 7, pageToken: p1.nextPageToken! });
    expect((p2.records[0] as Extract<MsRecord, { source: 'mail' }>).folder).toBe('sent');
    expect(p2.nextPageToken).toBeNull();
    expect(calls[0]!.url.searchParams.get('$filter')).toBe(
      `receivedDateTime ge ${new Date(NOW - 7 * 86_400_000).toISOString()}`,
    );
  });
});

describe('calendar delta', () => {
  it('opens a calendarView window, drops removed events and stores a small cursor', async () => {
    const { connector, calls } = replay({
      'GET /v1.0/me/calendarView/delta': fx('calendar-delta.json'),
    });
    const out = await connector.fetchDelta(testCtx({ source: 'calendar' }));
    expect(out.records).toHaveLength(2);
    const q = calls[0]!.url.searchParams;
    expect(q.get('startDateTime')).toBe(new Date(NOW - 86_400_000).toISOString());
    expect(q.get('endDateTime')).toBe(new Date(NOW + 30 * 86_400_000).toISOString());
    expect(calls[0]!.headers.prefer).toContain('outlook.timezone="UTC"');
    const cur = JSON.parse(out.cursor!) as { link: string; start: string };
    expect(cur.link).toContain('$deltatoken=R0usmcCM996atia_s');
    expect(out.cursor!.length).toBeLessThan(400);
  });

  it('rolls the window forward once it is a week old', async () => {
    const { connector, calls } = replay({
      'GET /v1.0/me/calendarView/delta': fx('calendar-delta.json'),
    });
    const old = JSON.stringify({
      v: 1,
      link: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=OLD',
      start: new Date(NOW - 9 * 86_400_000).toISOString(),
      end: new Date(NOW + 21 * 86_400_000).toISOString(),
    });
    await connector.fetchDelta(testCtx({ source: 'calendar', cursor: old }));
    expect(calls[0]!.url.searchParams.get('$deltatoken')).toBeNull();
    expect(calls[0]!.url.searchParams.get('startDateTime')).toBe(
      new Date(NOW - 86_400_000).toISOString(),
    );
  });
});

describe('teams chats (watermark poll)', () => {
  const CHAT1 = encodeURIComponent(
    '19:6b1f3c2a-9d4e-4f7a-8c1b-2e3d4f5a6b7c_9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d@unq.gbl.spaces',
  );

  it('starts at now, then lists chats newer than the watermark and their new messages', async () => {
    const routes = {
      'GET /v1.0/me/chats': fx('chats.json'),
      [`GET /v1.0/chats/${CHAT1}/messages`]: fx('chat-messages.json'),
    };
    const first = await replay(routes).connector.fetchDelta(testCtx({ source: 'teams' }));
    expect(first.records).toEqual([]);
    expect(JSON.parse(first.cursor!)).toEqual({ v: 1, since: new Date(NOW).toISOString() });

    const { connector, calls } = replay(routes);
    const since = '2026-09-28T09:00:00.000Z';
    const out = await connector.fetchDelta(
      testCtx({ source: 'teams', cursor: JSON.stringify({ v: 1, since } satisfies TeamsCursor) }),
    );
    // The group chat's last message is older than the watermark: never listed.
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/v1.0/me/chats',
      `/v1.0/chats/${CHAT1}/messages`,
    ]);
    expect(calls[0]!.url.searchParams.get('$orderby')).toBe(
      'lastMessagePreview/createdDateTime desc',
    );
    const q = calls[1]!.url.searchParams;
    expect(q.get('$orderby')).toBe('lastModifiedDateTime desc');
    expect(q.get('$filter')).toBe(
      `lastModifiedDateTime gt ${new Date(Date.parse(since) - 120_000).toISOString()} and lastModifiedDateTime lt ${new Date(NOW).toISOString()}`,
    );
    expect(out.records).toHaveLength(3);
    expect(JSON.parse(out.cursor!)).toEqual({ v: 1, since: new Date(NOW).toISOString() });
    expect(out.hasMore).toBeUndefined();
  });

  it('does nothing for personal accounts (no Graph chat APIs)', async () => {
    const { connector, calls } = replay({});
    const out = await connector.fetchDelta(
      testCtx({ source: 'teams', meta: { personal: true }, cursor: null }),
    );
    expect(out.records).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('onedrive delta', () => {
  it('starts from token=latest, then returns changed files only (no folders, root or deletions)', async () => {
    const init = replay({ 'GET /v1.0/me/drive/root/delta': fx('drive-delta-latest.json') });
    const first = await init.connector.fetchDelta(testCtx({ source: 'onedrive' }));
    expect(init.calls[0]!.url.searchParams.get('token')).toBe('latest');
    expect(first.records).toEqual([]);

    const { connector, calls } = replay({
      'GET /v1.0/me/drive/root/delta': fx('drive-delta.json'),
    });
    const out = await connector.fetchDelta(testCtx({ source: 'onedrive', cursor: first.cursor }));
    expect(calls[0]!.url.toString()).toContain(
      'token=MzslMjM0OyUyMzE7Mzs3ZmFrZS1maXh0dXJlLWxhdGVzdA',
    );
    expect(out.records).toHaveLength(1);
    expect((out.records[0] as Extract<MsRecord, { source: 'onedrive' }>).item.name).toBe(
      'Q3 Board Deck.pptx',
    );
  });

  it('handles 410 resyncRequired by restarting from latest', async () => {
    const cursor = JSON.stringify({
      v: 1,
      link: 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=EXPIRED',
    });
    const { connector } = replayWith((_m, u) =>
      u.searchParams.get('token') === 'EXPIRED'
        ? { status: 410, body: fx('error-resync-required.json') }
        : { body: fx('drive-delta-latest.json') },
    );
    const out = await connector.fetchDelta(testCtx({ source: 'onedrive', cursor }));
    expect(out.fullResyncRequired).toBe(true);
    expect(out.cursor).toContain('MzslMjM0OyUyMzE7Mzs3ZmFrZS1maXh0dXJlLWxhdGVzdA');
  });
});
