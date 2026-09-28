import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, auditLog, items, policies, secrets, subscriptions } from '@hub/db';
import { ConnectorCatalogRes } from '@hub/shared/api';
import { createGmailConnector, FakeGmailStore } from '@hub/connectors/gmail';
import { strictPersonalPolicies } from '@hub/policy';
import { setup, rawAccess, rawRefresh, type TestEnv } from './test-helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(() => env.close());

/** Every row of every table in the public schema, as JSON text. */
async function dumpAllTables(): Promise<string> {
  const tables = await env.t.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  let out = '';
  for (const { table_name } of tables) {
    const rows = await env.t.db.execute(
      sql`select row_to_json(t)::text as j from ${sql.identifier(table_name)} t`,
    );
    out += rows.map((r) => (r as { j: string }).j).join('\n');
  }
  return out;
}

describe('OAuth connect', () => {
  it('connect returns a provider URL with a signed state; unknown providers are 400', async () => {
    const { auth } = await env.signIn('conn@example.com');
    const res = await env.app.inject({
      method: 'POST',
      url: '/accounts/gmail/connect',
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().url);
    expect(url.searchParams.get('redirect_uri')).toBe('http://api.test/oauth/google/callback');
    expect(url.searchParams.get('access')).toBe('read');
    expect(url.searchParams.get('state')!.split('.')).toHaveLength(3);
    const slack = await env.app.inject({
      method: 'POST',
      url: '/accounts/slack/connect',
      headers: auth,
      payload: {},
    });
    expect(slack.statusCode).toBe(400);
    const nope = await env.app.inject({
      method: 'POST',
      url: '/accounts/myspace/connect',
      headers: auth,
      payload: {},
    });
    expect(nope.statusCode).toBe(400);
    const evil = await env.app.inject({
      method: 'POST',
      url: '/accounts/gmail/connect',
      headers: auth,
      payload: { redirectUri: 'https://evil.example/steal' },
    });
    expect(evil.statusCode).toBe(400);
  });

  it('callback stores only token_ref, never raw tokens, and connects two Gmail accounts', async () => {
    const { token, userId, auth } = await env.signIn('two@example.com');
    const work = await env.connectGmail(token, 'me@company.com');
    expect(work.res.statusCode).toBe(302);
    expect(work.location).toBe(`hub://connected?pending=${work.pending}`);
    expect(work.complete.json()).toMatchObject({
      access: 'read',
      account: { id: work.accountId, externalId: 'me@company.com' },
    });
    // The connector's scope check runs: exchange is told which access was asked for.
    expect(env.gmail.exchangedAccess.at(-1)).toBe('read');
    const personal = await env.connectGmail(token, 'me@gmail.com');
    expect(personal.accountId).not.toBe(work.accountId);

    const list = (await env.app.inject({ url: '/accounts', headers: auth })).json().accounts;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      id: work.accountId,
      provider: 'gmail',
      nickname: 'Work',
      color: '#1F6F6B',
      externalId: 'me@company.com',
      status: 'connecting',
      isPersonal: false,
      backfillDays: 30,
      filters: { inbox: true, sent: true, promotions: false, labels: [] },
    });
    expect(list[1]).toMatchObject({ nickname: 'Personal', color: '#3B5BA9', isPersonal: true });
    expect(JSON.stringify(list)).not.toMatch(/token/i);

    const [row] = await env.t.db.select().from(accounts).where(eq(accounts.id, work.accountId));
    expect(row!.tokenRef).toBeTruthy();
    expect(await env.secrets.getJson(row!.tokenRef!)).toEqual({
      accessToken: rawAccess('me@company.com'),
      refreshToken: rawRefresh('me@company.com'),
    });

    const dump = await dumpAllTables();
    for (const mailbox of ['me@company.com', 'me@gmail.com']) {
      expect(dump).not.toContain(rawAccess(mailbox));
      expect(dump).not.toContain(rawRefresh(mailbox));
      expect(dump).not.toContain('RAWACCESS');
    }

    const audits = await env.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'account.connected')));
    expect(audits).toHaveLength(2);
  });

  it('reconnecting the same mailbox updates the account instead of duplicating it', async () => {
    const { token, auth } = await env.signIn('re@example.com');
    const a = await env.connectGmail(token, 're@company.com');
    const b = await env.connectGmail(token, 're@company.com');
    expect(b.accountId).toBe(a.accountId);
    expect(
      (await env.app.inject({ url: '/accounts', headers: auth })).json().accounts,
    ).toHaveLength(1);
  });

  it('personal accounts get the strict policies, and toggling strictPersonal removes them', async () => {
    const { token, userId, auth } = await env.signIn('strict@example.com');
    const { accountId } = await env.connectGmail(token, 'strict@googlemail.com');
    const rows = await env.t.db.select().from(policies).where(eq(policies.accountId, accountId));
    expect(rows).toHaveLength(strictPersonalPolicies(accountId).length);
    expect(rows.find((r) => r.principal === 'mcp:*' && r.resource === 'email')!.level).toBe('none');
    expect(
      rows.find((r) => r.principal === 'agent:*' && r.resource === 'message.send')!.level,
    ).toBe('never');

    await env.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth,
      payload: { strictPersonal: false },
    });
    expect(await env.t.db.select().from(policies).where(eq(policies.userId, userId))).toHaveLength(
      0,
    );
    await env.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth,
      payload: { strictPersonal: true },
    });
    expect(await env.t.db.select().from(policies).where(eq(policies.userId, userId))).toHaveLength(
      rows.length,
    );

    // Marking a work account personal applies them too; unmarking removes them.
    const work = await env.connectGmail(token, 'strict@company.com');
    await env.app.inject({
      method: 'PATCH',
      url: `/accounts/${work.accountId}`,
      headers: auth,
      payload: { isPersonal: true },
    });
    expect(
      await env.t.db.select().from(policies).where(eq(policies.accountId, work.accountId)),
    ).toHaveLength(rows.length);
    await env.app.inject({
      method: 'PATCH',
      url: `/accounts/${work.accountId}`,
      headers: auth,
      payload: { isPersonal: false },
    });
    expect(
      await env.t.db.select().from(policies).where(eq(policies.accountId, work.accountId)),
    ).toHaveLength(0);
  });

  it('handles access_denied and a bad or expired state', async () => {
    const { auth } = await env.signIn('deny@example.com');
    const res = await env.app.inject({
      method: 'POST',
      url: '/accounts/gmail/connect',
      headers: auth,
      payload: { redirectUri: 'exp://192.168.1.2:8081/--/connected' },
    });
    const state = new URL(res.json().url).searchParams.get('state')!;
    const denied = await env.app.inject({
      url: `/oauth/google/callback?state=${state}&error=access_denied`,
    });
    expect(denied.statusCode).toBe(302);
    expect(denied.headers.location).toBe('exp://192.168.1.2:8081/--/connected?error=access_denied');

    const forged = await env.app.inject({
      url: `/oauth/google/callback?state=${state}x&code=fake:a@b.com`,
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error).toBe('invalid_state');

    const start = env.now();
    env.setNow(new Date(start.getTime() + 11 * 60 * 1000));
    const late = await env.app.inject({
      url: `/oauth/google/callback?state=${state}&code=fake:a@b.com`,
    });
    expect(late.statusCode).toBe(400);
    env.setNow(start);
  });

  it('write access stores write_token_ref separately and requires the same mailbox', async () => {
    const { token, auth } = await env.signIn('write@example.com');
    const { accountId } = await env.connectGmail(token, 'write@company.com');
    const res = await env.app.inject({
      method: 'POST',
      url: `/accounts/${accountId}/write-access`,
      headers: auth,
      payload: {},
    });
    const url = new URL(res.json().url);
    expect(url.searchParams.get('access')).toBe('write');
    expect(url.searchParams.get('login_hint')).toBe('write@company.com');

    const writeFlow = async (mailbox: string) => {
      const state = await env.startConnect(token, `/accounts/${accountId}/write-access`);
      const cb = await env.callback(state, `fake:${mailbox}`);
      return env.complete(token, cb.pending!);
    };

    const wrong = await writeFlow('other@company.com');
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe('account_mismatch');
    const [before] = await env.t.db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(before!.writeTokenRef).toBeNull();

    const ok = await writeFlow('write@company.com');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ access: 'write', account: { id: accountId } });
    expect(env.gmail.exchangedAccess.at(-1)).toBe('write');
    const [row] = await env.t.db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(row!.writeTokenRef).toBeTruthy();
    expect(row!.writeTokenRef).not.toBe(row!.tokenRef);
    const [secret] = await env.t.db
      .select()
      .from(secrets)
      .where(eq(secrets.id, row!.writeTokenRef!));
    expect(secret!.kind).toBe('oauth:gmail:write');
  });
});

