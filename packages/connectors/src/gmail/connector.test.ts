import { describe, expect, it, vi } from 'vitest';
import { AccountFilters } from '@hub/shared';
import { ReconnectRequiredError, RetryableError } from '../errors';
import type { ConnectorContext, OAuthTokens } from '../types';
import type { GmailApi, GmailMessage } from './client';
import type { GmailRecord } from './normalize';
import type { GoogleRecord } from './records';
import { createGmailConnector } from './connector';
import { FakeHttpError } from './fake';
import { FakeGmailStore } from './fake-store';
import { fixture } from './fixtures/index';
import { messageIdFor } from './mime';

/** Mail-source records (the connector's record type is the union of all sources). */
const mail = (r: GoogleRecord) => r as GmailRecord;

const WORK = 'alex@company.example';
const PERSONAL = 'alex.personal@gmail.example';

function ctxFor(externalId: string, tokens: OAuthTokens, cursor: string | null = null) {
  const saved: OAuthTokens[] = [];
  const ctx: ConnectorContext = {
    accountId: '00000000-0000-4000-8000-000000000001',
    externalId,
    tokens,
    saveTokens: async (t) => {
      saved.push(t);
    },
    source: 'mail',
    cursor,
    filters: AccountFilters.parse({}),
  };
  return { ctx, saved };
}

/** A GmailApi that replays the recorded fixtures. */
function recordedClient(overrides: Partial<GmailApi> = {}): GmailApi {
  const messages: Record<string, GmailMessage> = Object.fromEntries(
    [
      'message-multipart.json',
      'message-html-only.json',
      'message-sent.json',
      'message-attachment.json',
    ]
      .map((f) => fixture<GmailMessage>(f))
      .map((m) => [m.id!, m]),
  );
  return {
    getProfile: async () => fixture('profile.json'),
    watch: async () => fixture('watch.json'),
    stop: async () => {},
    listHistory: async ({ pageToken }) =>
      fixture(pageToken === '07081928374651' ? 'history-page-2.json' : 'history-page-1.json'),
    getMessage: async (id) => {
      const m = messages[id];
      if (!m) throw new FakeHttpError(404, fixture('history-404.json'));
      return m;
    },
    listMessages: async ({ pageToken }) =>
      fixture(pageToken ? 'messages-list-page-2.json' : 'messages-list-page-1.json'),
    sendMessage: async () => fixture('send-response.json'),
    ...overrides,
  };
}

const tokens = (): OAuthTokens => ({
  accessToken: 'ya29.fixture',
  refreshToken: '1//fixture',
  expiresAt: Date.now() + 3600_000,
});

