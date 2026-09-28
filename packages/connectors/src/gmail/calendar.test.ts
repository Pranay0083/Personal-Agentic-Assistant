import { describe, expect, it } from 'vitest';
import { AccountFilters } from '@hub/shared';
import { sha256Hex } from '../lib/crypto';
import type { CalendarEvent, CalendarEventList, CalendarRecord } from './calendar';
import { calendarAccepts, calendarDelta, normalizeCalendar } from './calendar';
import { createGmailConnector } from './connector';
import { fixture } from './fixtures/index';
import { fail, recordedRest, testCtx } from './testing';

const EVENTS = 'www.googleapis.com/calendar/v3/calendars/primary/events';
const page1 = fixture<CalendarEventList>('calendar-events-page-1.json');
const page2 = fixture<CalendarEventList>('calendar-events-page-2.json');
const rec = (event: CalendarEvent): CalendarRecord => ({
  event,
  calendarId: 'primary',
  accountEmail: 'alex@company.example',
});
const [invite, own] = page1.items!;
const [offsite, cancelled, workingLocation] = page2.items!;

describe('normalizeCalendar', () => {
  it('maps an invite: title, organizer, start label, url, last-updated time', () => {
    const item = normalizeCalendar(rec(invite!))!;
    expect(item).toMatchObject({
      kind: 'event',
      externalId: '5q2r7kqo1bv6o3f0m3pl4ad8ts',
      threadId: '5q2r7kqo1bv6o3f0m3pl4ad8ts',
      author: 'Priya Raman',
      authorAddress: 'priya@company.example',
      title: 'Q3 roadmap review',
      fromMe: false,
      url: invite!.htmlLink,
    });
    expect(item.receivedAt.toISOString()).toBe('2026-09-28T09:41:12.482Z');
    expect(item.labels).toEqual(
      expect.arrayContaining([
        'gcal:event:5q2r7kqo1bv6o3f0m3pl4ad8ts',
        'gcal:start:2026-10-01T04:30:00.000Z',
        'gcal:end:2026-10-01T05:30:00.000Z',
        'gcal:response:needsAction',
        'gcal:role:attendee',
        'hub:rsvp_needed',
      ]),
    );
    expect(item.labels).not.toContain('hub:from_me');
    expect(item.summary).toContain('organized by Priya Raman');
    expect(item.body).toContain('Walk through the slides');
    expect(item.body).toContain('Agree owners & dates');
    expect(item.body).toContain('Location: Room 4B');
    expect(item.body).not.toContain('<br>');
  });

  it('marks events the user organizes as fromMe', () => {
    const item = normalizeCalendar(rec(own!))!;
    expect(item.fromMe).toBe(true);
    expect(item.labels).toContain('gcal:role:organizer');
    expect(item.labels).toContain('hub:from_me');
    expect(item.labels).not.toContain('hub:rsvp_needed');
  });

  it('keeps the all-day date as the start label; hides declined events by default', () => {
    const item = normalizeCalendar(rec(offsite!))!;
    expect(item.labels).toContain('gcal:start:2026-10-09');
    expect(item.labels).toContain('gcal:end:2026-10-11');
    expect(item.labels).toContain('gcal:response:declined');
    expect(item.labels).not.toContain('hub:rsvp_needed');
    const filters = AccountFilters.parse({});
    expect(calendarAccepts(item, filters)).toBe(false);
    expect(calendarAccepts(item, { ...filters, options: { 'calendar.hideDeclined': false } })).toBe(
      true,
    );
  });

  it('drops bare deletions and working-location entries', () => {
    expect(normalizeCalendar(rec(cancelled!))).toBeNull();
    expect(normalizeCalendar(rec(workingLocation!))).toBeNull();
  });
});