describe('connect is bound to the user who started it (M1)', () => {
  const accountsOf = (userId: string) =>
    env.t.db.select().from(accounts).where(eq(accounts.userId, userId));
  const secretsOf = (userId: string) =>
    env.t.db.select().from(secrets).where(eq(secrets.userId, userId));
  const auditsOf = (userId: string, action: string) =>
    env.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));

  it('the callback creates nothing; the account appears only after /accounts/complete', async () => {
    const { token, userId } = await env.signIn('lazy@example.com');
    const state = await env.startConnect(token);
    const cb = await env.callback(state, 'fake:lazy@company.com');
    expect(cb.res.statusCode).toBe(302);
    expect(cb.location).toBe(`hub://connected?pending=${cb.pending}`);
    expect(cb.pending!.length).toBeGreaterThanOrEqual(16);

    expect(env.gmail.exchanged).not.toContain('lazy@company.com');
    expect(await accountsOf(userId)).toHaveLength(0);
    expect(await secretsOf(userId)).toHaveLength(0);
    expect(await auditsOf(userId, 'account.connected')).toHaveLength(0);
    // The code is sealed at rest, and the pending id is not the key.
    const stored = [...env.oauth.entries.entries()].map(([k, v]) => k + v.value).join('\n');
    expect(stored).not.toContain('lazy@company.com');
    expect(stored).not.toContain(cb.pending!);

    const done = await env.complete(token, cb.pending!);
    expect(done.statusCode).toBe(200);
    expect(await accountsOf(userId)).toHaveLength(1);
    expect(await auditsOf(userId, 'account.connected')).toHaveLength(1);
  });

  it('complete requires a session', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/accounts/complete',
      payload: { pending: 'x'.repeat(43) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a flow started by an attacker and approved by a victim attaches nobody's mailbox", async () => {
    const attacker = await env.signIn('attacker@example.com');
    const victim = await env.signIn('victim@example.com');
    // The attacker starts a connect and sends the consent URL to the victim, who approves.
    const state = await env.startConnect(attacker.token);
    const cb = await env.callback(state, 'fake:victim@company.com');
    expect(cb.pending).toBeTruthy();

    // The victim's app finishes the flow with the victim's session.
    const res = await env.complete(victim.token, cb.pending!);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('connect_user_mismatch');
    // The pending entry is gone: the attacker can't pick it up either.
    const again = await env.complete(attacker.token, cb.pending!);
    expect(again.statusCode).toBe(400);

    expect(env.gmail.exchanged).not.toContain('victim@company.com');
    for (const u of [attacker, victim]) {
      expect(await accountsOf(u.userId)).toHaveLength(0);
      expect(await secretsOf(u.userId)).toHaveLength(0);
      expect(await auditsOf(u.userId, 'account.connect_user_mismatch')).toHaveLength(1);
    }
  });

  it('a state is single-use: replaying it is rejected, whatever the first outcome', async () => {
    const { token, userId } = await env.signIn('replay@example.com');
    const state = await env.startConnect(token);
    const first = await env.callback(state, 'fake:replay@company.com');
    expect(first.pending).toBeTruthy();
    const replay = await env.callback(state, 'fake:replay@company.com');
    expect(replay.res.statusCode).toBe(400);
    expect(replay.res.json().error).toBe('invalid_state');
    expect(replay.pending).toBeNull();

    // A denied consent spends the state too.
    const denied = await env.startConnect(token);
    const d1 = await env.app.inject({
      url: `/oauth/google/callback?state=${denied}&error=access_denied`,
    });
    expect(d1.statusCode).toBe(302);
    const d2 = await env.callback(denied, 'fake:replay@company.com');
    expect(d2.res.statusCode).toBe(400);

    expect(await accountsOf(userId)).toHaveLength(0);
  });

  it('a pending id is single-use and expires after 10 minutes', async () => {
    const { token, userId } = await env.signIn('pending@example.com');
    const a = await env.callback(await env.startConnect(token), 'fake:pending-a@company.com');
    expect((await env.complete(token, a.pending!)).statusCode).toBe(200);
    const reused = await env.complete(token, a.pending!);
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error).toBe('connect_expired');

    const b = await env.callback(await env.startConnect(token), 'fake:pending-b@company.com');
    const start = env.now();
    env.setNow(new Date(start.getTime() + 11 * 60 * 1000));
    try {
      const late = await env.complete(token, b.pending!);
      expect(late.statusCode).toBe(400);
      expect(late.json().error).toBe('connect_expired');
    } finally {
      env.setNow(start);
    }

    const unknown = await env.complete(token, 'A'.repeat(43));
    expect(unknown.statusCode).toBe(400);
    const rows = await accountsOf(userId);
    expect(rows.map((r) => r.externalId)).toEqual(['pending-a@company.com']);
    expect(env.gmail.exchanged).not.toContain('pending-b@company.com');
  });
});

