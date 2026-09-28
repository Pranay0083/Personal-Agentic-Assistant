import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessRequests,
  auditLog,
  grants,
  items,
  mcpClients,
  proposals,
  pushTokens,
  sessions,
  tasks,
  users,
} from '@hub/db';
import { hashToken, type Logger } from '@hub/server';
import { buildApi } from './app';
import { setup, TEST_CONFIG, type TestEnv } from './test-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(() => env.close());

describe('auth', () => {
  it('dev sign-in creates the user and a hashed 30-day session', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/auth/dev',
      payload: { email: 'Dev@Example.com', name: 'Dev' },
      headers: { 'x-timezone': 'Europe/Berlin' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({
      email: 'dev@example.com',
      name: 'Dev',
      timezone: 'Europe/Berlin',
    });
    expect(body.user.settings.briefTime).toBe('07:30');
    const [s] = await env.t.db.select().from(sessions).where(eq(sessions.userId, body.user.id));
    expect(s!.tokenHash).toBe(hashToken(body.token));
    expect(s!.tokenHash).not.toBe(body.token);
    expect(s!.expiresAt.getTime() - env.now().getTime()).toBe(30 * 24 * 3600 * 1000);

    const again = await env.signIn('dev@example.com');
    expect(again.userId).toBe(body.user.id);
  });

  it('rejects requests without a valid session', async () => {
    expect((await env.app.inject({ url: '/me' })).statusCode).toBe(401);
    const bad = await env.app.inject({ url: '/me', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: 'unauthorized', message: 'invalid or expired session' });
    // ?token= is only accepted on the SSE route.
    const { token } = await env.signIn('q@example.com');
    expect((await env.app.inject({ url: `/me?token=${token}` })).statusCode).toBe(401);
  });

  it('accepts a session, and expires it after 30 days', async () => {
    const { auth } = await env.signIn('exp@example.com');
    const me = await env.app.inject({ url: '/me', headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('exp@example.com');
    const start = env.now();
    env.setNow(new Date(start.getTime() + 31 * 24 * 3600 * 1000));
    expect((await env.app.inject({ url: '/me', headers: auth })).statusCode).toBe(401);
    env.setNow(start);
  });

  it('signs out', async () => {
    const { auth } = await env.signIn('out@example.com');
    const res = await env.app.inject({ method: 'POST', url: '/auth/sign-out', headers: auth });
    expect(res.statusCode).toBe(204);
    expect((await env.app.inject({ url: '/me', headers: auth })).statusCode).toBe(401);
  });

  it("sign-out unregisters the device's push token, and only this user's", async () => {
    const a = await env.signIn('out-push@example.com');
    const tokensOf = (userId: string) =>
      env.t.db.select().from(pushTokens).where(eq(pushTokens.userId, userId));
    const register = (auth: Record<string, string>, token: string) =>
      env.app.inject({
        method: 'POST',
        url: '/me/push-tokens',
        headers: auth,
        payload: { token, platform: 'ios' },
      });
    await register(a.auth, 'ExponentPushToken[out-1]');
    await register(a.auth, 'ExponentPushToken[out-2]');
    const b = await env.signIn('out-push-other@example.com');
    await register(b.auth, 'ExponentPushToken[out-b]');

    // Another user's token in the body is ignored.
    const res = await env.app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: a.auth,
      payload: { pushToken: 'ExponentPushToken[out-1]' },
    });
    expect(res.statusCode).toBe(204);
    expect((await tokensOf(a.userId)).map((t) => t.token)).toEqual(['ExponentPushToken[out-2]']);

    const b2 = await env.signIn('out-push-other@example.com');
    await env.app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: b2.auth,
      payload: { pushToken: 'ExponentPushToken[out-2]' },
    });
    expect(await tokensOf(a.userId)).toHaveLength(1);
    expect(await tokensOf(b.userId)).toHaveLength(1);

    // A malformed body still signs out.
    const bad = await env.app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: b.auth,
      payload: { pushToken: 42 },
    });
    expect(bad.statusCode).toBe(204);
    expect((await env.app.inject({ url: '/me', headers: b.auth })).statusCode).toBe(401);
  });

  it('healthz is public', async () => {
    expect((await env.app.inject({ url: '/healthz' })).json()).toEqual({ ok: true });
  });

  it('dev auth is off in production and when DEV_AUTH is unset', async () => {
    for (const config of [
      { ...TEST_CONFIG, production: true },
      { ...TEST_CONFIG, devAuth: false },
    ]) {
      const app = await buildApi({ ...env.deps, config });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/dev',
        payload: { email: 'x@example.com' },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    }
  });

  it('Google sign-in verifies the ID token and upserts the user', async () => {
    env.google.set('good', { sub: '1', email: 'g@example.com', emailVerified: true, name: 'Gee' });
    env.google.set('unverified', {
      sub: '2',
      email: 'u@example.com',
      emailVerified: false,
      name: null,
    });
    const ok = await env.app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'good' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ email: 'g@example.com', name: 'Gee' });
    const bad = await env.app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'forged' },
    });
    expect(bad.statusCode).toBe(401);
    const unv = await env.app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'unverified' },
    });
    expect(unv.statusCode).toBe(401);
    const missing = await env.app.inject({ method: 'POST', url: '/auth/google', payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('invalid_request');
  });
});