describe('calendar delta', () => {
  const connector = (routes: Parameters<typeof recordedRest>[0]) => {
    const r = recordedRest(routes);
    return { ...r, c: createGmailConnector({ config: { fake: false }, restFactory: r.factory }) };
  };

  it('pages through events.list with the sync token and returns nextSyncToken', async () => {
    const { c, calls } = connector({
      [`GET ${EVENTS}`]: (req: { params?: Record<string, unknown> }) =>
        req.params?.pageToken ? page2 : page1,
    });
    const delta = await c.fetchDelta(testCtx('calendar', { cursor: 'CPjA-old' }));
    expect(calls.map((x) => x.params?.syncToken)).toEqual(['CPjA-old', 'CPjA-old']);
    expect(calls[1]!.params?.pageToken).toBe(page1.nextPageToken);
    expect(delta.cursor).toBe(page2.nextSyncToken);
    expect(delta.records).toHaveLength(5);
    expect(delta.records.map((r) => c.normalize(r, 'calendar')?.title ?? null)).toEqual([
      'Q3 roadmap review',
      '1:1 Alex / Sam',
      'Company offsite',
      null,
      null,
    ]);
  });

  it('caps pages per call and resumes from the page token carried in the cursor', async () => {
    const pageN = (n: number): CalendarEventList => ({
      items: [{ ...invite!, id: `ev-${n}` }],
      ...(n < 3 ? { nextPageToken: `p${n + 1}` } : { nextSyncToken: 'CPjA-next' }),
    });
    const routes = {
      [`GET ${EVENTS}`]: (req: { params?: Record<string, unknown> }) => {
        const t = req.params?.pageToken;
        return pageN(t ? Number(String(t).slice(1)) : 1);
      },
    };
    const r = recordedRest(routes);
    const first = await calendarDelta(r.rest, {
      cursor: 'CPjA-old',
      accountEmail: 'alex@company.example',
      maxPages: 2,
    });
    expect(first.records.map((x) => x.event.id)).toEqual(['ev-1', 'ev-2']);
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(first.cursor!)).toEqual({ v: 1, syncToken: 'CPjA-old', pageToken: 'p3' });
    expect(r.calls).toHaveLength(2);

    const second = await calendarDelta(r.rest, {
      cursor: first.cursor,
      accountEmail: 'alex@company.example',
      maxPages: 2,
    });
    expect(second.records.map((x) => x.event.id)).toEqual(['ev-3']);
    expect(second.hasMore).toBeUndefined();
    // Back to the plain-token format once the round is complete.
    expect(second.cursor).toBe('CPjA-next');
    expect(r.calls[2]!.params).toMatchObject({ syncToken: 'CPjA-old', pageToken: 'p3' });

    // Through the connector the default cap applies (10 pages).
    const many = recordedRest({
      [`GET ${EVENTS}`]: (req: { params?: Record<string, unknown> }) => ({
        items: [],
        nextPageToken: `x${Number(String(req.params?.pageToken ?? 'x0').slice(1)) + 1}`,
      }),
    });
    const c = createGmailConnector({ config: { fake: false }, restFactory: many.factory });
    const d = await c.fetchDelta(testCtx('calendar', { cursor: 'CPjA-old' }));
    expect(many.calls).toHaveLength(10);
    expect(d.hasMore).toBe(true);
    expect(JSON.parse(d.cursor!)).toMatchObject({ syncToken: 'CPjA-old', pageToken: 'x10' });
  });

  it('restarts the round when a stored page token is refused; bad cursors resync', async () => {
    const r = recordedRest({
      [`GET ${EVENTS}`]: (req: { params?: Record<string, unknown> }) =>
        req.params?.pageToken ? fail(400, { error: { code: 400 } })() : page2,
    });
    const d = await calendarDelta(r.rest, {
      cursor: JSON.stringify({ v: 1, syncToken: 'CPjA-old', pageToken: 'stale' }),
      accountEmail: 'alex@company.example',
    });
    expect(d.cursor).toBe(page2.nextSyncToken);
    expect(r.calls.map((x) => x.params?.pageToken)).toEqual(['stale', undefined]);

    const bad = recordedRest({ [`GET ${EVENTS}`]: fixture('calendar-sync-token.json') });
    expect(
      await calendarDelta(bad.rest, { cursor: '{"nope":1}', accountEmail: 'a@b.example' }),
    ).toMatchObject({ records: [], fullResyncRequired: true });
  });

  it('410 Gone → fullResyncRequired with a fresh token', async () => {
    const { c, calls } = connector({
      [`GET ${EVENTS}`]: (req: { params?: Record<string, unknown> }) =>
        req.params?.syncToken
          ? fail(410, fixture('calendar-410.json'))()
          : fixture('calendar-sync-token.json'),
    });
    const delta = await c.fetchDelta(testCtx('calendar', { cursor: 'expired' }));
    expect(delta).toEqual({
      records: [],
      cursor: 'CKCx7eKT1YgDEKCx7eKT1YgDGAUghIDAhQI=',
      fullResyncRequired: true,
    });
    expect(calls[1]!.params).toMatchObject({ fields: 'nextPageToken,nextSyncToken' });
    expect(calls[1]!.params?.timeMin).toBeTruthy();
  });

  it('without a cursor only fetches a sync token', async () => {
    const { c } = connector({ [`GET ${EVENTS}`]: fixture('calendar-sync-token.json') });
    expect(await c.fetchDelta(testCtx('calendar'))).toEqual({
      records: [],
      cursor: 'CKCx7eKT1YgDEKCx7eKT1YgDGAUghIDAhQI=',
    });
  });

  it('backfill asks for events updated in the window', async () => {
    const { c, calls } = connector({ [`GET ${EVENTS}`]: page1 });
    const page = await c.backfill(testCtx('calendar'), { days: 30 });
    expect(page.records).toHaveLength(2);
    expect(page.nextPageToken).toBe(page1.nextPageToken);
    const since = Date.parse(String(calls[0]!.params?.updatedMin));
    expect(Date.now() - since).toBeGreaterThan(29 * 86400_000);
  });
});