describe('gmail connector with recorded fixtures', () => {
  it('pages through history.list, dedupes message ids and returns the new cursor', async () => {
    const calls: (string | undefined)[] = [];
    const api = recordedClient();
    const listHistory = api.listHistory;
    api.listHistory = async (p) => {
      calls.push(p.pageToken);
      expect(p.startHistoryId).toBe('1000');
      expect(p.historyTypes).toEqual(['messageAdded']);
      return listHistory(p);
    };
    const c = createGmailConnector({ config: { fake: false }, clientFactory: () => api });
    const { ctx } = ctxFor(WORK, tokens(), '1000');
    const delta = await c.fetchDelta(ctx);
    expect(calls).toEqual([undefined, '07081928374651']);
    expect(delta.cursor).toBe('1005');
    expect(delta.fullResyncRequired).toBeUndefined();
    expect(delta.records.map((r) => mail(r).message.id)).toEqual([
      '192a7c3e5b1d0a01',
      '192a7c3e5b1d0a02',
      '192a7c3e5b1d0a03',
    ]);
    expect(delta.records.every((r) => mail(r).accountEmail === WORK)).toBe(true);
  });

  it('returns fullResyncRequired with a fresh cursor when history is too old (404)', async () => {
    const api = recordedClient({
      listHistory: async () => {
        throw new FakeHttpError(404, fixture('history-404.json'));
      },
    });
    const c = createGmailConnector({ config: { fake: false }, clientFactory: () => api });
    const delta = await c.fetchDelta(ctxFor(WORK, tokens(), '12').ctx);
    expect(delta).toEqual({ records: [], cursor: '1000', fullResyncRequired: true });
  });

  it('skips messages deleted before they could be fetched', async () => {
    const api = recordedClient({
      listHistory: async () => ({
        history: [
          {
            id: '1',
            messagesAdded: [{ message: { id: 'gone' } }, { message: { id: '192a7c3e5b1d0a02' } }],
          },
        ],
        historyId: '1001',
      }),
    });
    const c = createGmailConnector({ config: { fake: false }, clientFactory: () => api });
    const delta = await c.fetchDelta(ctxFor(WORK, tokens(), '1000').ctx);
    expect(delta.records.map((r) => mail(r).message.id)).toEqual(['192a7c3e5b1d0a02']);
  });

  it('maps 401 and invalid_grant to ReconnectRequiredError, 429/5xx to RetryableError', async () => {
    const failing = (err: unknown) =>
      createGmailConnector({
        config: { fake: false },
        clientFactory: () =>
          recordedClient({
            listHistory: async () => {
              throw err;
            },
          }),
      });
    const ctx = () => ctxFor(WORK, tokens(), '1000').ctx;
    await expect(
      failing(new FakeHttpError(401, fixture('error-401.json'))).fetchDelta(ctx()),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    await expect(
      failing(new FakeHttpError(400, fixture('token-invalid-grant.json'))).fetchDelta(ctx()),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    const rl = await failing(
      new FakeHttpError(429, fixture('error-429.json'), { 'retry-after': '7' }),
    )
      .fetchDelta(ctx())
      .catch((e: unknown) => e);
    expect(rl).toBeInstanceOf(RetryableError);
    expect((rl as RetryableError).retryAfterMs).toBe(7000);
    await expect(failing(new FakeHttpError(503, {})).fetchDelta(ctx())).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  it('backfill passes the window and filter query and pages', async () => {
    const qs: (string | undefined)[] = [];
    const api = recordedClient();
    const list = api.listMessages;
    api.listMessages = async (p) => {
      qs.push(p.q);
      return list(p);
    };
    const c = createGmailConnector({ config: { fake: false }, clientFactory: () => api });
    const { ctx } = ctxFor(WORK, tokens());
    const p1 = await c.backfill(ctx, { days: 30 });
    expect(p1.records.map((r) => mail(r).message.id)).toEqual([
      '192a7c3e5b1d0a04',
      '192a7c3e5b1d0a03',
    ]);
    expect(p1.nextPageToken).toBe('13977562894183526071');
    const p2 = await c.backfill(ctx, { days: 30, pageToken: p1.nextPageToken! });
    expect(p2.nextPageToken).toBeNull();
    expect(qs[0]).toBe(
      'newer_than:30d -in:spam -in:trash -in:drafts -category:promotions -category:social',
    );
  });

  it('subscribe watches INBOX (+SENT) on the configured topic', async () => {
    const watch = vi.fn(async () =>
      fixture<{ historyId: string; expiration: string }>('watch.json'),
    );
    const c = createGmailConnector({
      config: { fake: false, pubsubTopic: 'projects/hub-dev/topics/gmail' },
      clientFactory: () => recordedClient({ watch }),
    });
    const sub = await c.subscribe(ctxFor(WORK, tokens()).ctx);
    expect(watch).toHaveBeenCalledWith({
      topicName: 'projects/hub-dev/topics/gmail',
      labelIds: ['INBOX', 'SENT'],
      labelFilterBehavior: 'include',
    });
    expect(sub).toEqual({
      externalSubId: 'projects/hub-dev/topics/gmail',
      expiresAt: new Date(1791191561000),
      cursor: '1000',
    });
  });

  it('execute sends RFC 2822 with the deterministic Message-ID and threadId', async () => {
    const send = vi.fn(async (_p: { raw: string; threadId?: string }) =>
      fixture<GmailMessage>('send-response.json'),
    );
    const c = createGmailConnector({
      config: { fake: false },
      clientFactory: () => recordedClient({ sendMessage: send }),
    });
    const res = await c.execute!(
      ctxFor(WORK, tokens()).ctx,
      'gmail.send',
      {
        to: ['priya@company.example'],
        subject: 'Re: Q3 roadmap slides by Thursday?',
        body: 'Attached.',
        inReplyTo: '<CAF=q3roadmap.1@mail.company.example>',
        threadId: '192a7c3e5b1d0a01',
      },
      'proposal-42',
    );
    expect(res).toEqual({
      externalId: '192a7c3e5b1d0aff',
      threadId: '192a7c3e5b1d0a01',
      messageId: messageIdFor('proposal-42'),
    });
    const arg = send.mock.calls[0]![0];
    expect(arg.threadId).toBe('192a7c3e5b1d0a01');
    const mime = Buffer.from(arg.raw, 'base64url').toString('utf8');
    expect(mime).toContain(`Message-ID: ${messageIdFor('proposal-42')}`);
    expect(mime).toContain('In-Reply-To: <CAF=q3roadmap.1@mail.company.example>');
    expect(mime).toContain('From: alex@company.example');
  });

  it('execute validates the payload', async () => {
    const c = createGmailConnector({
      config: { fake: false },
      clientFactory: () => recordedClient(),
    });
    await expect(
      c.execute!(
        ctxFor(WORK, tokens()).ctx,
        'gmail.send',
        { to: ['not-an-email'], subject: 's', body: 'b' },
        'k',
      ),
    ).rejects.toThrow();
  });
});

describe('gmail connector in fake mode', () => {
  const setup = () => {
    const store = FakeGmailStore.memory();
    const c = createGmailConnector({
      config: { fake: true, historyPageSize: 1 },
      fakeStore: store,
    });
    return { store, c };
  };

  async function connect(c: ReturnType<typeof setup>['c'], loginHint?: string) {
    const url = new URL(
      c.connect.authUrl({
        state: 'st',
        redirectUri: 'http://localhost:4000/oauth/google/callback',
        access: 'read',
        ...(loginHint ? { loginHint } : {}),
      }),
    );
    expect(url.origin + url.pathname).toBe('http://localhost:4000/oauth/google/callback');
    expect(url.searchParams.get('state')).toBe('st');
    return c.connect.exchange({
      code: url.searchParams.get('code')!,
      redirectUri: '',
      access: 'read',
    });
  }

  it('connecting twice yields two distinct accounts; loginHint picks one', async () => {
    const { c } = setup();
    const a = await connect(c);
    const b = await connect(c);
    expect(new Set([a.externalId, b.externalId])).toEqual(new Set([WORK, PERSONAL]));
    expect((await connect(c, PERSONAL)).externalId).toBe(PERSONAL);
    expect(a.tokens.refreshToken).toBeTruthy();
    expect(a.tokens.scope).toContain('gmail.readonly');
    expect(a.tokens.scope).not.toContain('gmail.send');
  });

  it('write consent is separate and checked', async () => {
    const { c } = setup();
    const url = new URL(
      c.connect.authUrl({
        state: 's',
        redirectUri: 'http://x.test/cb',
        access: 'write',
        loginHint: WORK,
      }),
    );
    const code = url.searchParams.get('code')!;
    const w = await c.connect.exchange({ code, redirectUri: '', access: 'write' });
    expect(w.tokens.scope).toContain('gmail.send');
    await expect(c.connect.exchange({ code, redirectUri: '', access: 'read' })).rejects.toThrow(
      /missing scopes/,
    );
  });

  it('refreshes expired tokens and calls saveTokens', async () => {
    const { c } = setup();
    const { tokens: t } = await connect(c, WORK);
    const { ctx, saved } = ctxFor(WORK, { ...t, expiresAt: Date.now() - 1000 });
    const sub = await c.subscribe(ctx);
    expect(sub.cursor).toBe('1000');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.accessToken).not.toBe(t.accessToken);
    expect(saved[0]!.refreshToken).toBe(t.refreshToken);
    expect(saved[0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(ctx.tokens.accessToken).toBe(saved[0]!.accessToken);
  });

  it('delivers appended mail through history (paged) and reports 404 after expiry', async () => {
    const { store, c } = setup();
    const { tokens: t } = await connect(c, WORK);
    store.appendMessage(WORK, { from: 'a@x.example', subject: 'one', body: 'first' });
    store.appendMessage(WORK, { from: 'b@x.example', subject: 'two', body: 'second' });
    const delta = await c.fetchDelta(ctxFor(WORK, t, '1000').ctx);
    expect(delta.cursor).toBe('1002');
    expect(delta.records.map((r) => c.normalize(r)!.title)).toEqual(['one', 'two']);
    store.expireHistory(WORK);
    const stale = await c.fetchDelta(ctxFor(WORK, t, '1002').ctx);
    expect(stale.fullResyncRequired).toBe(true);
    expect(stale.cursor).toBe('1003');
  });

  it('backfill honours the window', async () => {
    const { store, c } = setup();
    const { tokens: t } = await connect(c, PERSONAL);
    store.appendMessage(PERSONAL, {
      from: 'old@x.example',
      subject: 'old',
      body: 'x',
      date: new Date(Date.now() - 20 * 86400_000),
    });
    const { ctx } = ctxFor(PERSONAL, t);
    ctx.filters = { ...ctx.filters, promotions: true };
    const week = await c.backfill(ctx, { days: 7 });
    expect(week.records.map((r) => mail(r).message.id)).not.toContain(undefined);
    expect(week.records).toHaveLength(3);
    const month = await c.backfill(ctx, { days: 30 });
    expect(month.records).toHaveLength(4);
  });

  it('revoked grant raises ReconnectRequiredError', async () => {
    const { store, c } = setup();
    const { tokens: t } = await connect(c, WORK);
    store.setRevoked(WORK, true);
    await expect(c.fetchDelta(ctxFor(WORK, t, '1000').ctx)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });

  it('findExecuted finds a sent message by idempotency key, so retries never double-send', async () => {
    const { c } = setup();
    const { tokens: t } = await connect(c, WORK);
    const { ctx } = ctxFor(WORK, t);
    expect(await c.findExecuted!(ctx, 'gmail.send', 'proposal-7')).toBeNull();
    const sent = await c.execute!(
      ctx,
      'gmail.send',
      { to: ['priya@company.example'], subject: 'Hi', body: 'b' },
      'proposal-7',
    );
    const found = await c.findExecuted!(ctx, 'gmail.send', 'proposal-7');
    expect(found).toEqual({
      externalId: sent.externalId,
      threadId: sent.externalId,
      messageId: messageIdFor('proposal-7'),
    });
    expect(await c.findExecuted!(ctx, 'gmail.send', 'proposal-8')).toBeNull();
  });
});