describe('me', () => {
  it('merges settings instead of resetting them', async () => {
    const { auth } = await env.signIn('me@example.com');
    let res = await env.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth,
      payload: { settings: { vips: ['boss@example.com'], briefTime: '08:00' } },
    });
    expect(res.statusCode).toBe(200);
    res = await env.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth,
      payload: { settings: { notificationsEnabled: true }, role: 'build', onboarded: true },
    });
    const me = res.json();
    expect(me.settings).toMatchObject({
      vips: ['boss@example.com'],
      briefTime: '08:00',
      notificationsEnabled: true,
    });
    expect(me.role).toBe('build');
    expect(me.onboardedAt).not.toBeNull();
    const invalid = await env.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth,
      payload: { settings: { briefTime: '8am' } },
    });
    expect(invalid.statusCode).toBe(400);
    const tz = await env.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth,
      payload: { timezone: 'Mars/Olympus' },
    });
    expect(tz.statusCode).toBe(400);
  });

  it('upserts push tokens', async () => {
    const { auth } = await env.signIn('push@example.com');
    for (let i = 0; i < 2; i++) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/me/push-tokens',
        headers: auth,
        payload: { token: 'ExponentPushToken[abc]', platform: 'ios' },
      });
      expect(res.statusCode).toBe(204);
    }
  });

  it('registering a token removes it from any other user, and audits that', async () => {
    const a = await env.signIn('device-a@example.com');
    const b = await env.signIn('device-b@example.com');
    const token = 'ExponentPushToken[shared-device]';
    const register = (auth: Record<string, string>) =>
      env.app.inject({
        method: 'POST',
        url: '/me/push-tokens',
        headers: auth,
        payload: { token, platform: 'android' },
      });
    expect((await register(a.auth)).statusCode).toBe(204);
    expect((await register(b.auth)).statusCode).toBe(204);

    const rows = await env.t.db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(rows.map((r) => r.userId)).toEqual([b.userId]);
    const audits = (userId: string, action: string) =>
      env.t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));
    expect(await audits(a.userId, 'push_token.removed')).toHaveLength(1);
    expect(await audits(b.userId, 'push_token.reassigned')).toHaveLength(1);
    expect(JSON.stringify(await env.t.db.select().from(auditLog))).not.toContain('shared-device');

    // Re-registering your own token is not a reassignment.
    await register(b.auth);
    expect(await audits(b.userId, 'push_token.reassigned')).toHaveLength(1);
  });
});

describe('error logging (L1)', () => {
  it('500s log the error name, driver code and route, never the message or query params', async () => {
    const lines: string[] = [];
    const write = (...args: unknown[]) => void lines.push(JSON.stringify(args));
    const l: Record<string, unknown> = { level: 'trace', silent: () => {} };
    for (const m of ['info', 'error', 'debug', 'fatal', 'warn', 'trace']) l[m] = write;
    l.child = () => l;
    const app = await buildApi({ ...env.deps, logger: l as unknown as Logger });
    // Shaped like drizzle-orm's DrizzleQueryError: the message embeds the params.
    app.get('/boom', async () => {
      const cause = Object.assign(new Error('duplicate key value'), { code: '23505' });
      const err = new Error(
        'Failed query: insert into "items" ("body") values ($1)\nparams: SECRET-EMAIL-BODY',
        { cause },
      );
      err.name = 'DrizzleQueryError';
      throw err;
    });
    const { auth } = await env.signIn('boom@example.com');
    const res = await app.inject({ url: '/boom', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'internal error' });
    await app.close();

    const errorLine = lines.find((x) => x.includes('DrizzleQueryError'));
    expect(errorLine).toBeDefined();
    expect(JSON.parse(errorLine!)[0]).toEqual({
      err: { name: 'DrizzleQueryError', code: '23505' },
      method: 'GET',
      route: '/boom',
    });
    const all = lines.join('\n');
    expect(all).not.toContain('SECRET-EMAIL-BODY');
    expect(all).not.toContain('Failed query');
    expect(all).not.toContain('duplicate key');
  });
});

