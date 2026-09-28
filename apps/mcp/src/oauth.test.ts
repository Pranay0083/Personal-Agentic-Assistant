import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  accessRequests,
  auditLog,
  mcpAuthCodes,
  mcpClients,
  mcpOauthClients,
  users,
} from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import { randomToken } from '@hub/server';
import { pkceS256 } from './oauth/tokens';
import { connectClient, startHarness, type Harness } from './test-support';

let t: Awaited<ReturnType<typeof createTestDb>>;
let h: Harness;
let userId: string;
const REDIRECT = 'http://127.0.0.1:33418/callback';

beforeAll(async () => {
  t = await createTestDb();
  h = await startHarness(t.db);
  const [u] = await t.db.insert(users).values({ email: 'Me@Example.com' }).returning();
  userId = u!.id;
});

afterAll(async () => {
  await h.close();
  await t.drop();
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: form(body),
    redirect: 'manual',
  });

async function register(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${h.base}/register`, {
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

function authParams(clientId: string, verifier: string, state = 'st-123') {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    state,
    scope: 'hub',
    resource: h.mcpUrl,
  };
}

/** Submits the email form and returns the poll token embedded in the waiting page. */
async function submitEmail(clientId: string, verifier: string, email: string) {
  const res = await post('/authorize', { ...authParams(clientId, verifier), hub_email: email });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('Check your phone');
  const m = /<script type="application\/json" id="cfg">(.*?)<\/script>/.exec(html);
  return (JSON.parse(m![1]!) as { t: string }).t;
}

async function pollStatus(token: string) {
  const res = await fetch(`${h.base}/authorize/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: token }),
  });
  return (await res.json()) as { status: string; redirect?: string };
}

async function latestConnectRequest() {
  const rows = await t.db
    .select()
    .from(accessRequests)
    .where(and(eq(accessRequests.userId, userId), eq(accessRequests.kind, 'mcp_connect')));
  return rows.sort((a, b) => +b.createdAt - +a.createdAt)[0]!;
}

/** Full browser + phone flow up to an authorization code. */
async function getCode(clientId: string, verifier: string) {
  const poll = await submitEmail(clientId, verifier, 'me@example.com');
  const reqRow = await latestConnectRequest();
  await t.db
    .update(accessRequests)
    .set({ status: 'allowed' })
    .where(eq(accessRequests.id, reqRow.id));
  const s = await pollStatus(poll);
  expect(s.status).toBe('allowed');
  const url = new URL(s.redirect!);
  return { code: url.searchParams.get('code')!, state: url.searchParams.get('state'), url, poll };
}

const exchange = (clientId: string, code: string, verifier: string) =>
  post('/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    resource: h.mcpUrl,
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

    const poll = await submitEmail(clientId, verifier, 'me@example.com');
    const reqRow = await latestConnectRequest();
    expect(reqRow).toMatchObject({
      kind: 'mcp_connect',
      principal: 'mcp:pending',
      clientName: 'Claude Code',
      resource: '*',
      status: 'pending',
    });
    expect(reqRow.meta).toMatchObject({ oauthClientId: clientId, redirectUri: REDIRECT });
    expect(JSON.stringify(reqRow.meta)).not.toContain(poll);
    expect(h.jobs.at(-1)).toMatchObject({
      name: 'notifier',
      data: { userId, kind: 'access_request', dedupeKey: `access_request:${reqRow.id}` },
    });
    expect(h.live.at(-1)).toEqual({
      userId,
      event: { type: 'access_request.created', requestId: reqRow.id },
    });

    expect((await pollStatus(poll)).status).toBe('pending');
    // The phone approves (apps/api sets status allowed).
    await t.db
      .update(accessRequests)
      .set({ status: 'allowed' })
      .where(eq(accessRequests.id, reqRow.id));
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

    const refreshed = await post('/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: first.refresh_token!,
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as Record<string, string>;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);

    // The old refresh token and old access token are dead.
    const again = await post('/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: first.refresh_token!,
    });
    expect(again.status).toBe(400);
    const oldAccess = await fetch(h.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${first.access_token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(oldAccess.status).toBe(401);

    // A refresh token belongs to its client only.
    const other = (await register()).body.client_id as string;
    const stolen = await post('/token', {
      grant_type: 'refresh_token',
      client_id: other,
      refresh_token: second.refresh_token!,
    });
    expect(stolen.status).toBe(400);

    // The new access token works until the phone revokes the client.
    const client = await connectClient(h.mcpUrl, second.access_token!);
    await client.listTools();
    await client.close();
    await t.db
      .update(mcpClients)
      .set({ revokedAt: new Date() })
      .where(eq(mcpClients.oauthClientId, clientId));
    const revoked = await fetch(h.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${second.access_token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(revoked.status).toBe(401);
    const refreshRevoked = await post('/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: second.refresh_token!,
    });
    expect(refreshRevoked.status).toBe(400);
  });

  it('supports RFC 7009 revocation', async () => {
    const { body } = await register();
    const clientId = body.client_id as string;
    const verifier = randomToken(32);
    const { code } = await getCode(clientId, verifier);
    const tok = (await (await exchange(clientId, code, verifier)).json()) as Record<string, string>;
    const res = await post('/revoke', { client_id: clientId, token: tok.access_token! });
    expect(res.status).toBe(200);
    const after = await fetch(h.mcpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(after.status).toBe(401);
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
    const reqRow = await latestConnectRequest();
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
