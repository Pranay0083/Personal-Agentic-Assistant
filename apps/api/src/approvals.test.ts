import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessRequests,
  auditLog,
  events,
  grants,
  items,
  mcpClients,
  proposals,
  users,
} from '@hub/db';
import { can, decide, loadContext } from '@hub/policy';
import { hashToken } from '@hub/server';
import { setup, type TestEnv } from './test-helpers';

let env: TestEnv;
let token: string;
let userId: string;
let auth: Record<string, string>;
let work: string;
let personal: string;
let n = 0;

async function proposal(
  action = 'gmail.send',
  payload: object = { to: ['a@example.com'], subject: 'Re: hi', body: 'Draft' },
) {
  const [p] = await env.t.db
    .insert(proposals)
    .values({
      userId,
      accountId: work,
      agent: 'agent:reply',
      model: 'claude-sonnet-5',
      action,
      title: 'Reply to Ana',
      payload,
      idempotencyKey: `idem-${n++}`,
    })
    .returning();
  return p!.id;
}

const executorJobs = () => env.jobs.filter((j) => j.name === 'executor');

beforeAll(async () => {
  env = await setup();
  ({ token, userId, auth } = await env.signIn('appr@example.com'));
  work = (await env.connectGmail(token, 'appr@company.com')).accountId;
  personal = (await env.connectGmail(token, 'appr@gmail.com')).accountId;
});
afterAll(() => env.close());

