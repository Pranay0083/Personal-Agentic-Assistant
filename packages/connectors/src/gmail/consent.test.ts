import { describe, expect, it } from 'vitest';
import { AccountFilters } from '@hub/shared';
import { ConnectorError, MissingScopeError } from '../errors';
import { enabledSources, identitiesOf } from '../types';
import { GMAIL_SCOPES as S } from './config';
import { createGmailConnector } from './connector';
import { FakeGmailStore } from './fake-store';
import { GMAIL_INFO, checkGrantedScopes } from './scopes';
import { recordedRest, testCtx } from './testing';

const WORK = 'alex@company.example';
const ALL_READ = [S.readonly, S.calendarEvents, S.driveMetadata, S.chatMessages, S.chatSpaces];
const id = [S.openid, S.userinfoEmail];

describe('checkGrantedScopes', () => {
  it('accepts the full read grant and returns it', () => {
    const scope = [...ALL_READ, ...id].join(' ');
    expect(checkGrantedScopes(scope, 'read')).toEqual(scope.split(' '));
  });

  it('accepts any non-empty subset (user unticked some sources)', () => {
    expect(checkGrantedScopes([S.calendarEvents, ...id].join(' '), 'read')).toEqual([
      S.calendarEvents,
      ...id,
    ]);
    expect(checkGrantedScopes(`${S.chatSpaces} openid`, 'read')).toEqual([S.chatSpaces, 'openid']);
  });

  it('rejects a grant with no source scope at all', () => {
    expect(() => checkGrantedScopes(id.join(' '), 'read')).toThrow(MissingScopeError);
    expect(() => checkGrantedScopes(undefined, 'read')).toThrow(MissingScopeError);
  });

  it('rejects any write scope in a read grant, including gmail.send and gmail.modify', () => {
    for (const w of [
      S.send,
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/chat.messages',
    ]) {
      const e = (() => {
        try {
          checkGrantedScopes([S.readonly, w, ...id].join(' '), 'read');
        } catch (x) {
          return x;
        }
        return null;
      })();
      expect(e).toBeInstanceOf(ConnectorError);
      expect(e).not.toBeInstanceOf(MissingScopeError);
      expect((e as Error).message).toMatch(/write scopes/);
    }
    expect(() =>
      checkGrantedScopes(
        [S.readonly, 'https://www.googleapis.com/auth/contacts'].join(' '),
        'read',
      ),
    ).toThrow(/unexpected scopes/);
  });

  it('write consent needs gmail.send', () => {
    expect(() => checkGrantedScopes([S.readonly].join(' '), 'write')).toThrow(MissingScopeError);
    expect(checkGrantedScopes([S.send, ...id].join(' '), 'write')).toContain(S.send);
  });
});

describe('consent through the connector (fake mode)', () => {
  const setup = () => {
    const store = FakeGmailStore.memory();
    return { store, c: createGmailConnector({ config: { fake: true }, fakeStore: store }) };
  };

  it('records the granted scopes; enabledSources skips the unticked sources', async () => {
    const { c } = setup();
    const out = await c.connect.exchange({
      code: `fake:${WORK}|calendar,drive`,
      redirectUri: '',
      access: 'read',
    });
    const [ident] = identitiesOf(out);
    const granted = ident!.meta!.grantedScopes as string[];
    expect(granted).toContain(S.calendarEvents);
    expect(granted).toContain(S.driveMetadata);
    expect(granted).not.toContain(S.readonly);
    expect(ident!.meta!.googleUserId).toBe('108234567890123456789');
    expect(enabledSources(GMAIL_INFO, AccountFilters.parse({}), ident!.meta)).toEqual([
      'calendar',
      'drive',
    ]);
    // And the user's own toggle still applies on top.
    expect(
      enabledSources(GMAIL_INFO, AccountFilters.parse({ sources: { drive: false } }), ident!.meta),
    ).toEqual(['calendar']);
  });

  it('a full consent enables every source', async () => {
    const { c } = setup();
    const out = await c.connect.exchange({ code: `fake:${WORK}`, redirectUri: '', access: 'read' });
    expect(
      enabledSources(GMAIL_INFO, AccountFilters.parse({}), identitiesOf(out)[0]!.meta),
    ).toEqual(['mail', 'calendar', 'drive', 'chat']);
  });

  it('a read flow that comes back with gmail.send is refused', async () => {
    const { c } = setup();
    await expect(
      c.connect.exchange({ code: `fake-write:${WORK}`, redirectUri: '', access: 'read' }),
    ).rejects.toBeInstanceOf(MissingScopeError);
  });

  it('the write consent records no grantedScopes (it must not change which sources sync)', async () => {
    const { c } = setup();
    const w = await c.connect.exchange({
      code: `fake-write:${WORK}`,
      redirectUri: '',
      access: 'write',
    });
    expect(identitiesOf(w)[0]!.meta?.grantedScopes).toBeUndefined();
  });

  it('an ungranted source is a no-op instead of a 403 loop', async () => {
    const r = recordedRest({});
    const c = createGmailConnector({ config: { fake: false }, restFactory: r.factory });
    const tokens = { accessToken: 'ya29.x', scope: [S.readonly, ...id].join(' ') };
    const ctx = testCtx('calendar', { tokens, cursor: 'tok' });
    expect(await c.fetchDelta(ctx)).toEqual({ records: [], cursor: 'tok' });
    expect(await c.subscribe(ctx)).toEqual({
      externalSubId: null,
      expiresAt: null,
      meta: { unavailable: 'scope_not_granted' },
    });
    expect(r.calls).toHaveLength(0);
  });

  it('read consent URL asks for every read scope and nothing that writes', () => {
    const c = createGmailConnector({
      config: { fake: false, clientId: 'id.apps.googleusercontent.com', clientSecret: 's' },
    });
    const u = new URL(
      c.connect.authUrl({ state: 's', redirectUri: 'http://x.test/cb', access: 'read' }),
    );
    const scopes = u.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual([...ALL_READ, 'openid', 'email']);
    expect(u.searchParams.get('include_granted_scopes')).toBe('false');
  });

  it('catalog info', () => {
    expect(GMAIL_INFO.name).toBe('Google');
    expect(GMAIL_INFO.covers).toBe('Gmail, Calendar, Drive, Chat · one sign-in each');
    expect(GMAIL_INFO.sources.map((s) => [s.id, s.kind])).toEqual([
      ['mail', 'email'],
      ['calendar', 'event'],
      ['drive', 'file'],
      ['chat', 'chat'],
    ]);
    expect(GMAIL_INFO.options.map((o) => o.key)).toContain('drive.sharedOnly');
    expect(GMAIL_INFO.writeActions).toEqual(['gmail.send']);
  });
});
