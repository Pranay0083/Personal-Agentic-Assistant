import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ReconnectRequiredError,
  RetryableError,
  type Connector,
  type ConnectorContext,
  type ExecuteResult,
} from '@hub/connectors';
import { accounts, auditLog, policies, proposals, users, type Db } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import { LocalKeyProvider, SecretStore } from '@hub/server/secrets';
import type { LiveEvent } from '@hub/shared/queues';
import { executeProposal, type ExecutorDeps } from './execute';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let secrets: SecretStore;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  secrets = new SecretStore(db, new LocalKeyProvider(randomBytes(32).toString('base64')));
});
afterAll(async () => t?.drop());

type Sent = { key: string; payload: Record<string, unknown>; token: string };

/** A fake Gmail that really "sends" (records) every call, so double-sends are visible. */
class FakeMail {
  sent: Sent[] = [];
  lookups: string[] = [];
  delayMs = 0;
  /** Throw this after recording the send (e.g. a timeout after the server accepted it). */
  failAfterSend: Error | null = null;
  /** Throw this instead of sending. */
  failBeforeSend: Error | null = null;
  withFind = true;

  connector(): Connector {
    const c: Partial<Connector> = {
      provider: 'gmail',
      execute: async (
        ctx: ConnectorContext,
        _action: string,
        payload: Record<string, unknown>,
        key: string,
      ) => {
        if (this.failBeforeSend) throw this.failBeforeSend;
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        this.sent.push({ key, payload, token: ctx.tokens.accessToken });
        if (this.failAfterSend) throw this.failAfterSend;
        return {
          externalId: `gm-${this.sent.length}`,
          threadId: 'thread-1',
          messageId: `<${key}@hub>`,
        } as ExecuteResult;
      },
    };
    if (this.withFind) {
      c.findExecuted = async (ctx: ConnectorContext, _action: string, key: string) => {
        this.lookups.push(ctx.tokens.accessToken);
        const i = this.sent.findIndex((s) => s.key === key);
        return i < 0 ? null : { externalId: `gm-${i + 1}`, threadId: 'thread-1' };
      };
    }
    return c as Connector;
  }
}

let mail: FakeMail;
let live: LiveEvent[];
let deps: ExecutorDeps;
let userId: string;
let accountId: string;

const PAYLOAD = {
  to: ['meera@acme.com'],
  cc: [],
  subject: 'Re: Q3 deck',
  body: "Yes, I'll send the Q3 deck by Thursday.",
  threadId: 'thread-1',
};

beforeEach(async () => {
  mail = new FakeMail();
  live = [];
  const [u] = await db
    .insert(users)
    .values({ email: `u${randomBytes(4).toString('hex')}@test.dev` })
    .returning();
  userId = u!.id;
  const readRef = await secrets.put(
    userId,
    'gmail:read',
    JSON.stringify({ accessToken: 'read-token' }),
  );
  const writeRef = await secrets.put(
    userId,
    'gmail:write',
    JSON.stringify({ accessToken: 'write-token' }),
  );
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      provider: 'gmail',
      nickname: 'Work',
      color: '#1F6F6B',
      externalId: 'me@work.dev',
      status: 'live',
      tokenRef: readRef,
      writeTokenRef: writeRef,
    })
    .returning();
  accountId = a!.id;
  deps = {
    db,
    secrets,
    getConnector: () => mail.connector(),
    publishLive: async (_u, e) => {
      live.push(e);
    },
    now: () => new Date('2026-09-28T10:00:00Z'),
  };
});

async function proposal(over: Partial<typeof proposals.$inferInsert> = {}) {
  const [p] = await db
    .insert(proposals)
    .values({
      userId,
      accountId,
      agent: 'agent:reply',
      model: 'claude-sonnet-5',
      action: 'gmail.send',
      title: 'Reply to Meera: Q3 deck timeline',
      payload: PAYLOAD,
      status: 'approved',
      idempotencyKey: `reply:${randomBytes(8).toString('hex')}`,
      ...over,
    })
    .returning();
  return p!;
}

const load = async (id: string) =>
  (await db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
const actions = async (id: string) =>
  (
    await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `proposal:${id}`))
  ).map((r) => r.action);