describe('read-only scope check (M2)', () => {
  it('a read flow that gets a write-scope grant is rejected with missing_scope; no token stored', async () => {
    // The real Gmail connector in fake mode, so its own checkScopes runs.
    const store = FakeGmailStore.memory();
    const gmail = createGmailConnector({ config: { fake: true }, fakeStore: store });
    const scoped = await setup({ getConnector: (p) => (p === 'gmail' ? gmail : undefined) });
    try {
      const { token, userId } = await scoped.signIn('scope@example.com');
      const mailbox = store.emails()[0]!;
      const run = async (code: string) => {
        const cb = await scoped.callback(await scoped.startConnect(token), code);
        return scoped.complete(token, cb.pending!);
      };

      // The consent screen handed back gmail.send instead of gmail.readonly.
      const bad = await run(`fake-write:${mailbox}`);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('missing_scope');
      expect(await scoped.t.db.select().from(accounts)).toHaveLength(0);
      expect(
        await scoped.t.db.select().from(secrets).where(eq(secrets.userId, userId)),
      ).toHaveLength(0);
      const failed = await scoped.t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'account.connect_failed')));
      expect(failed.map((a) => (a.details as { error: string }).error)).toEqual(['missing_scope']);

      // A proper read-only grant still connects.
      const ok = await run(`fake:${mailbox}`);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().account.externalId).toBe(mailbox);
    } finally {
      await scoped.close();
    }
  });
});

