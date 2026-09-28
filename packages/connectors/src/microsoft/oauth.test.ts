import { describe, expect, it } from 'vitest';
import { ConnectorError, MissingScopeError, ReconnectRequiredError } from '../errors';
import { isWriteScope, MS_READ_SCOPES } from './config';
import { NOW, WORK_ID, fx, replay, testCtx } from './test-helpers';

const TOKEN = 'POST /common/oauth2/v2.0/token';
const WRITE_APP = { writeClientId: 'client-write', writeClientSecret: 'secret-write' };

describe('microsoft oauth', () => {
  it('asks for delegated read-only scopes on connect and only Mail.Send for writes', () => {
    const { connector } = replay({}, WRITE_APP);
    const read = new URL(
      connector.connect.authUrl({
        state: 's1',
        redirectUri: 'https://api.hub.example/oauth/microsoft/callback',
        access: 'read',
        loginHint: 'avery.chen@contoso.example',
      }),
    );
    expect(read.origin + read.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    const scopes = read.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual([...MS_READ_SCOPES]);
    expect(scopes.some(isWriteScope)).toBe(false);
    expect(scopes).not.toContain('ChannelMessage.Read.All');
    expect(read.searchParams.get('prompt')).toBe('select_account');
    expect(read.searchParams.get('login_hint')).toBe('avery.chen@contoso.example');
    expect(read.searchParams.get('state')).toBe('s1');

    const write = new URL(
      connector.connect.authUrl({ state: 's2', redirectUri: 'https://x/cb', access: 'write' }),
    );
    const w = write.searchParams.get('scope')!.split(' ');
    expect(w).toContain('Mail.Send');
    expect(w.filter(isWriteScope)).toEqual(['Mail.Send']);
  });

  it('adds the admin-consent channel scope only when enabled', () => {
    const { connector } = replay({}, { channelMessages: true });
    const u = new URL(
      connector.connect.authUrl({ state: 's', redirectUri: 'https://x/cb', access: 'read' }),
    );
    expect(u.searchParams.get('scope')).toContain('ChannelMessage.Read.All');
  });

  it('uses a separate app for the write consent when configured', () => {
    const { connector } = replay(
      {},
      { writeClientId: 'client-write', writeClientSecret: 'secret-write' },
    );
    const r = new URL(
      connector.connect.authUrl({ state: 's', redirectUri: 'https://x', access: 'read' }),
    );
    const w = new URL(
      connector.connect.authUrl({ state: 's', redirectUri: 'https://x', access: 'write' }),
    );
    expect(r.searchParams.get('client_id')).toBe('client-read');
    expect(w.searchParams.get('client_id')).toBe('client-write');
  });

  it('exchanges a work account: object id, UPN, tenant and granted scopes in meta', async () => {
    const { connector, calls } = replay({
      [TOKEN]: fx('token-read-work.json'),
      'GET /v1.0/me': fx('me-work.json'),
    });
    const out = await connector.connect.exchange({
      code: 'code-1',
      redirectUri: 'https://x/cb',
      access: 'read',
    });
    expect(out.externalId).toBe(WORK_ID);
    expect(out.displayName).toBe('avery.chen@contoso.example');
    expect(out.tokens.refreshToken).toBe('0.AXkAfixture-refresh-read');
    expect(out.tokens.expiresAt).toBe(NOW + 4153 * 1000);
    const meta = out.identities![0]!.meta!;
    expect(meta).toMatchObject({
      tenantId: '2f8e4b1c-7a3d-4e9f-b6c5-1d2e3f4a5b6c',
      upn: 'avery.chen@contoso.example',
      mail: 'avery.chen@contoso.example',
      personal: false,
    });
    expect(meta.grantedScopes).toEqual(
      expect.arrayContaining([
        'Mail.Read',
        'Calendars.Read',
        'Chat.Read',
        'Files.Read',
        'User.Read',
      ]),
    );
    const tokenCall = calls.find((c) => c.url.pathname.endsWith('/token'))!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')).toBe('secret-read');
    // /me is called with the new access token.
    const me = calls.find((c) => c.url.pathname === '/v1.0/me')!;
    expect(me.headers.authorization).toMatch(/^Bearer /);
  });

  it('marks personal Microsoft accounts (MSA tenant) and strips Graph scope prefixes', async () => {
    const { connector } = replay({
      [TOKEN]: fx('token-read-personal.json'),
      'GET /v1.0/me': fx('me-personal.json'),
    });
    const out = await connector.connect.exchange({
      code: 'c',
      redirectUri: 'https://x',
      access: 'read',
    });
    expect(out.externalId).toBe('0d4e7a1b9c3f5e28');
    expect(out.displayName).toBe('sam.rivera@outlook.example');
    const meta = out.identities![0]!.meta!;
    expect(meta.personal).toBe(true);
    expect(meta.tenantId).toBe('9188040d-6c67-4c5b-b112-36a304b66dad');
    expect(meta.unavailableSources).toEqual(['teams', 'channels']);
    expect(meta.grantedScopes).toContain('Mail.Read');
    expect((meta.grantedScopes as string[]).some((s) => s.startsWith('https://'))).toBe(false);
  });

  it('refuses a read grant that carries a write scope', async () => {
    const { connector } = replay({
      [TOKEN]: fx('token-read-with-send.json'),
      'GET /v1.0/me': fx('me-work.json'),
    });
    const err = (await connector.connect
      .exchange({ code: 'c', redirectUri: 'https://x', access: 'read' })
      .catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.message).toContain('write scopes');
  });

  it('requires offline_access (a refresh token) for reads and Mail.Send for writes', async () => {
    const noRefresh = replay({ [TOKEN]: fx('token-read-no-refresh.json') });
    await expect(
      noRefresh.connector.connect.exchange({ code: 'c', redirectUri: 'https://x', access: 'read' }),
    ).rejects.toBeInstanceOf(MissingScopeError);

    const readAsWrite = replay({ [TOKEN]: fx('token-read-work.json') }, WRITE_APP);
    const e = (await readAsWrite.connector.connect
      .exchange({ code: 'c', redirectUri: 'https://x', access: 'write' })
      .catch((x: unknown) => x)) as MissingScopeError;
    expect(e).toBeInstanceOf(MissingScopeError);
    expect(e.missing).toEqual(['Mail.Send']);

    const write = replay(
      { [TOKEN]: fx('token-write-work.json'), 'GET /v1.0/me': fx('me-work.json') },
      WRITE_APP,
    );
    const ok = await write.connector.connect.exchange({
      code: 'c',
      redirectUri: 'https://x',
      access: 'write',
    });
    expect(ok.externalId).toBe(WORK_ID);
  });

  it('treats a refused code as a failed connect, not a reconnect', async () => {
    const { connector } = replay({
      [TOKEN]: { status: 400, body: fx('token-invalid-grant.json') },
    });
    const e = await connector.connect
      .exchange({ code: 'used', redirectUri: 'https://x', access: 'read' })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConnectorError);
    expect(e).not.toBeInstanceOf(ReconnectRequiredError);
  });

  it('refreshes an expiring token with the read scopes and saves the rotated tokens', async () => {
    const { connector, calls } = replay({
      [TOKEN]: fx('token-refresh.json'),
      'GET /v1.0/me/drive/root/delta': fx('drive-delta-latest.json'),
    });
    const ctx = testCtx({
      source: 'onedrive',
      tokens: { accessToken: 'old', refreshToken: 'rt-old', expiresAt: NOW + 10_000 },
    });
    await connector.fetchDelta(ctx);
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('scope')).toContain('Mail.Read');
    expect(form.get('scope')).not.toContain('Mail.Send');
    expect(ctx.saved[0]).toMatchObject({ refreshToken: '0.AXkAfixture-refresh-rotated' });
    expect(calls[1]!.headers.authorization).toBe(
      'Bearer fixture-access-refreshed',
    );
  });

  it('maps a revoked refresh token to ReconnectRequiredError', async () => {
    const { connector } = replay({
      [TOKEN]: { status: 400, body: fx('token-invalid-grant.json') },
    });
    const ctx = testCtx({
      source: 'onedrive',
      tokens: { accessToken: 'old', refreshToken: 'rt-old', expiresAt: NOW - 1 },
    });
    await expect(connector.fetchDelta(ctx)).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it('is configured with client credentials', () => {
    expect(replay({}).connector.configured()).toBe(true);
    expect(replay({}, { clientId: undefined }).connector.configured()).toBe(false);
    expect(replay({}, { clientId: undefined, fake: true }).connector.configured()).toBe(true);
  });

  it('offers the write consent only with a separate write app (or fake mode)', async () => {
    expect(replay({}).connector.writeConfigured!()).toBe(false);
    expect(replay({}, { writeClientId: 'client-write' }).connector.writeConfigured!()).toBe(false);
    expect(replay({}, WRITE_APP).connector.writeConfigured!()).toBe(true);
    expect(replay({}, { fake: true }).connector.writeConfigured!()).toBe(true);

    const { connector, calls } = replay({ [TOKEN]: fx('token-write-work.json') });
    expect(() =>
      connector.connect.authUrl({ state: 's', redirectUri: 'https://x', access: 'write' }),
    ).toThrow(ConnectorError);
    // Never falls back to the read app for a write code exchange either.
    await expect(
      connector.connect.exchange({ code: 'c', redirectUri: 'https://x', access: 'write' }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a refreshed read token that carries a write scope and does not save it', async () => {
    const { connector, calls } = replay({
      [TOKEN]: {
        ...fx<Record<string, unknown>>('token-refresh.json'),
        scope: 'Calendars.Read Mail.Read Mail.Send User.Read openid profile email',
      },
      'GET /v1.0/me/drive/root/delta': fx('drive-delta-latest.json'),
    });
    const ctx = testCtx({
      source: 'onedrive',
      tokens: { accessToken: 'old', refreshToken: 'rt-old', expiresAt: NOW + 10_000 },
    });
    await expect(connector.fetchDelta(ctx)).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(ctx.saved).toHaveLength(0);
    expect(ctx.tokens.accessToken).toBe('old');
    expect(calls.filter((c) => c.url.pathname.startsWith('/v1.0/'))).toHaveLength(0);
  });
});
