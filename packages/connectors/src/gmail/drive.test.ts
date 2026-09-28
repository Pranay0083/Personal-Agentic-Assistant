import { describe, expect, it } from 'vitest';
import { AccountFilters } from '@hub/shared';
import { createGmailConnector } from './connector';
import { driveAccepts, normalizeDrive, type DriveChangeList, type DriveRecord } from './drive';
import { fixture } from './fixtures/index';
import { fail, recordedRest, testCtx } from './testing';

const API = 'www.googleapis.com/drive/v3';
const page1 = fixture<DriveChangeList>('drive-changes-page-1.json');
const page2 = fixture<DriveChangeList>('drive-changes-page-2.json');
const rec = (i: number, page = page1): DriveRecord => ({
  change: page.changes![i]!,
  accountEmail: 'alex@company.example',
});

describe('normalizeDrive', () => {
  it('a file shared with you: title, who shared it, metadata-only', () => {
    const item = normalizeDrive(rec(0))!;
    expect(item).toMatchObject({
      kind: 'file',
      externalId: '1Q3pLanDeckAbCdEfGhIjKlMnOpQrStUvWxYz0123',
      author: 'Priya Raman',
      authorAddress: 'priya@company.example',
      title: 'Q3 roadmap (draft)',
      summary: 'Priya Raman shared “Q3 roadmap (draft)” with you',
      body: null,
      fromMe: false,
      url: 'https://docs.google.com/presentation/d/1Q3pLanDeckAbCdEfGhIjKlMnOpQrStUvWxYz0123/edit?usp=drivesdk',
    });
    expect(item.labels).toEqual([
      'gdrive:file:1Q3pLanDeckAbCdEfGhIjKlMnOpQrStUvWxYz0123',
      'gdrive:change:shared',
      'gdrive:owner:other',
      'gdrive:mime:application/vnd.google-apps.presentation',
    ]);
    expect(item.receivedAt.toISOString()).toBe('2026-09-28T07:12:40.311Z');
  });

  it('your file edited by someone else says who changed it', () => {
    const item = normalizeDrive(rec(1))!;
    expect(item.summary).toBe('Sam Ortiz edited “FY27 budget”');
    expect(item.author).toBe('Sam Ortiz');
    expect(item.labels).toContain('gdrive:owner:me');
    expect(item.labels).toContain('gdrive:change:edited');
    expect(item.receivedAt.toISOString()).toBe('2026-09-28T09:20:04.000Z');
  });

  it('drops your own edits, removals and trashed files', () => {
    expect(normalizeDrive(rec(0, page2))).toBeNull();
    expect(normalizeDrive(rec(1, page2))).toBeNull();
    expect(normalizeDrive(rec(2, page2))).toBeNull();
  });

  it('drive.sharedOnly keeps only files other people own', () => {
    const filters = AccountFilters.parse({ options: { 'drive.sharedOnly': true } });
    expect(driveAccepts(normalizeDrive(rec(0))!, filters)).toBe(true);
    expect(driveAccepts(normalizeDrive(rec(1))!, filters)).toBe(false);
    expect(driveAccepts(normalizeDrive(rec(1))!, AccountFilters.parse({}))).toBe(true);
  });
});

describe('drive delta', () => {
  const connector = (routes: Parameters<typeof recordedRest>[0], gatewayUrl?: string) => {
    const r = recordedRest(routes);
    return {
      ...r,
      c: createGmailConnector({
        config: { fake: false, ...(gatewayUrl ? { gatewayUrl } : {}) },
        restFactory: r.factory,
      }),
    };
  };

  it('pages changes.list until newStartPageToken, metadata fields only', async () => {
    const { c, calls } = connector({
      [`GET ${API}/changes`]: (req: { params?: Record<string, unknown> }) =>
        req.params?.pageToken === '8845' ? page2 : page1,
    });
    const delta = await c.fetchDelta(testCtx('drive', { cursor: '8841' }));
    expect(calls.map((x) => x.params?.pageToken)).toEqual(['8841', '8845']);
    expect(calls[0]!.params).toMatchObject({
      includeRemoved: true,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    expect(String(calls[0]!.params?.fields)).not.toMatch(/exportLinks|thumbnail|content/i);
    expect(delta.cursor).toBe('8851');
    expect(delta.records).toHaveLength(5);
    expect(delta.records.map((r) => c.normalize(r, 'drive')).filter(Boolean)).toHaveLength(2);
  });

  it('an invalid page token (404) → fullResyncRequired from a new start token', async () => {
    const { c } = connector({
      [`GET ${API}/changes`]: fail(404, fixture('drive-404.json')),
      [`GET ${API}/changes/startPageToken`]: fixture('drive-start-page-token.json'),
    });
    expect(await c.fetchDelta(testCtx('drive', { cursor: '12' }))).toEqual({
      records: [],
      cursor: '8841',
      fullResyncRequired: true,
    });
  });

  it('without a cursor returns the start page token', async () => {
    const { c } = connector({
      [`GET ${API}/changes/startPageToken`]: fixture('drive-start-page-token.json'),
    });
    expect(await c.fetchDelta(testCtx('drive'))).toEqual({ records: [], cursor: '8841' });
  });

  it('backfill lists recently modified files shaped as changes', async () => {
    const { c, calls } = connector({ [`GET ${API}/files`]: fixture('drive-files-list.json') });
    const page = await c.backfill(testCtx('drive'), { days: 7 });
    expect(String(calls[0]!.params?.q)).toMatch(/^modifiedTime > '.+' and trashed = false$/);
    expect(page.records.map((r) => c.normalize(r, 'drive')?.summary ?? null)).toEqual([
      'Sam Ortiz edited “FY27 budget”',
      null,
    ]);
  });

  it('subscribe watches changes from the start token', async () => {
    const { c, calls } = connector(
      {
        [`GET ${API}/changes/startPageToken`]: fixture('drive-start-page-token.json'),
        [`POST ${API}/changes/watch`]: fixture('drive-watch.json'),
      },
      'https://hub.example/',
    );
    const sub = await c.subscribe(testCtx('drive'));
    const watch = calls.find((x) => x.key.endsWith('/changes/watch'))!;
    expect(watch.params).toMatchObject({ pageToken: '8841', supportsAllDrives: true });
    expect((watch.data as { address: string }).address).toBe(
      'https://hub.example/hooks/gmail/channel',
    );
    expect(sub).toMatchObject({
      externalSubId: 'hubdrv-0a1b2c3d4e5f60718293a4b5',
      cursor: '8841',
      meta: { resourceId: 'Hq8y3KpL0v2mN6bXcR5tZ1wE9aU', channel: 'drive' },
    });
  });
});
