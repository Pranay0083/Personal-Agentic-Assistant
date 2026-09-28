import { describe, expect, it } from 'vitest';
import { itemRefs, toAccount } from './serialize';

describe('itemRefs', () => {
  it('passes display-safe refs and signals only', () => {
    const refs = itemRefs([
      'INBOX',
      'rfc822msgid:<a@b>',
      'hub:content:abc123',
      'hub:mention',
      'hub:blocking:2',
      'gcal:start:2026-09-29T11:00:00Z',
      'jira:key:PROJ-482',
      'slack:channel_name:api',
      'slack:channel:C123',
      42,
    ]);
    expect(refs).toEqual([
      'hub:mention',
      'hub:blocking:2',
      'gcal:start:2026-09-29T11:00:00Z',
      'jira:key:PROJ-482',
      'slack:channel_name:api',
    ]);
  });
});

describe('toAccount', () => {
  const base = {
    id: '00000000-0000-0000-0000-000000000001',
    userId: '00000000-0000-0000-0000-000000000002',
    nickname: 'Me',
    color: '#1F6F6B',
    externalId: '1',
    status: 'live',
    tokenRef: null,
    writeTokenRef: null,
    filters: {},
    syncCursor: null,
    isPersonal: false,
    backfillDays: 30,
    lastSyncedAt: null,
    createdAt: new Date(),
    routeKeys: [],
  };

  it('reports write access and a GitHub install step, only for github.com URLs', () => {
    const gh = toAccount({
      ...base,
      provider: 'github',
      writeTokenRef: '00000000-0000-0000-0000-000000000003',
      meta: { needsInstall: true, installUrl: 'https://github.com/apps/hub/installations/new' },
    } as never);
    expect(gh.writeAccess).toBe(true);
    expect(gh.setup?.url).toBe('https://github.com/apps/hub/installations/new');

    const evil = toAccount({
      ...base,
      provider: 'github',
      meta: { needsInstall: true, installUrl: 'https://evil.example/phish' },
    } as never);
    expect(evil.setup).toBeNull();
    expect(evil.writeAccess).toBe(false);
  });
});