describe('account settings', () => {
  it('first backfill choice enqueues once and sets importing; widening enqueues again', async () => {
    const { token, auth } = await env.signIn('bf@example.com');
    const { accountId } = await env.connectGmail(token, 'bf@company.com');
    const patch = (payload: object) =>
      env.app.inject({ method: 'PATCH', url: `/accounts/${accountId}`, headers: auth, payload });

    let res = await patch({ backfillDays: 30, filters: { promotions: true }, nickname: 'Acme' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'importing',
      backfillDays: 30,
      nickname: 'Acme',
      filters: { inbox: true, sent: true, promotions: true, labels: [] },
    });
    const mine = () =>
      env.jobs.filter((j) => (j.data as { accountId: string }).accountId === accountId);
    expect(mine()).toEqual([
      {
        name: 'backfill',
        data: { accountId, days: 30 },
        opts: { jobId: `backfill:${accountId}:30` },
      },
    ]);

    // Filters merge: only sent keys change.
    res = await patch({ filters: { sent: false } });
    expect(res.json().filters).toEqual({
      inbox: true,
      sent: false,
      promotions: true,
      labels: [],
      sources: {},
      options: {},
    });

    await patch({ backfillDays: 7 });
    expect(mine()).toHaveLength(1);
    await patch({ backfillDays: 90 });
    expect(mine().map((j) => j.opts?.jobId)).toEqual([
      `backfill:${accountId}:30`,
      `backfill:${accountId}:90`,
    ]);

    expect((await patch({ backfillDays: 14 })).statusCode).toBe(400);
    expect((await patch({ color: 'red' })).statusCode).toBe(400);
  });

  it('applies settings to the other accounts of the same provider', async () => {
    const { token, auth } = await env.signIn('apply@example.com');
    const a = await env.connectGmail(token, 'a@company.com');
    const b = await env.connectGmail(token, 'b@company.com');
    await env.app.inject({
      method: 'PATCH',
      url: `/accounts/${a.accountId}`,
      headers: auth,
      payload: { filters: { labels: ['Projects'] }, backfillDays: 90 },
    });
    const res = await env.app.inject({
      method: 'POST',
      url: `/accounts/${a.accountId}/apply-settings-to-provider`,
      headers: auth,
    });
    expect(res.json()).toEqual({ updated: 1 });
    const [other] = await env.t.db.select().from(accounts).where(eq(accounts.id, b.accountId));
    expect(other!.backfillDays).toBe(90);
    expect(other!.filters).toMatchObject({ labels: ['Projects'] });
    expect(env.jobs.some((j) => j.opts?.jobId === `backfill:${b.accountId}:90`)).toBe(true);
  });

  it('manual sync enqueues a sync job and returns 202', async () => {
    const { token, auth } = await env.signIn('sync@example.com');
    const { accountId } = await env.connectGmail(token, 'sync@company.com');
    const res = await env.app.inject({
      method: 'POST',
      url: `/accounts/${accountId}/sync`,
      headers: auth,
    });
    expect(res.statusCode).toBe(202);
    const job = env.jobs.find(
      (j) => j.name === 'sync' && (j.data as { accountId: string }).accountId === accountId,
    );
    expect(job!.data).toEqual({ accountId, reason: 'manual' });
  });

  it('delete revokes at the provider, deletes secrets, items and the account, and audits', async () => {
    const { token, userId, auth } = await env.signIn('del@example.com');
    const { accountId } = await env.connectGmail(token, 'del@company.com');
    await env.t.db
      .insert(items)
      .values({ accountId, kind: 'email', externalId: 'd1', receivedAt: env.now() });
    const [row] = await env.t.db.select().from(accounts).where(eq(accounts.id, accountId));

    const res = await env.app.inject({
      method: 'DELETE',
      url: `/accounts/${accountId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(env.gmail.revoked).toContain(rawAccess('del@company.com'));
    expect(await env.t.db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(
      0,
    );
    expect(await env.t.db.select().from(items).where(eq(items.accountId, accountId))).toHaveLength(
      0,
    );
    expect(
      await env.t.db.select().from(secrets).where(eq(secrets.id, row!.tokenRef!)),
    ).toHaveLength(0);
    const audits = await env.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'account.deleted')));
    expect(audits).toHaveLength(1);
  });
});

describe('other providers: multi-identity consents', () => {
  /** Full connect flow for the fake Atlassian connector; returns the complete response. */
  async function connectSites(token: string, code: string) {
    const state = await env.startConnect(token, '/accounts/atlassian/connect');
    const cb = await env.callback(state, code, 'atlassian');
    if (!cb.pending) throw new Error(`callback failed: ${cb.location || cb.res.body}`);
    return env.complete(token, cb.pending);
  }
  const rowsOf = (userId: string) =>
    env.t.db.select().from(accounts).where(eq(accounts.userId, userId));
  const readSecretsOf = (userId: string) =>
    env.t.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.userId, userId), eq(secrets.kind, 'oauth:atlassian')));

  it('connect works for any implemented, configured provider; others are 400', async () => {
    const { auth } = await env.signIn('providers@example.com');
    const post = (p: string) =>
      env.app.inject({ method: 'POST', url: `/accounts/${p}/connect`, headers: auth, payload: {} });
    const ok = await post('atlassian');
    expect(ok.statusCode).toBe(200);
    expect(new URL(ok.json().url).searchParams.get('redirect_uri')).toBe(
      'http://api.test/oauth/atlassian/callback',
    );
    for (const p of ['notion', 'slack', 'nope']) {
      const r = await post(p);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('unsupported_provider');
    }
  });

  it('one consent adds one account per identity, all sharing one token secret', async () => {
    const { token, userId } = await env.signIn('sites@example.com');
    const res = await connectSites(token, 'fake-sites:sam:acme,beta,nameless');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access).toBe('read');
    expect(body.accounts.map((a: { externalId: string }) => a.externalId)).toEqual([
      'cloud-acme',
      'cloud-beta',
      'cloud-nameless',
    ]);
    expect(body.account).toEqual(body.accounts[0]);
    // Site names become nicknames; a site without a name falls back to Work.
    expect(body.accounts.map((a: { nickname: string }) => a.nickname)).toEqual([
      'Acme',
      'Beta',
      'Work',
    ]);
    expect(new Set(body.accounts.map((a: { color: string }) => a.color)).size).toBe(3);
    expect(body.accounts.every((a: { isPersonal: boolean }) => !a.isPersonal)).toBe(true);

    const rows = await rowsOf(userId);
    expect(new Set(rows.map((r) => r.tokenRef)).size).toBe(1);
    expect(await readSecretsOf(userId)).toHaveLength(1);
    const acme = rows.find((r) => r.externalId === 'cloud-acme')!;
    expect(acme.routeKeys).toEqual(['cloud-acme']);
    expect(acme.meta).toEqual({
      siteUrl: 'https://acme.atlassian.example',
      grantedScopes: ['read:jira-work', 'read:confluence-content.all', 'offline_access'],
    });
    expect(JSON.stringify(body)).not.toMatch(/RAW|token_ref|tokenRef|grantedScopes/);

    // Reconnecting the same consent reuses the accounts and the one secret.
    const again = await connectSites(token, 'fake-sites:sam:acme,beta,nameless');
    expect(again.json().accounts.map((a: { id: string }) => a.id)).toEqual(
      body.accounts.map((a: { id: string }) => a.id),
    );
    expect(await readSecretsOf(userId)).toHaveLength(1);
    expect(await rowsOf(userId)).toHaveLength(3);

    // A consent covering only some of them gets its own secret; the others keep theirs.
    const partial = await connectSites(token, 'fake-sites:sam:acme');
    expect(partial.json().accounts).toHaveLength(1);
    const after = await rowsOf(userId);
    const refOf = (ext: string) => after.find((r) => r.externalId === ext)!.tokenRef;
    expect(refOf('cloud-acme')).not.toBe(refOf('cloud-beta'));
    expect(refOf('cloud-beta')).toBe(refOf('cloud-nameless'));
    expect(await readSecretsOf(userId)).toHaveLength(2);
    expect(await env.secrets.getJson(refOf('cloud-acme')!)).toMatchObject({
      accessToken: rawAccess('sam@acme'),
    });
  });

  it('delete keeps a shared secret until its last account goes', async () => {
    const { token, userId, auth } = await env.signIn('shared-del@example.com');
    const res = await connectSites(token, 'fake-sites:kim:one,two');
    const [one, two] = res.json().accounts as { id: string }[];
    const [row] = await env.t.db.select().from(accounts).where(eq(accounts.id, one!.id));
    const ref = row!.tokenRef!;
    // Both also share a write token (as the executor would see after a shared write grant).
    const writeRef = await env.secrets.put(userId, 'oauth:atlassian:write', '{"accessToken":"w"}');
    await env.t.db
      .update(accounts)
      .set({ writeTokenRef: writeRef })
      .where(inArray(accounts.id, [one!.id, two!.id]));
    const revokeJobs = () =>
      env.jobs.filter(
        (j) => j.name === 'executor' && (j.data as { secretRef?: string }).secretRef === writeRef,
      );
    const del = (id: string) =>
      env.app.inject({ method: 'DELETE', url: `/accounts/${id}`, headers: auth });

    expect((await del(one!.id)).statusCode).toBe(204);
    expect(env.sites.revoked).not.toContain(rawAccess('kim@one,two'));
    expect(await env.t.db.select().from(secrets).where(eq(secrets.id, ref))).toHaveLength(1);
    expect(revokeJobs()).toHaveLength(0);
    const [still] = await env.t.db.select().from(accounts).where(eq(accounts.id, two!.id));
    expect(still!.tokenRef).toBe(ref);
    expect(still!.writeTokenRef).toBe(writeRef);

    expect((await del(two!.id)).statusCode).toBe(204);
    expect(env.sites.revoked).toContain(rawAccess('kim@one,two'));
    expect(await env.t.db.select().from(secrets).where(eq(secrets.id, ref))).toHaveLength(0);
    expect(revokeJobs()).toHaveLength(1);
    const audits = await env.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'account.deleted')));
    expect(
      audits
        .map((a) => a.details)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      {
        provider: 'atlassian',
        revoked: false,
        sharedTokenKept: true,
        writeRevocationQueued: false,
      },
      { provider: 'atlassian', revoked: true, sharedTokenKept: false, writeRevocationQueued: true },
    ]);
  });

  it('write access needs write actions and a matching identity; no mailbox login hint', async () => {
    const { token, auth, userId } = await env.signIn('sites-write@example.com');
    const res = await connectSites(token, 'fake-sites:lee:acme,beta');
    const [acme] = res.json().accounts as { id: string }[];
    const start = await env.app.inject({
      method: 'POST',
      url: `/accounts/${acme!.id}/write-access`,
      headers: auth,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(new URL(start.json().url).searchParams.get('login_hint')).toBeNull();

    const writeFlow = async (code: string) => {
      const state = await env.startConnect(token, `/accounts/${acme!.id}/write-access`);
      const cb = await env.callback(state, code, 'atlassian');
      return env.complete(token, cb.pending!);
    };
    const wrong = await writeFlow('fake-sites:lee:other');
    expect(wrong.json().error).toBe('account_mismatch');
    // A consent covering several sites grants write to the requested account only.
    const ok = await writeFlow('fake-sites:lee:beta,acme');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ access: 'write', accounts: [{ id: acme!.id }] });
    const rows = await rowsOf(userId);
    expect(rows.find((r) => r.id === acme!.id)!.writeTokenRef).toBeTruthy();
    expect(rows.find((r) => r.id !== acme!.id)!.writeTokenRef).toBeNull();

    // A read-only connector refuses the write flow up front.
    const gh = env.deps.getConnector('github')!;
    const ex = await gh.connect.exchange({ code: 'x:lee:repo', redirectUri: '' });
    const tokenRef = await env.secrets.put(userId, 'oauth:github', JSON.stringify(ex.tokens));
    const [ghAccount] = await env.t.db
      .insert(accounts)
      .values({
        userId,
        provider: 'github',
        nickname: 'GH',
        color: '#1F6F6B',
        externalId: 'cloud-repo',
        tokenRef,
      })
      .returning();
    const refused = await env.app.inject({
      method: 'POST',
      url: `/accounts/${ghAccount!.id}/write-access`,
      headers: auth,
      payload: {},
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('write_not_supported');
  });

  it('source toggles flip the subscription rows and enqueue a sync; ungranted sources stay off', async () => {
    const { token, auth } = await env.signIn('toggles@example.com');
    const res = await connectSites(token, 'fake-sites:ana:acme');
    const accountId = res.json().account.id as string;
    await env.t.db.insert(subscriptions).values([
      { accountId, kind: 'jira', cursor: 'j1' },
      { accountId, kind: 'confluence', cursor: 'c1', externalSubId: 'hook-1' },
    ]);
    const patch = (payload: object) =>
      env.app.inject({ method: 'PATCH', url: `/accounts/${accountId}`, headers: auth, payload });
    const enabled = async () =>
      Object.fromEntries(
        (
          await env.t.db.select().from(subscriptions).where(eq(subscriptions.accountId, accountId))
        ).map((r) => [r.kind, r.enabled]),
      );
    const syncs = () =>
      env.jobs.filter(
        (j) => j.name === 'sync' && (j.data as { accountId: string }).accountId === accountId,
      );

    const off = await patch({ filters: { sources: { confluence: false } } });
    expect(off.statusCode).toBe(200);
    expect(off.json().filters.sources).toEqual({ confluence: false });
    expect(await enabled()).toEqual({ jira: true, confluence: false });
    expect(syncs().map((j) => j.data)).toEqual([{ accountId, reason: 'manual' }]);

    // Other keys merge; re-sending the same toggle changes nothing and enqueues nothing.
    const same = await patch({
      filters: { sources: { confluence: false }, options: { projects: 'mine' } },
    });
    expect(same.json().filters).toMatchObject({
      sources: { confluence: false },
      options: { projects: 'mine' },
    });
    expect(syncs()).toHaveLength(1);

    env.setNow(new Date(env.now().getTime() + 1000));
    await patch({ filters: { sources: { confluence: true } } });
    expect(await enabled()).toEqual({ jira: true, confluence: true });
    expect(syncs()).toHaveLength(2);

    // Jira-only consent: confluence isn't granted, so turning it on doesn't enable it.
    const narrow = await connectSites(token, 'fake-sites:ana:solo:read:jira-work');
    const soloId = narrow.json().account.id as string;
    await env.t.db
      .insert(subscriptions)
      .values({ accountId: soloId, kind: 'confluence', enabled: false });
    await env.app.inject({
      method: 'PATCH',
      url: `/accounts/${soloId}`,
      headers: auth,
      payload: { filters: { sources: { confluence: true } } },
    });
    const [row] = await env.t.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, soloId));
    expect(row!.enabled).toBe(false);
  });
});

describe('GET /connectors', () => {
  it('lists every provider: implemented from the connector, others as unavailable', async () => {
    const { auth } = await env.signIn('catalog@example.com');
    const res = await env.app.inject({ url: '/connectors', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = ConnectorCatalogRes.parse(res.json());
    expect(body.connectors.map((c) => c.provider)).toEqual([
      'gmail',
      'microsoft',
      'slack',
      'atlassian',
      'notion',
      'github',
    ]);
    const by = Object.fromEntries(body.connectors.map((c) => [c.provider, c]));
    expect(by.gmail).toMatchObject({
      name: 'Google',
      available: true,
      writeActions: ['gmail.send'],
    });
    expect(by.atlassian).toMatchObject({
      name: 'Atlassian',
      multiAccountNote: 'One per site',
      available: true,
      writeActions: ['jira.comment'],
    });
    expect(by.atlassian!.sources.map((s) => s.id)).toEqual(['jira', 'confluence']);
    // Server-side details (required scopes) are not exposed.
    expect(JSON.stringify(res.json())).not.toContain('read:jira-work');
    expect(by.notion).toMatchObject({ available: false });
    expect(by.notion!.sources).toHaveLength(2);
    for (const p of ['microsoft', 'slack'] as const) {
      expect(by[p]).toMatchObject({ available: false, sources: [], options: [], writeActions: [] });
      expect(by[p]!.name.length).toBeGreaterThan(0);
      expect(by[p]!.covers.length).toBeGreaterThan(0);
    }
    expect(by.slack!.multiAccountNote).toBe('One per workspace');
  });

  it('requires a session', async () => {
    expect((await env.app.inject({ url: '/connectors' })).statusCode).toBe(401);
  });
});