describe('executor: sends exactly once', () => {
  it('sends an approved proposal with exactly the stored recipients', async () => {
    const p = await proposal();
    const out = await executeProposal(deps, p.id);
    expect(out).toEqual({ status: 'executed', externalId: 'gm-1', reconciled: false });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.payload).toEqual(PAYLOAD);
    expect(mail.sent[0]!.payload.to).toEqual(['meera@acme.com']);
    expect(mail.sent[0]!.key).toBe(p.idempotencyKey);
    expect(mail.sent[0]!.token).toBe('write-token');
    const row = await load(p.id);
    expect(row.status).toBe('executed');
    expect(row.executedAt).toEqual(new Date('2026-09-28T10:00:00Z'));
    expect(row.result).toEqual({
      externalId: 'gm-1',
      threadId: 'thread-1',
      messageId: `<${p.idempotencyKey}@hub>`,
    });
    expect(await actions(p.id)).toEqual(['executor.start', 'executor.executed']);
    expect(live).toContainEqual({ type: 'proposal.updated', proposalId: p.id });
  });

  it('sends once when two jobs run concurrently', async () => {
    mail.delayMs = 100;
    const p = await proposal();
    const outs = await Promise.all([executeProposal(deps, p.id), executeProposal(deps, p.id)]);
    expect(mail.sent).toHaveLength(1);
    expect(outs.map((o) => o.status).sort()).toEqual(['executed', 'skipped']);
    expect((await load(p.id)).status).toBe('executed');
  });

  it('sends once when five jobs race', async () => {
    mail.delayMs = 30;
    const p = await proposal();
    await Promise.all(Array.from({ length: 5 }, () => executeProposal(deps, p.id)));
    expect(mail.sent).toHaveLength(1);
  });

  it('does not re-send when retried after a timeout that happened after the send', async () => {
    mail.failAfterSend = new RetryableError('gmail', 'socket timeout');
    const p = await proposal();
    await expect(executeProposal(deps, p.id)).rejects.toBeInstanceOf(RetryableError);
    expect((await load(p.id)).status).toBe('executing');

    mail.failAfterSend = null;
    const out = await executeProposal(deps, p.id);
    expect(out).toEqual({ status: 'executed', externalId: 'gm-1', reconciled: true });
    expect(mail.sent).toHaveLength(1);
    // The lookup uses the read token (gmail.send cannot search).
    expect(mail.lookups).toEqual(['read-token']);
  });

  it('reconciles after a crash between send and bookkeeping', async () => {
    const p = await proposal();
    // Simulate: claimed, sent, then the process died before marking executed.
    await db.update(proposals).set({ status: 'executing' }).where(eq(proposals.id, p.id));
    mail.sent.push({ key: p.idempotencyKey, payload: PAYLOAD, token: 'write-token' });

    const out = await executeProposal(deps, p.id);
    expect(out).toMatchObject({ status: 'executed', reconciled: true });
    expect(mail.sent).toHaveLength(1);
    expect((await load(p.id)).status).toBe('executed');
  });

  it('sends when a crash happened before the send', async () => {
    const p = await proposal({ status: 'executing' });
    const out = await executeProposal(deps, p.id);
    expect(out).toMatchObject({ status: 'executed', reconciled: false });
    expect(mail.sent).toHaveLength(1);
    expect(mail.lookups).toHaveLength(1);
  });

  it('refuses to resume without findExecuted rather than risk a duplicate', async () => {
    mail.withFind = false;
    const p = await proposal({ status: 'executing' });
    const out = await executeProposal(deps, p.id);
    expect(out.status).toBe('failed');
    expect(mail.sent).toHaveLength(0);
  });

  it('checks for an earlier send when a failed proposal is re-approved', async () => {
    mail.failAfterSend = new RetryableError('gmail', 'timeout');
    const p = await proposal();
    const first = await executeProposal(deps, p.id, { finalAttempt: true });
    expect(first.status).toBe('failed');
    expect(mail.sent).toHaveLength(1);

    mail.failAfterSend = null;
    await db.update(proposals).set({ status: 'approved' }).where(eq(proposals.id, p.id));
    const again = await executeProposal(deps, p.id);
    expect(again).toMatchObject({ status: 'executed', reconciled: true });
    expect(mail.sent).toHaveLength(1);
  });

  it('running an executed proposal again is a no-op', async () => {
    const p = await proposal();
    await executeProposal(deps, p.id);
    expect(await executeProposal(deps, p.id)).toEqual({
      status: 'skipped',
      reason: 'status is executed',
    });
    expect(mail.sent).toHaveLength(1);
  });
});

