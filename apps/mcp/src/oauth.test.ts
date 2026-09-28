import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  accessRequests,
  auditLog,
  grants,
  mcpAuthCodes,
  mcpClients,
  mcpOauthClients,
  users,
} from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import { hashToken, randomToken } from '@hub/server';
import { pkceS256 } from './oauth/tokens';
import { connectClient, startHarness, type Harness } from './test-support';

let t: Awaited<ReturnType<typeof createTestDb>>;
let h: Harness;
let userId: string;
const REDIRECT = 'http://127.0.0.1:33418/callback';

beforeAll(async () => {
  t = await createTestDb();
  // Many tests below walk the consent form; keep the per-IP/email limits out of the way.
  h = await startHarness(t.db, { rateLimits: { consentPerIp: 1000, consentPerEmail: 1000 } });
  const [u] = await t.db.insert(users).values({ email: 'Me@Example.com' }).returning();
  userId = u!.id;
});

afterAll(async () => {
  await h.close();
  await t.drop();
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
  hh: Harness = h,
) =>
  fetch(`${hh.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: form(body),
    redirect: 'manual',
  });

async function register(extra: Record<string, unknown> = {}, hh: Harness = h) {
  const res = await fetch(`${hh.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude Code',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      ...extra,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function authParams(clientId: string, verifier: string, state = 'st-123', hh: Harness = h) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    state,
    scope: 'hub',
    resource: hh.mcpUrl,
  };
}

/** Submits the email form; returns the poll token and the pairing code from the waiting page. */
async function submitForm(clientId: string, verifier: string, email: string, hh: Harness = h) {
  const res = await post(
    '/authorize',
    { ...authParams(clientId, verifier, 'st-123', hh), hub_email: email },
    {},
    hh,
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('Check your phone');
  expect(html).toContain('Enter this code on your phone');
  const m = /<script type="application\/json" id="cfg">(.*?)<\/script>/.exec(html);
  const code = /id="pairing-code">(\d{3}) (\d{3})</.exec(html);
  expect(code).not.toBeNull();
  return { poll: (JSON.parse(m![1]!) as { t: string }).t, pairingCode: code![1]! + code![2]! };
}

async function submitEmail(clientId: string, verifier: string, email: string) {
  return (await submitForm(clientId, verifier, email)).poll;
}

async function pollStatus(token: string, hh: Harness = h) {
  const res = await fetch(`${hh.base}/authorize/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: token }),
  });
  return (await res.json()) as { status: string; redirect?: string };
}

/** The connect request behind a waiting page (found by its poll token's hash). */
async function connectRequestFor(poll: string) {
  const [row] = await t.db
    .select()
    .from(accessRequests)
    .where(
      and(
        eq(accessRequests.userId, userId),
        eq(accessRequests.kind, 'mcp_connect'),
        sql`${accessRequests.meta}->>'pollTokenHash' = ${hashToken(poll)}`,
      ),
    );
  return row!;
}

/**
 * What apps/api does on POST /access-requests/:id/allow for mcp_connect: compare the typed
 * code with the stored salted hash, then mark the row allowed and verified.
 */
async function phoneAllows(requestId: string, typedCode: string, at = new Date()) {
  const [row] = await t.db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
  const stored = (row!.meta as { pairingCodeHash?: string }).pairingCodeHash;
  expect(stored).toBe(hashToken(`${requestId}:${typedCode}`));
  await t.db
    .update(accessRequests)
    .set({
      status: 'allowed',
      decidedAt: at,
      meta: { ...(row!.meta as object), pairingVerifiedAt: at.toISOString() },
    })
    .where(eq(accessRequests.id, requestId));
}

/** Full browser + phone flow up to an authorization code. */
async function getCode(clientId: string, verifier: string, hh: Harness = h) {
  const { poll, pairingCode } = await submitForm(clientId, verifier, 'me@example.com', hh);
  const reqRow = await connectRequestFor(poll);
  await phoneAllows(reqRow.id, pairingCode);
  const s = await pollStatus(poll, hh);
  expect(s.status).toBe('allowed');
  const url = new URL(s.redirect!);
  return { code: url.searchParams.get('code')!, state: url.searchParams.get('state'), url, poll };
}

const exchange = (clientId: string, code: string, verifier: string, hh: Harness = h) =>
  post(
    '/token',
    {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: hh.mcpUrl,
    },
    {},
    hh,
  );

const refreshWith = (clientId: string, refreshToken: string, hh: Harness = h) =>
  post(
    '/token',
    { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
    {},
    hh,
  );

/** A temporary grant for an MCP client, as the phone's Allow would create. */
async function insertGrant(mcpClientId: string) {
  const [g] = await t.db
    .insert(grants)
    .values({
      userId,
      principal: `mcp:${mcpClientId}`,
      scope: 'email',
      level: 'read',
      expiresAt: new Date(Date.now() + 3600_000),
    })
    .returning({ id: grants.id });
  return g!.id;
}

const bearer = (token: string, hh: Harness = h) =>
  fetch(hh.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });

describe('discovery', () => {
  it('rejects /mcp without a bearer and points at the resource metadata', async () => {
    const res = await fetch(h.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate')!;
    expect(www).toContain('Bearer');
    expect(www).toContain(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('rejects an invalid bearer', async () => {
    const res = await fetch(h.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('serves protected resource and authorization server metadata', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const prm = (await (await fetch(`${h.base}${path}`)).json()) as Record<string, unknown>;
      expect(prm.resource).toBe(h.mcpUrl);
      expect(prm.authorization_servers).toEqual([`${h.base}/`]);
    }
    const as = (await (
      await fetch(`${h.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: `${h.base}/`,
      authorization_endpoint: `${h.base}/authorize`,
      token_endpoint: `${h.base}/token`,
      registration_endpoint: `${h.base}/register`,
      revocation_endpoint: `${h.base}/revoke`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('registration', () => {
  it('stores a public client', async () => {
    const r = await register();
    expect(r.status).toBe(201);
    const [row] = await t.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, r.body.client_id as string));
    expect(row).toMatchObject({ name: 'Claude Code', clientSecretHash: null });
    expect(row!.redirectUris).toEqual([REDIRECT]);
  });

  it('stores only a hash of a confidential client secret', async () => {
    const r = await register({ token_endpoint_auth_method: 'client_secret_post' });
    const secret = r.body.client_secret as string;
    expect(secret).toBeTruthy();
    const [row] = await t.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, r.body.client_id as string));
    expect(row!.clientSecretHash).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('refuses unsafe redirect URIs', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect((await register({ redirect_uris: [uri] })).status).toBe(400);
    }
  });
});

describe('authorization code flow with phone approval', () => {
  it('requires PKCE S256', async () => {
    const { body } = await register();
    const p = authParams(body.client_id as string, randomToken(32));
    const res = await fetch(
      `${h.base}/authorize?${form({ ...p, code_challenge_method: 'plain' })}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=invalid_request');
  });

  it('shows the consent page with the client name escaped', async () => {
    const { body } = await register({ client_name: '<b>Claude</b> Code' });
    const res = await fetch(
      `${h.base}/authorize?${form(authParams(body.client_id as string, randomToken(32)))}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('&lt;b&gt;Claude&lt;/b&gt; Code');
    expect(html).not.toContain('<b>Claude</b>');
    expect(html).toContain('name="hub_email"');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('runs register → authorize → phone approval → code → token → MCP, with refresh rotation', async () => {
    const { body } = await register();
    const clientId = body.client_id as string;
    const verifier = randomToken(32);

    const { poll, pairingCode } = await submitForm(clientId, verifier, 'me@example.com');
    const reqRow = await connectRequestFor(poll);
    expect(reqRow).toMatchObject({
      kind: 'mcp_connect',
      principal: 'mcp:pending',
      clientName: 'Claude Code',
      resource: '*',
      status: 'pending',
    });
    expect(reqRow.meta).toMatchObject({ oauthClientId: clientId, redirectUri: REDIRECT });
    expect(JSON.stringify(reqRow.meta)).not.toContain(poll);
    // Only the salted hash of the pairing code is stored.
    expect(JSON.stringify(reqRow.meta)).not.toContain(pairingCode);
    expect(reqRow.meta).toMatchObject({
      pairingCodeHash: hashToken(`${reqRow.id}:${pairingCode}`),
    });
    expect(h.jobs.at(-1)).toMatchObject({
      name: 'notifier',
      data: { userId, kind: 'access_request', dedupeKey: `access_request:${reqRow.id}` },
    });
    expect(h.live.at(-1)).toEqual({
      userId,
      event: { type: 'access_request.created', requestId: reqRow.id },
    });

    expect((await pollStatus(poll)).status).toBe('pending');
    // The phone approves with the code (apps/api checks it and marks the row allowed).
    await phoneAllows(reqRow.id, pairingCode);
    const s = await pollStatus(poll);
    expect(s.status).toBe('allowed');
    const redirect = new URL(s.redirect!);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('st-123');
    const code = redirect.searchParams.get('code')!;
    // A second poll never yields a second code.
    expect((await pollStatus(poll)).status).toBe('used');

    // Only the hash is stored, with a 10-minute expiry.
    const codes = await t.db.select().from(mcpAuthCodes).where(eq(mcpAuthCodes.clientId, clientId));
    expect(codes).toHaveLength(1);
    expect(codes[0]!.codeHash).not.toContain(code);
    const ttl = +codes[0]!.expiresAt - +codes[0]!.createdAt;
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1000);

    // Wrong verifier fails and does not burn the code.
    const bad = await exchange(clientId, code, randomToken(32));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant');

    const ok = await exchange(clientId, code, verifier);
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as Record<string, string | number>;
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'hub' });
    const access = tokens.access_token as string;
    const refresh = tokens.refresh_token as string;

    const [row] = await t.db
      .select()
      .from(mcpClients)
      .where(eq(mcpClients.oauthClientId, clientId));
    expect(row).toMatchObject({ userId, name: 'Claude Code', revokedAt: null });
    expect(JSON.stringify(row)).not.toContain(access);
    expect(JSON.stringify(row)).not.toContain(refresh);

    // The token works against /mcp and updates last_used_at.
    const client = await connectClient(h.mcpUrl, access);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      'get_my_tasks',
      'get_project_status',
      'get_thread',
      'propose_action',
      'request_access',
      'search_context',
    ]);
    await client.close();
    const [used] = await t.db.select().from(mcpClients).where(eq(mcpClients.id, row!.id));
    expect(used!.lastUsedAt).not.toBeNull();

    // Code reuse fails, and revokes what the code produced.
    const reuse = await exchange(clientId, code, verifier);
    expect(reuse.status).toBe(400);
    const [afterReuse] = await t.db.select().from(mcpClients).where(eq(mcpClients.id, row!.id));
    expect(afterReuse!.revokedAt).not.toBeNull();
    const reuseAudit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'mcp.token.code_reuse'));
    expect(reuseAudit).toHaveLength(1);
  });

  it('rotates refresh tokens', async () => {
    const { body } = await register();
    const clientId = body.client_id as string;
    const verifier = randomToken(32);
    const { code } = await getCode(clientId, verifier);
    const first = (await (await exchange(clientId, code, verifier)).json()) as Record<
      string,
      string
    >;

    const refreshed = await refreshWith(clientId, first.refresh_token!);
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as Record<string, string>;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    // The old access token is dead.
    expect((await bearer(first.access_token!)).status).toBe(401);

    // A refresh token belongs to its client only (and doesn't count as reuse).
    const other = (await register()).body.client_id as string;
    expect((await refreshWith(other, second.refresh_token!)).status).toBe(400);

    // Rotation state lives server-side in the registration row, hashes only, and never
    // shows up in the client information.
    const [reg] = await t.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, clientId));
    expect(JSON.stringify(reg!.metadata)).toContain(hashToken(first.refresh_token!));
    expect(JSON.stringify(reg!.metadata)).not.toContain(first.refresh_token!);
    expect(JSON.stringify(reg!.metadata)).not.toContain(second.refresh_token!);

    // The new access token works until the phone revokes the client.
    const client = await connectClient(h.mcpUrl, second.access_token!);
    await client.listTools();
    await client.close();
    await t.db
      .update(mcpClients)
      .set({ revokedAt: new Date() })
      .where(eq(mcpClients.oauthClientId, clientId));
    expect((await bearer(second.access_token!)).status).toBe(401);
    expect((await refreshWith(clientId, second.refresh_token!)).status).toBe(400);
  });

  it('revokes the connection when a rotated-out refresh token comes back', async () => {
    const { body } = await register();
    const clientId = body.client_id as string;
    const verifier = randomToken(32);
    const { code } = await getCode(clientId, verifier);
    const first = (await (await exchange(clientId, code, verifier)).json()) as Record<
      string,
      string
    >;
    const second = (await (await refreshWith(clientId, first.refresh_token!)).json()) as Record<
      string,
      string
    >;
    const third = (await (await refreshWith(clientId, second.refresh_token!)).json()) as Record<
      string,
      string
    >;
    const live = await connectClient(h.mcpUrl, third.access_token!);
    await live.listTools();
    await live.close();
    const [row] = await t.db
      .select()
      .from(mcpClients)
      .where(eq(mcpClients.oauthClientId, clientId));
    const grant = await insertGrant(row!.id);

    // A thief (or a confused client) replays the very first refresh token.
    const replay = await refreshWith(clientId, first.refresh_token!);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');

    // Everything from that connection is dead now, including the latest tokens and grants.
    const [after] = await t.db.select().from(mcpClients).where(eq(mcpClients.id, row!.id));
    expect(after!.revokedAt).not.toBeNull();
    expect((await bearer(third.access_token!)).status).toBe(401);
    expect((await refreshWith(clientId, third.refresh_token!)).status).toBe(400);
    const [g] = await t.db.select().from(grants).where(eq(grants.id, grant));
    expect(g!.revokedAt).not.toBeNull();
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'mcp.token.refresh_reuse'), eq(auditLog.target, row!.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ oauthClientId: clientId, how: 'rotated_token' });
  });

  it('revokes on concurrent use of the same refresh token', async () => {
    const { body } = await register();
    const clientId = body.client_id as string;
    const verifier = randomToken(32);
    const { code } = await getCode(clientId, verifier);
    const tok = (await (await exchange(clientId, code, verifier)).json()) as Record<string, string>;
    const results = await Promise.all([
      refreshWith(clientId, tok.refresh_token!),
      refreshWith(clientId, tok.refresh_token!),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    const [row] = await t.db
      .select()
      .from(mcpClients)
      .where(eq(mcpClients.oauthClientId, clientId));
    expect(row!.revokedAt).not.toBeNull();
  });

  it('ends a refresh chain after 90 days, or after 30 idle days', async () => {
    let now = Date.now();
    const h4 = await startHarness(t.db, { now: () => new Date(now) });
    try {
      const day = 24 * 3600 * 1000;
      const connect = async () => {
        const clientId = (await register({}, h4)).body.client_id as string;
        const verifier = randomToken(32);
        const { code } = await getCode(clientId, verifier, h4);
        const tok = (await (await exchange(clientId, code, verifier, h4)).json()) as Record<
          string,
          string
        >;
        return { clientId, refresh: tok.refresh_token! };
      };
      const refresh = async (c: { clientId: string; refresh: string }) => {
        const res = await refreshWith(c.clientId, c.refresh, h4);
        if (res.status === 200) {
          c.refresh = ((await res.json()) as { refresh_token: string }).refresh_token;
        }
        return res.status;
      };

      // Absolute: refreshing every 25 days keeps it alive until day 90, never past it.
      const a = await connect();
      for (let i = 0; i < 3; i++) {
        now += 25 * day;
        expect(await refresh(a)).toBe(200);
      }
      now += 14 * day; // day 89
      expect(await refresh(a)).toBe(200);
      now += 1 * day; // day 90
      expect(await refresh(a)).toBe(400);

      // Idle: 30 days without any use ends it, well before the absolute limit.
      const c = await connect();
      now += 29 * day;
      expect(await refresh(c)).toBe(200);
      now += 30 * day;
      expect(await refresh(c)).toBe(400);

      // Reconnecting (a new phone approval) starts a new chain.
      const d = await connect();
      expect(await refresh(d)).toBe(200);
    } finally {
      await h4.close();
    }
  });

  it('supports RFC 7009 revocation', async () => {
    const { body } = await register();
    const clientId = body.client_id as string;
    const verifier = randomToken(32);
    const { code } = await getCode(clientId, verifier);
    const tok = (await (await exchange(clientId, code, verifier)).json()) as Record<string, string>;
    const [row] = await t.db
      .select()
      .from(mcpClients)
      .where(eq(mcpClients.oauthClientId, clientId));
    const grant = await insertGrant(row!.id);
    const res = await post('/revoke', { client_id: clientId, token: tok.access_token! });
    expect(res.status).toBe(200);
    expect((await bearer(tok.access_token!)).status).toBe(401);
    // Like revoking on the phone, the client's temporary grants end too.
    const [g] = await t.db.select().from(grants).where(eq(grants.id, grant));
    expect(g!.revokedAt).not.toBeNull();
    expect((await refreshWith(clientId, tok.refresh_token!)).status).toBe(400);
  });

  it('authenticates confidential clients by secret hash', async () => {
    const { body } = await register({ token_endpoint_auth_method: 'client_secret_post' });
    const clientId = body.client_id as string;
    const secret = body.client_secret as string;
    const verifier = randomToken(32);
    const { code } = await getCode(clientId, verifier);
    const noSecret = await exchange(clientId, code, verifier);
    expect(noSecret.status).toBe(401);
    const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
    const ok = await post(
      '/token',
      { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT },
      { Authorization: `Basic ${basic}` },
    );
    expect(ok.status).toBe(200);
  });

  it('shows denial from the phone', async () => {
    const { body } = await register();
    const poll = await submitEmail(body.client_id as string, randomToken(32), 'me@example.com');
    const reqRow = await connectRequestFor(poll);
    await t.db
      .update(accessRequests)
      .set({ status: 'denied' })
      .where(eq(accessRequests.id, reqRow.id));
    expect(await pollStatus(poll)).toEqual({ status: 'denied' });
  });

  it('does not reveal whether an email has an account', async () => {
    const { body } = await register();
    const before = (await t.db.select().from(accessRequests)).length;
    const jobs = h.jobs.length;
    const poll = await submitEmail(body.client_id as string, randomToken(32), 'nobody@example.com');
    expect((await t.db.select().from(accessRequests)).length).toBe(before);
    expect(h.jobs.length).toBe(jobs);
    expect(await pollStatus(poll)).toEqual({ status: 'pending' });
    expect(await pollStatus(randomToken(32))).toEqual({ status: 'expired' });
  });

  it('expires requests the phone never answers', async () => {
    let now = Date.now();
    const h2 = await startHarness(t.db, { now: () => new Date(now) });
    try {
      const reg = await fetch(`${h2.base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
      });
      const clientId = ((await reg.json()) as { client_id: string }).client_id;
      const res = await fetch(`${h2.base}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({
          ...authParams(clientId, randomToken(32)),
          resource: h2.mcpUrl,
          hub_email: 'me@example.com',
        }),
      });
      const html = await res.text();
      const tok = (JSON.parse(/id="cfg">(.*?)<\/script>/.exec(html)![1]!) as { t: string }).t;
      now += 11 * 60_000;
      const s = await fetch(`${h2.base}/authorize/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: tok }),
      });
      expect(await s.json()).toEqual({ status: 'expired' });
    } finally {
      await h2.close();
    }
  });

  it('rate-limits the email form', async () => {
    const h3 = await startHarness(t.db, { rateLimits: { consentPerIp: 2 } });
    try {
      const reg = await fetch(`${h3.base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
      });
      const clientId = ((await reg.json()) as { client_id: string }).client_id;
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${h3.base}/authorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({
            ...authParams(clientId, randomToken(32)),
            resource: h3.mcpUrl,
            hub_email: `x${i}@example.com`,
          }),
        });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await h3.close();
    }
  });
});