describe('proposals', () => {
  it('approve enqueues the executor exactly once and rejects a second approve', async () => {
    const id = await proposal();
    const list = (await env.app.inject({ url: '/proposals?status=pending', headers: auth })).json()
      .proposals;
    expect(list.map((p: { id: string }) => p.id)).toContain(id);

    const first = await env.app.inject({
      method: 'POST',
      url: `/proposals/${id}/approve`,
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id, status: 'approved' });
    expect(first.json().decidedAt).toBe(env.now().toISOString());

    const second = await env.app.inject({
      method: 'POST',
      url: `/proposals/${id}/approve`,
      headers: auth,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('not_pending');

    // Concurrent approves: only one wins.
    const id2 = await proposal();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        env.app.inject({ method: 'POST', url: `/proposals/${id2}/approve`, headers: auth }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);

    expect(executorJobs()).toEqual([
      { name: 'executor', data: { proposalId: id }, opts: { jobId: `exec-${id}` } },
      { name: 'executor', data: { proposalId: id2 }, opts: { jobId: `exec-${id2}` } },
    ]);
    const audits = await env.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'proposal.approved')));
    expect(audits).toHaveLength(2);
  });

  it('an edited payload is validated and replaces the draft', async () => {
    const id = await proposal();
    const bad = await env.app.inject({
      method: 'POST',
      url: `/proposals/${id}/approve`,
      headers: auth,
      payload: { payload: { to: ['not-an-email'], subject: 's', body: 'b' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_request');
    const [still] = await env.t.db.select().from(proposals).where(eq(proposals.id, id));
    expect(still!.status).toBe('pending');

    const edited = { to: ['ana@example.com'], subject: 'Re: hi', body: 'Edited text' };
    const ok = await env.app.inject({
      method: 'POST',
      url: `/proposals/${id}/approve`,
      headers: auth,
      payload: { payload: edited },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().payload).toEqual({ ...edited, cc: [] });

    const labelId = await proposal('gmail.label', { labels: ['x'] });
    const noEdit = await env.app.inject({
      method: 'POST',
      url: `/proposals/${labelId}/approve`,
      headers: auth,
      payload: { payload: { labels: ['y'] } },
    });
    expect(noEdit.statusCode).toBe(400);
  });

  it('reject changes the status, audits, and enqueues nothing', async () => {
    const id = await proposal();
    const before = env.jobs.length;
    const res = await env.app.inject({
      method: 'POST',
      url: `/proposals/${id}/reject`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
    expect(env.jobs.length).toBe(before);
    expect(
      (await env.app.inject({ method: 'POST', url: `/proposals/${id}/approve`, headers: auth }))
        .statusCode,
    ).toBe(409);
    expect(env.jobs.length).toBe(before);
    const audits = await env.t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'proposal.rejected'));
    expect(audits).toHaveLength(1);
  });
});

/** An mcp_connect row as apps/mcp writes it: only the salted hash of the pairing code. */
async function connectRequest(code: string, createdAt = env.now()) {
  const id = randomUUID();
  const [row] = await env.t.db
    .insert(accessRequests)
    .values({
      id,
      userId,
      kind: 'mcp_connect',
      principal: 'mcp:pending',
      clientName: 'Claude Code',
      resource: '*',
      meta: { redirectHost: '127.0.0.1:33418', pairingCodeHash: hashToken(`${id}:${code}`) },
      createdAt,
    })
    .returning();
  return row!;
}

const allowConnect = (id: string, payload: object = {}) =>
  env.app.inject({ method: 'POST', url: `/access-requests/${id}/allow`, headers: auth, payload });

const requestRow = async (id: string) =>
  (await env.t.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]!;

describe('access requests', () => {
  let clientId: string;
  beforeAll(async () => {
    const [c] = await env.t.db
      .insert(mcpClients)
      .values({ userId, name: 'Claude Code', tokenHash: 'hash-cc' })
      .returning();
    clientId = c!.id;
  });

  it('allow creates a grant with the right expiry that lifts the policy', async () => {
    const principal = `mcp:${clientId}`;
    const p = { kind: 'mcp' as const, userId, clientId };
    // Strict personal: MCP can't read the personal mailbox...
    expect((await can(env.t.db, p, personal, 'email', 'read')).allow).toBe(false);

    const [req] = await env.t.db
      .insert(accessRequests)
      .values({
        userId,
        principal,
        clientName: 'Claude Code',
        accountId: personal,
        provider: 'gmail',
        resource: 'email',
        level: 'read',
        reason: 'Find the invoice',
      })
      .returning();
    const list = (
      await env.app.inject({ url: '/access-requests?status=pending', headers: auth })
    ).json().requests;
    expect(list).toHaveLength(1);

    const res = await env.app.inject({
      method: 'POST',
      url: `/access-requests/${req!.id}/allow`,
      headers: auth,
      payload: { durationMinutes: 60 },
    });
    expect(res.statusCode).toBe(200);
    const { grant } = res.json();
    expect(grant).toMatchObject({
      principal,
      accountId: personal,
      resource: 'email',
      level: 'read',
    });
    expect(new Date(grant.expiresAt).getTime() - env.now().getTime()).toBe(60 * 60_000);
    const [row] = await env.t.db.select().from(grants).where(eq(grants.id, grant.id));
    expect(row!.accessRequestId).toBe(req!.id);
    expect(row!.provider).toBe('gmail');

    // ...until the grant, which lasts exactly the hour.
    const at = async (ms: number) =>
      decide(
        (await loadContext(env.t.db, userId, personal, new Date(env.now().getTime() + ms)))!,
        p,
        'email',
        'read',
      );
    expect((await at(59 * 60_000)).allow).toBe(true);
    expect((await at(59 * 60_000)).source).toBe('grant');
    expect((await at(61 * 60_000)).allow).toBe(false);
    const [decided] = await env.t.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, req!.id));
    expect(decided!.status).toBe('allowed');
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: `/access-requests/${req!.id}/allow`,
          headers: auth,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);

    const tooLong = await env.t.db
      .insert(accessRequests)
      .values({ userId, principal, resource: 'email', accountId: personal })
      .returning();
    const r2 = await env.app.inject({
      method: 'POST',
      url: `/access-requests/${tooLong[0]!.id}/allow`,
      headers: auth,
      payload: { durationMinutes: 99999 },
    });
    expect(r2.statusCode).toBe(400);

    // Revoking the grant from the Permissions screen.
    const del = await env.app.inject({
      method: 'DELETE',
      url: `/grants/${grant.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
    const [revoked] = await env.t.db.select().from(grants).where(eq(grants.id, grant.id));
    expect(revoked!.revokedAt).not.toBeNull();
  });

  it('mcp_connect only marks the request allowed; deny marks denied', async () => {
    const connect = await connectRequest('482913');
    const before = (await env.t.db.select().from(grants)).length;
    const res = await allowConnect(connect.id, { pairingCode: '482 913' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ grant: null });
    expect((await env.t.db.select().from(grants)).length).toBe(before);
    const [row] = await env.t.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, connect.id));
    expect(row!.status).toBe('allowed');
    // The MCP server only issues a code when the API recorded the verified pairing.
    expect(row!.meta).toMatchObject({ pairingVerifiedAt: env.now().toISOString() });

    const [other] = await env.t.db
      .insert(accessRequests)
      .values({ userId, principal: `mcp:${clientId}`, resource: 'email', accountId: work })
      .returning();
    const deny = await env.app.inject({
      method: 'POST',
      url: `/access-requests/${other!.id}/deny`,
      headers: auth,
    });
    expect(deny.statusCode).toBe(204);
    const [denied] = await env.t.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, other!.id));
    expect(denied!.status).toBe('denied');
    const audits = await env.t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'access_request.denied'));
    expect(audits).toHaveLength(1);
  });
});

describe('mcp_connect pairing code', () => {
  it('refuses an allow without a code or with a wrong one', async () => {
    const req = await connectRequest('314159');
    const none = await allowConnect(req.id);
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe('pairing_code_required');

    const wrong = await allowConnect(req.id, { pairingCode: '000000' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe('wrong_pairing_code');

    const row = await requestRow(req.id);
    expect(row.status).toBe('pending');
    expect(row.meta).toMatchObject({ pairingAttempts: 1 });
    expect(row.meta).not.toHaveProperty('pairingVerifiedAt');
    // The code itself is never stored, and the serializer doesn't expose the hash.
    expect(JSON.stringify(row.meta)).not.toContain('314159');
    const listed = (await env.app.inject({ url: '/access-requests', headers: auth }))
      .json()
      .requests.find((r: { id: string }) => r.id === req.id);
    expect(listed).toMatchObject({ kind: 'mcp_connect', clientNameVerified: false });
    expect(JSON.stringify(listed)).not.toContain('pairing');

    // A pairing code for another request doesn't work here (the id salts the hash).
    const other = await connectRequest('271828');
    expect((await allowConnect(req.id, { pairingCode: '271828' })).statusCode).toBe(403);

    // The right code still works while attempts remain.
    const ok = await allowConnect(req.id, { pairingCode: '314159' });
    expect(ok.statusCode).toBe(200);
    expect((await requestRow(req.id)).status).toBe('allowed');
    expect((await requestRow(other.id)).status).toBe('pending');
  });

  it('denies the request after five wrong codes', async () => {
    const req = await connectRequest('161803');
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await allowConnect(req.id, { pairingCode: `99999${i}` });
      expect(r.statusCode).toBe(403);
      codes.push(r.json().error);
    }
    expect(codes).toEqual(Array(4).fill('wrong_pairing_code'));
    const fifth = await allowConnect(req.id, { pairingCode: '999995' });
    expect(fifth.statusCode).toBe(403);
    expect(fifth.json().error).toBe('pairing_locked');
    const row = await requestRow(req.id);
    expect(row.status).toBe('denied');
    expect(row.decidedAt).not.toBeNull();
    expect(row.meta).toMatchObject({ pairingAttempts: 5 });

    // Locked: even the right code is refused now.
    const late = await allowConnect(req.id, { pairingCode: '161803' });
    expect(late.statusCode).toBe(409);
    expect((await requestRow(req.id)).status).toBe('denied');
    const denied = await env.t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'access_request.denied'),
          eq(auditLog.target, `access_request:${req.id}`),
        ),
      );
    expect(denied).toHaveLength(1);
    expect(denied[0]!.details).toMatchObject({ reason: 'pairing_code' });
  });

  it('counts concurrent wrong guesses atomically', async () => {
    const req = await connectRequest('112358');
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) => allowConnect(req.id, { pairingCode: `00000${i}` })),
    );
    const errors = results.map((r) => r.json().error).sort();
    // Five attempts count (the fifth locks); the rest find it already decided.
    expect(errors.filter((e) => e === 'pairing_locked')).toHaveLength(1);
    expect(errors.filter((e) => e === 'wrong_pairing_code')).toHaveLength(4);
    expect(errors.filter((e) => e === 'not_pending')).toHaveLength(2);
    expect((await requestRow(req.id)).status).toBe('denied');
  });

  it('refuses a request older than the connect TTL, even with the right code', async () => {
    const stale = await connectRequest('141421', new Date(env.now().getTime() - 10 * 60_000));
    const res = await allowConnect(stale.id, { pairingCode: '141421' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('expired');
    expect((await requestRow(stale.id)).status).toBe('expired');

    // Just inside the TTL is fine.
    const fresh = await connectRequest('173205', new Date(env.now().getTime() - 9 * 60_000));
    expect((await allowConnect(fresh.id, { pairingCode: '173205' })).statusCode).toBe(200);
  });

  it('refuses a connect request that has no pairing code on file', async () => {
    const [legacy] = await env.t.db
      .insert(accessRequests)
      .values({
        userId,
        kind: 'mcp_connect',
        principal: 'mcp:pending',
        clientName: 'Cursor',
        resource: '*',
        createdAt: env.now(),
      })
      .returning();
    const res = await allowConnect(legacy!.id, { pairingCode: '123456' });
    expect(res.statusCode).toBe(409);
    expect((await requestRow(legacy!.id)).status).toBe('pending');
  });
});

describe('control', () => {
  it('pause and resume flip users.paused, audit, publish, and agents are denied while paused', async () => {
    await env.t.db.insert(events).values({
      accountId: work,
      provider: 'gmail',
      providerEventId: 'gmail:1',
      createdAt: new Date('2026-09-28T09:30:00Z'),
    });
    let res = await env.app.inject({ url: '/control', headers: auth });
    expect(res.json()).toMatchObject({
      paused: false,
      activeAgents: 4,
      accountsCount: 2,
      accountsNeedingAttention: [],
      connectedClients: ['Claude Code'],
      lastEventAt: '2026-09-28T09:30:00.000Z',
    });

    res = await env.app.inject({ method: 'POST', url: '/control/pause', headers: auth });
    expect(res.json()).toMatchObject({ paused: true, activeAgents: 0 });
    const [u] = await env.t.db.select().from(users).where(eq(users.id, userId));
    expect(u!.paused).toBe(true);
    expect(env.live.at(-1)).toEqual({ userId, event: { type: 'control.changed', paused: true } });
    const triage = { kind: 'agent' as const, userId, name: 'triage' };
    expect((await can(env.t.db, triage, work, 'email', 'read')).allow).toBe(false);

    res = await env.app.inject({ method: 'POST', url: '/control/resume', headers: auth });
    expect(res.json()).toMatchObject({ paused: false, activeAgents: 4 });
    expect((await can(env.t.db, triage, work, 'email', 'read')).allow).toBe(true);
    const audits = await env.t.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.userId, userId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['control.paused', 'control.resumed']),
    );
  });
});

describe('resume after pause', () => {
  it('re-queues triage for items that synced while paused, and only those', async () => {
    const [skipped, done] = await env.t.db
      .insert(items)
      .values([
        {
          accountId: work,
          kind: 'email',
          externalId: 'paused-1',
          title: 'While paused',
          receivedAt: new Date('2026-09-28T09:55:00Z'),
        },
        {
          accountId: work,
          kind: 'email',
          externalId: 'triaged-1',
          title: 'Already triaged',
          bucket: 'fyi',
          triage: {},
          receivedAt: new Date('2026-09-28T09:50:00Z'),
        },
      ])
      .returning();
    await env.app.inject({ method: 'POST', url: '/control/pause', headers: auth });
    const before = env.jobs.length;
    await env.app.inject({ method: 'POST', url: '/control/resume', headers: auth });
    const triage = env.jobs.slice(before).filter((j) => j.name === 'agents');
    const ids = triage.map((j) => (j.data as { itemId: string }).itemId);
    expect(ids).toContain(skipped!.id);
    expect(ids).not.toContain(done!.id);
    expect(new Set(triage.map((j) => j.opts?.jobId)).size).toBe(triage.length);
  });
});

describe('permissions', () => {
  it('builds the matrix with provider and account rows, sources and principals', async () => {
    const [client] = await env.t.db.select().from(mcpClients).where(eq(mcpClients.userId, userId));
    const principal = `mcp:${client!.id}`;
    const res = await env.app.inject({
      url: `/permissions?principal=${encodeURIComponent(principal)}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.preset).toBe('balanced');
    expect(body.principals.map((p: { key: string }) => p.key)).toEqual([
      'agent:triage',
      'agent:reply',
      'agent:brief',
      'agent:extractor',
      principal,
    ]);
    const email = body.data.filter((r: { resource: string }) => r.resource === 'email');
    expect(email).toContainEqual(
      expect.objectContaining({
        provider: 'gmail',
        accountId: null,
        label: 'Gmail',
        level: 'read',
        source: 'preset',
      }),
    );
    // The personal account is hidden from MCP clients by the strict rule.
    expect(email).toContainEqual(
      expect.objectContaining({
        accountId: personal,
        level: 'none',
        source: 'account',
        scope: 'Only with a temporary grant',
      }),
    );
    const send = body.actions.find(
      (r: { resource: string; accountId: string | null }) =>
        r.resource === 'message.send' && r.accountId === null,
    );
    expect(send).toMatchObject({ label: 'Send messages', level: 'ask' });
    expect(body.data.map((r: { resource: string }) => r.resource)).not.toContain('tickets');

    const unknown = await env.app.inject({
      url: '/permissions?principal=mcp:someone-else',
      headers: auth,
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('PUT /policies upserts provider-wide and account rules that the matrix reflects', async () => {
    const put = (payload: object) =>
      env.app.inject({ method: 'PUT', url: '/policies', headers: auth, payload });
    let res = await put({
      principal: 'agent:triage',
      provider: 'gmail',
      accountId: null,
      resource: 'calendar',
      level: 'none',
    });
    expect(res.statusCode).toBe(204);
    res = await put({
      principal: 'agent:triage',
      provider: 'gmail',
      accountId: null,
      resource: 'calendar',
      level: 'read',
    });
    expect(res.statusCode).toBe(204);
    res = await put({
      principal: 'agent:triage',
      provider: null,
      accountId: work,
      resource: 'email.label',
      level: 'never',
    });
    expect(res.statusCode).toBe(204);
    expect(
      (
        await put({
          principal: 'agent:triage',
          provider: 'gmail',
          accountId: null,
          resource: 'tickets',
          level: 'read',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await put({
          principal: 'nobody',
          provider: null,
          accountId: null,
          resource: 'email',
          level: 'read',
        })
      ).statusCode,
    ).toBe(400);

    const body = (
      await env.app.inject({ url: '/permissions?principal=agent:triage', headers: auth })
    ).json();
    const cal = body.data.find(
      (r: { resource: string; accountId: string | null }) =>
        r.resource === 'calendar' && r.accountId === null,
    );
    expect(cal).toMatchObject({ level: 'read', source: 'provider', label: 'Google Calendar' });
    expect(body.actions).toContainEqual(
      expect.objectContaining({
        resource: 'email.label',
        accountId: work,
        level: 'never',
        source: 'account',
      }),
    );
    const triage = { kind: 'agent' as const, userId, name: 'triage' };
    expect((await can(env.t.db, triage, work, 'email.label', 'write')).allow).toBe(false);
  });
});