describe('calendar watch channel', () => {
  const setup = (gatewayUrl = 'https://hub.example') => {
    const r = recordedRest({
      [`GET ${EVENTS}`]: fixture('calendar-sync-token.json'),
      [`POST ${EVENTS}/watch`]: (req: { data?: unknown }) => ({
        ...fixture<Record<string, unknown>>('calendar-watch.json'),
        id: (req.data as { id: string }).id,
      }),
      'POST www.googleapis.com/calendar/v3/channels/stop': '',
    });
    const c = createGmailConnector({ config: { fake: false, gatewayUrl }, restFactory: r.factory });
    return { ...r, c };
  };

  it('subscribe opens a channel to /hooks/gmail/channel and stores only the token hash', async () => {
    const { c, calls } = setup();
    const sub = await c.subscribe(testCtx('calendar'));
    const watch = calls.find((x) => x.key.endsWith('/events/watch'))!;
    const body = watch.data as { id: string; type: string; address: string; token: string };
    expect(body.type).toBe('web_hook');
    expect(body.address).toBe('https://hub.example/hooks/gmail/channel');
    expect(body.id).toMatch(/^hubcal-[0-9a-f]{24}$/);
    expect(sub.externalSubId).toBe(body.id);
    expect(sub.expiresAt).toEqual(new Date(1791796361000));
    expect(sub.cursor).toBe('CKCx7eKT1YgDEKCx7eKT1YgDGAUghIDAhQI=');
    expect(sub.meta).toEqual({
      secretHash: sha256Hex(body.token),
      resourceId: 'o3hgv1538sdjfh7k2lxbe9',
      channel: 'calendar',
    });
    expect(JSON.stringify(sub)).not.toContain(body.token);
  });

  it('renew watches a new channel, then stops the old one, and keeps the cursor', async () => {
    const { c, calls } = setup();
    const next = await c.renew(
      testCtx('calendar', {
        cursor: 'keep-me',
        subscription: {
          externalSubId: 'hubcal-old',
          expiresAt: new Date(),
          meta: { secretHash: 'x', resourceId: 'res-old' },
        },
      }),
    );
    expect(calls.map((x) => x.key.split('/').slice(-2).join('/'))).toEqual([
      'events/watch',
      'channels/stop',
    ]);
    expect(calls[1]!.data).toEqual({ id: 'hubcal-old', resourceId: 'res-old' });
    expect(next.externalSubId).not.toBe('hubcal-old');
    expect(next.cursor).toBeUndefined();
  });

  it('without an https gateway it syncs by schedule only (no channel)', async () => {
    const { c, calls } = setup('http://localhost:4001');
    const sub = await c.subscribe(testCtx('calendar'));
    expect(sub).toMatchObject({ externalSubId: null, meta: { push: 'disabled' } });
    expect(calls.some((x) => x.key.endsWith('/watch'))).toBe(false);
  });
});