describe('pairing code (phishing resistance)', () => {
  const codesFor = (clientId: string) =>
    t.db.select().from(mcpAuthCodes).where(eq(mcpAuthCodes.clientId, clientId));

  it('gives the waiting page nothing until the phone enters the right code', async () => {
    // An attacker registers a client with a trusted-looking name and submits the victim's email.
    const { body } = await register({ client_name: 'Claude Code' });
    const clientId = body.client_id as string;
    const { poll, pairingCode } = await submitForm(clientId, randomToken(32), 'me@example.com');
    const reqRow = await connectRequestFor(poll);
    expect(h.jobs.at(-1)!.data).toMatchObject({
      body: expect.stringContaining('code shown on your computer'),
    });

    for (let i = 0; i < 3; i++) expect(await pollStatus(poll)).toEqual({ status: 'pending' });
    // A wrong code on the phone (apps/api counts it) leaves the request pending.
    await t.db
      .update(accessRequests)
      .set({ meta: { ...(reqRow.meta as object), pairingAttempts: 1 } })
      .where(eq(accessRequests.id, reqRow.id));
    expect(await pollStatus(poll)).toEqual({ status: 'pending' });
    expect(await codesFor(clientId)).toHaveLength(0);

    await phoneAllows(reqRow.id, pairingCode);
    const s = await pollStatus(poll);
    expect(s.status).toBe('allowed');
    expect(new URL(s.redirect!).searchParams.get('code')).toMatch(/^hub_ac_/);
    expect(await codesFor(clientId)).toHaveLength(1);
  });

  it('issues no code for an allow that did not verify the pairing code', async () => {
    const { body } = await register();
    const clientId = body.client_id as string;
    const poll = await submitEmail(clientId, randomToken(32), 'me@example.com');
    const reqRow = await connectRequestFor(poll);
    // e.g. an old API build that allows without checking the code.
    await t.db
      .update(accessRequests)
      .set({ status: 'allowed' })
      .where(eq(accessRequests.id, reqRow.id));
    const s = await pollStatus(poll);
    expect(s.status).not.toBe('allowed');
    expect(s.redirect).toBeUndefined();
    expect(await codesFor(clientId)).toHaveLength(0);
  });

  it('shows a code for unknown emails too, so the page reveals nothing', async () => {
    const { body } = await register();
    const { poll, pairingCode } = await submitForm(
      body.client_id as string,
      randomToken(32),
      'stranger@example.com',
    );
    expect(pairingCode).toMatch(/^\d{6}$/);
    expect(await pollStatus(poll)).toEqual({ status: 'pending' });
  });

  it('refuses to issue a code after the TTL, even if the request was allowed', async () => {
    let now = Date.now();
    const h5 = await startHarness(t.db, { now: () => new Date(now) });
    try {
      const clientId = (await register({}, h5)).body.client_id as string;
      const { poll, pairingCode } = await submitForm(
        clientId,
        randomToken(32),
        'me@example.com',
        h5,
      );
      const reqRow = await connectRequestFor(poll);
      now += 9 * 60_000;
      await phoneAllows(reqRow.id, pairingCode, new Date(now));
      now += 60_000; // exactly 10 minutes after the request was created
      expect(await pollStatus(poll, h5)).toEqual({ status: 'expired' });
      now += 60_000;
      expect(await pollStatus(poll, h5)).toEqual({ status: 'expired' });
      expect(await codesFor(clientId)).toHaveLength(0);
      const [row] = await t.db
        .select()
        .from(accessRequests)
        .where(eq(accessRequests.id, reqRow.id));
      expect(row!.meta).not.toHaveProperty('codeIssuedAt');
    } finally {
      await h5.close();
    }
  });
});