describe('cross-user isolation', () => {
  it("never exposes another user's rows by id", async () => {
    const a = await env.signIn('alice@example.com');
    const b = await env.signIn('bob@example.com');
    const { accountId } = await env.connectGmail(a.token, 'alice@company.com');
    const db = env.t.db;
    const [item] = await db
      .insert(items)
      .values({
        accountId,
        kind: 'email',
        externalId: 'm1',
        title: 'Secret plan',
        receivedAt: env.now(),
      })
      .returning();
    const [task] = await db.insert(tasks).values({ userId: a.userId, title: 'A task' }).returning();
    const [proposal] = await db
      .insert(proposals)
      .values({
        userId: a.userId,
        accountId,
        agent: 'agent:reply',
        action: 'gmail.send',
        title: 'Reply',
        payload: { to: ['x@example.com'], subject: 's', body: 'b' },
        idempotencyKey: 'iso-1',
      })
      .returning();
    const [request] = await db
      .insert(accessRequests)
      .values({ userId: a.userId, principal: 'mcp:x', resource: 'email', accountId })
      .returning();
    const [grant] = await db
      .insert(grants)
      .values({
        userId: a.userId,
        principal: 'mcp:x',
        scope: 'email',
        expiresAt: new Date(env.now().getTime() + 3600e3),
      })
      .returning();
    const [client] = await db
      .insert(mcpClients)
      .values({ userId: a.userId, name: 'Claude Code', tokenHash: 'h-iso' })
      .returning();

    const asBob = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object) =>
      env.app.inject({ method, url, headers: b.auth, ...(payload ? { payload } : {}) });

    const attempts = [
      await asBob('GET', `/items/${item!.id}`),
      await asBob('PATCH', `/accounts/${accountId}`, { nickname: 'Hacked' }),
      await asBob('POST', `/accounts/${accountId}/sync`),
      await asBob('POST', `/accounts/${accountId}/write-access`),
      await asBob('POST', `/accounts/${accountId}/apply-settings-to-provider`),
      await asBob('DELETE', `/accounts/${accountId}`),
      await asBob('PATCH', `/tasks/${task!.id}`, { status: 'done' }),
      await asBob('POST', `/proposals/${proposal!.id}/approve`),
      await asBob('POST', `/proposals/${proposal!.id}/reject`),
      await asBob('POST', `/access-requests/${request!.id}/allow`, { durationMinutes: 60 }),
      await asBob('POST', `/access-requests/${request!.id}/deny`),
      await asBob('DELETE', `/grants/${grant!.id}`),
      await asBob('DELETE', `/mcp/clients/${client!.id}`),
    ];
    for (const r of attempts) expect(r.statusCode, r.body).toBe(404);

    // Filtering by someone else's account id returns nothing.
    const list = await asBob('GET', `/items?accountId=${accountId}`);
    expect(list.json().items).toEqual([]);
    expect((await asBob('GET', '/accounts')).json().accounts).toEqual([]);
    expect((await asBob('GET', '/tasks')).json().tasks).toEqual([]);
    expect((await asBob('GET', '/proposals')).json().proposals).toEqual([]);
    expect((await asBob('GET', '/access-requests')).json().requests).toEqual([]);
    expect((await asBob('GET', '/mcp')).json().clients).toEqual([]);
    const policy = await asBob('PUT' as 'POST', '/policies', {
      principal: 'agent:triage',
      provider: null,
      accountId,
      resource: 'email',
      level: 'none',
    });
    expect(policy.statusCode).toBe(404);

    // Nothing changed for Alice.
    const [still] = await db.select().from(proposals).where(eq(proposals.id, proposal!.id));
    expect(still!.status).toBe('pending');
    const [u] = await db.select().from(users).where(eq(users.id, a.userId));
    expect(u).toBeDefined();
    expect(env.jobs.filter((j) => j.name === 'executor')).toEqual([]);
  });
});