describe('executor: never sends without a valid approval', () => {
  it.each(['pending', 'rejected', 'failed', 'expired'])(
    '%s proposals never send',
    async (status) => {
      const p = await proposal({ status });
      const out = await executeProposal(deps, p.id);
      expect(out).toEqual({ status: 'skipped', reason: `status is ${status}` });
      expect(mail.sent).toHaveLength(0);
      expect((await load(p.id)).status).toBe(status);
    },
  );

  it('paused user → denied, failed, no send', async () => {
    const p = await proposal();
    await db.update(users).set({ paused: true }).where(eq(users.id, userId));
    const out = await executeProposal(deps, p.id);
    expect(out.status).toBe('denied');
    expect(mail.sent).toHaveLength(0);
    const row = await load(p.id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/paused/);
    expect(await actions(p.id)).toEqual(['executor.start', 'executor.denied']);
  });

  it('policy changed to never after approval → no send', async () => {
    const p = await proposal();
    await db.insert(policies).values({
      userId,
      principal: 'agent:reply',
      accountId,
      resource: 'message.send',
      level: 'never',
    });
    const out = await executeProposal(deps, p.id);
    expect(out.status).toBe('denied');
    expect(mail.sent).toHaveLength(0);
    expect((await load(p.id)).error).toMatch(/never/);
  });

  it('re-checks policy for MCP principals too', async () => {
    const p = await proposal({ agent: 'mcp:claude' });
    await db.insert(policies).values({
      userId,
      principal: 'mcp:*',
      provider: 'gmail',
      resource: 'message.send',
      level: 'never',
    });
    expect((await executeProposal(deps, p.id)).status).toBe('denied');
    expect(mail.sent).toHaveLength(0);
  });

  it('missing write token → failed "write access not granted"', async () => {
    await db.update(accounts).set({ writeTokenRef: null }).where(eq(accounts.id, accountId));
    const p = await proposal();
    const out = await executeProposal(deps, p.id);
    expect(out).toEqual({ status: 'failed', reason: 'write access not granted' });
    expect(mail.sent).toHaveLength(0);
    expect((await load(p.id)).error).toBe('write access not granted');
  });

  it('an invalid stored payload → failed, no send', async () => {
    const p = await proposal({ payload: { to: [], subject: 'x', body: 'y' } });
    expect((await executeProposal(deps, p.id)).status).toBe('failed');
    expect(mail.sent).toHaveLength(0);
  });

  it('unknown principal → denied', async () => {
    const p = await proposal({ agent: 'someone-else' });
    expect((await executeProposal(deps, p.id)).status).toBe('denied');
    expect(mail.sent).toHaveLength(0);
  });
});

describe('executor: errors', () => {
  it('retryable errors before send rethrow and keep the proposal executing', async () => {
    mail.failBeforeSend = new RetryableError('gmail', 'rate limited', { status: 429 });
    const p = await proposal();
    await expect(executeProposal(deps, p.id)).rejects.toBeInstanceOf(RetryableError);
    expect((await load(p.id)).status).toBe('executing');
    mail.failBeforeSend = null;
    expect((await executeProposal(deps, p.id)).status).toBe('executed');
    expect(mail.sent).toHaveLength(1);
  });

  it('gives up on the final attempt', async () => {
    mail.failBeforeSend = new RetryableError('gmail', 'rate limited', { status: 429 });
    const p = await proposal();
    const out = await executeProposal(deps, p.id, { finalAttempt: true });
    expect(out.status).toBe('failed');
    expect((await load(p.id)).status).toBe('failed');
  });

  it('permanent errors fail the proposal', async () => {
    mail.failBeforeSend = new ReconnectRequiredError('gmail');
    const p = await proposal();
    expect(await executeProposal(deps, p.id)).toEqual({
      status: 'failed',
      reason: 'reconnect required',
    });
    const p2 = await proposal();
    mail.failBeforeSend = new Error('invalid recipient');
    expect((await executeProposal(deps, p2.id)).status).toBe('failed');
    expect((await load(p2.id)).error).toContain('invalid recipient');
  });

  it('missing proposal', async () => {
    expect(await executeProposal(deps, '00000000-0000-0000-0000-000000000000')).toEqual({
      status: 'missing',
    });
  });
});
