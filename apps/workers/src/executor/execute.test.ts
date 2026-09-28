import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectorError,
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
import {
  executeProposal,
  isAmbiguousError,
  NEEDS_REVIEW,
  RECONCILE_DELAYS_MS,
  type ExecutorDeps,
} from './execute';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let secrets: SecretStore;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  // The executor's store: the only one built with write-decrypt capability.
  secrets = new SecretStore(db, new LocalKeyProvider(randomBytes(32).toString('base64')), {
    writeKeys: new LocalKeyProvider(randomBytes(32).toString('base64')),
    allowWriteDecrypt: true,
  });
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
  /** The next N lookups miss even if the message was sent (Gmail has not indexed it yet). */
  hiddenLookups = 0;
  /** Throw this from findExecuted. */
  failLookup: Error | null = null;

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
        if (this.failLookup) throw this.failLookup;
        if (this.hiddenLookups > 0) {
          this.hiddenLookups--;
          return null;
        }
        const i = this.sent.findIndex((s) => s.key === key);
        return i < 0 ? null : { externalId: `gm-${i + 1}`, threadId: 'thread-1' };
      };
    }
    return c as Connector;
  }
}

let mail: FakeMail;
let live: LiveEvent[];
let waits: number[];
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
  waits = [];
  const [u] = await db
    .insert(users)
    .values({ email: `u${randomBytes(4).toString('hex')}@test.dev` })
    .returning();
  userId = u!.id;
  const readRef = await secrets.put(
    userId,
    'oauth:gmail',
    JSON.stringify({ accessToken: 'read-token' }),
  );
  const writeRef = await secrets.put(
    userId,
    'oauth:gmail:write',
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
    sleep: async (ms) => {
      waits.push(ms);
    },
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
      .orderBy(auditLog.id)
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
    expect(await actions(p.id)).toEqual([
      'executor.start',
      'executor.sending',
      'executor.executed',
    ]);
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

  it('reconciles a timeout that happened after the send instead of re-sending', async () => {
    mail.failAfterSend = new RetryableError('gmail', 'network error TimeoutError');
    const p = await proposal();
    const out = await executeProposal(deps, p.id);
    expect(out).toEqual({ status: 'executed', externalId: 'gm-1', reconciled: true });
    expect(mail.sent).toHaveLength(1);
    // The lookup uses the read token (gmail.send cannot search).
    expect(mail.lookups).toEqual(['read-token']);
    expect(waits).toEqual([]);
  });

  it('keeps looking while Gmail has not indexed the send yet (2s, 5s, 15s)', async () => {
    mail.failAfterSend = new RetryableError('gmail', 'network error ECONNRESET');
    mail.hiddenLookups = 3;
    const p = await proposal();
    const out = await executeProposal(deps, p.id);
    expect(out).toMatchObject({ status: 'executed', reconciled: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.lookups).toHaveLength(4);
    expect(waits).toEqual([...RECONCILE_DELAYS_MS]);
  });

  it('an ambiguous failure never found → failed needs_review, never re-sent', async () => {
    mail.failAfterSend = new RetryableError('gmail', 'network error ETIMEDOUT');
    mail.hiddenLookups = 100;
    const p = await proposal();
    const out = await executeProposal(deps, p.id);
    expect(out).toEqual({ status: 'failed', reason: NEEDS_REVIEW });
    const row = await load(p.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(NEEDS_REVIEW);
    expect(await actions(p.id)).toEqual(['executor.start', 'executor.sending', 'executor.failed']);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `proposal:${p.id}`))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(a!.details).toMatchObject({ reason: NEEDS_REVIEW, needsReview: true });
    // Further jobs (BullMQ retries, duplicates) never send again.
    mail.failAfterSend = null;
    expect((await executeProposal(deps, p.id)).status).toBe('skipped');
    expect(mail.sent).toHaveLength(1);
  });

  it('lookup errors on the ambiguous path count as misses → needs_review, no re-send', async () => {
    mail.failAfterSend = new RetryableError('gmail', 'network error ECONNRESET');
    mail.failLookup = new RetryableError('gmail', 'gmail responded 503', { status: 503 });
    const p = await proposal();
    expect(await executeProposal(deps, p.id)).toEqual({ status: 'failed', reason: NEEDS_REVIEW });
    expect(mail.sent).toHaveLength(1);
    expect(mail.lookups).toHaveLength(4);
  });

  it('a retry that finds a send was attempted does not re-send on one missed lookup', async () => {
    // A worker died mid-send: `executing` with the send marker and nothing confirmed.
    const p = await proposal({ status: 'executing' });
    await db.insert(auditLog).values({
      userId,
      principal: 'system:executor',
      action: 'executor.sending',
      target: `proposal:${p.id}`,
    });
    mail.sent.push({ key: p.idempotencyKey, payload: PAYLOAD, token: 'write-token' });
    mail.hiddenLookups = 2;
    const found = await executeProposal(deps, p.id);
    expect(found).toMatchObject({ status: 'executed', reconciled: true });
    expect(mail.sent).toHaveLength(1);
    expect(waits).toEqual([2_000, 5_000]);

    const q = await proposal({ status: 'executing' });
    await db.insert(auditLog).values({
      userId,
      principal: 'system:executor',
      action: 'executor.sending',
      target: `proposal:${q.id}`,
    });
    mail.hiddenLookups = 100;
    expect(await executeProposal(deps, q.id)).toEqual({ status: 'failed', reason: NEEDS_REVIEW });
    expect(mail.sent).toHaveLength(1);
  });

  it('a clean retry (429 before sending) re-sends after one lookup', async () => {
    mail.failBeforeSend = new RetryableError('gmail', 'gmail responded 429', { status: 429 });
    const p = await proposal();
    await expect(executeProposal(deps, p.id)).rejects.toBeInstanceOf(RetryableError);
    expect(await actions(p.id)).toContain('executor.retry');
    mail.failBeforeSend = null;
    expect(await executeProposal(deps, p.id)).toMatchObject({
      status: 'executed',
      reconciled: false,
    });
    expect(mail.sent).toHaveLength(1);
    expect(mail.lookups).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('classifies ambiguous errors', () => {
    expect(isAmbiguousError(new RetryableError('gmail', 'network error ETIMEDOUT'))).toBe(true);
    expect(isAmbiguousError(new RetryableError('gmail', 'x', { status: 502 }))).toBe(true);
    expect(isAmbiguousError(new RetryableError('gmail', 'x', { status: 503 }))).toBe(false);
    expect(isAmbiguousError(new RetryableError('gmail', 'x', { status: 429 }))).toBe(false);
    expect(isAmbiguousError(new ConnectorError('gmail', 'x', { status: 400 }))).toBe(false);
    expect(isAmbiguousError(new ReconnectRequiredError('gmail'))).toBe(false);
    expect(isAmbiguousError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isAmbiguousError(new Error('plain'))).toBe(false);
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
    mail.hiddenLookups = 4; // not indexed during the first attempt's lookups
    const p = await proposal();
    const first = await executeProposal(deps, p.id, { finalAttempt: true });
    expect(first).toEqual({ status: 'failed', reason: NEEDS_REVIEW });
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
    mail.failBeforeSend = new ConnectorError('gmail', 'invalid recipient', { status: 400 });
    expect((await executeProposal(deps, p2.id)).status).toBe('failed');
    expect((await load(p2.id)).error).toContain('invalid recipient');
    expect(mail.sent).toHaveLength(0);
  });

  it('never stores or audits the message of a non-connector error (DB errors carry params)', async () => {
    const dbError = Object.assign(
      new Error('Failed query: insert into x values ($1)\nparams: meera@acme.com,SECRET-BODY'),
      { name: 'DrizzleQueryError', cause: { code: '23505' } },
    );
    mail.failBeforeSend = dbError;
    const p = await proposal();
    expect(await executeProposal(deps, p.id)).toEqual({
      status: 'failed',
      reason: 'DrizzleQueryError (23505)',
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `proposal:${p.id}`));
    expect(JSON.stringify(rows)).not.toContain('SECRET-BODY');
    expect((await load(p.id)).error).not.toContain('meera@acme.com');
  });

  it('missing proposal', async () => {
    expect(await executeProposal(deps, '00000000-0000-0000-0000-000000000000')).toEqual({
      status: 'missing',
    });
  });
});

describe('executor: Phase 5 actions', () => {
  type Call = { action: string; payload: Record<string, unknown>; key: string; token: string };

  /** A connector for any provider that records every write it performs. */
  function recorder(provider: string) {
    const calls: Call[] = [];
    const connector = {
      provider,
      execute: async (
        ctx: ConnectorContext,
        action: string,
        payload: Record<string, unknown>,
        key: string,
      ) => {
        calls.push({ action, payload, key, token: ctx.tokens.accessToken });
        return { externalId: `${provider}-${calls.length}`, channelId: 'C1', text: 'never stored' };
      },
      findExecuted: async () => null,
    } as unknown as Connector;
    return { calls, connector };
  }

  async function accountFor(provider: string, over: { writeKind?: string } = {}) {
    const readRef = await secrets.put(
      userId,
      `oauth:${provider}`,
      JSON.stringify({ accessToken: `${provider}-read` }),
    );
    const writeRef = await secrets.put(
      userId,
      over.writeKind ?? `oauth:${provider}:write`,
      JSON.stringify({ accessToken: `${provider}-write` }),
    );
    const [a] = await db
      .insert(accounts)
      .values({
        userId,
        provider,
        nickname: provider,
        color: '#3B5BA9',
        externalId: `${provider}-${randomBytes(3).toString('hex')}`,
        status: 'live',
        tokenRef: readRef,
        writeTokenRef: writeRef,
      })
      .returning();
    return a!.id;
  }

  const CASES = [
    {
      action: 'outlook.send',
      provider: 'microsoft',
      payload: {
        to: ['priya@contoso.com'],
        cc: [],
        subject: 'Re: API spec',
        body: 'It lives in the wiki.',
        inReplyTo: 'AAMkAGI2TG93AAA=',
      },
      bad: { to: ['not-an-email'], subject: 'x', body: 'y' },
    },
    {
      action: 'slack.post',
      provider: 'slack',
      payload: {
        channel: 'C024BE91L',
        text: 'It lives in the wiki.',
        threadTs: '1727500000.000100',
      },
      bad: { text: 'no channel' },
    },
    {
      action: 'jira.transition',
      provider: 'atlassian',
      payload: { issueKey: 'PROJ-482', transitionId: '31', toStatus: 'In Progress' },
      bad: { issueKey: 'proj-482', transitionId: '31', toStatus: 'x' },
    },
    {
      action: 'jira.comment',
      provider: 'atlassian',
      payload: { issueKey: 'PROJ-482', body: 'Picking this up today.' },
      bad: { issueKey: 'PROJ-482', body: '' },
    },
  ] as const;

  it.each(CASES)('$action runs once on a $provider account with the stored payload', async (c) => {
    const acct = await accountFor(c.provider);
    const rec = recorder(c.provider);
    const providersAsked: string[] = [];
    deps.getConnector = (p) => {
      providersAsked.push(p);
      return rec.connector;
    };
    const p = await proposal({ accountId: acct, action: c.action, payload: c.payload });
    const out = await executeProposal(deps, p.id);
    expect(out).toEqual({ status: 'executed', externalId: `${c.provider}-1`, reconciled: false });
    // Run again (a duplicate job): nothing more is sent.
    await executeProposal(deps, p.id);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toEqual({
      action: c.action,
      payload: c.payload,
      key: p.idempotencyKey,
      token: `${c.provider}-write`,
    });
    expect(providersAsked).toEqual([c.provider]);
    const row = await load(p.id);
    expect(row.status).toBe('executed');
    expect(row.result).toEqual({ externalId: `${c.provider}-1`, channelId: 'C1' }); // ids only
    expect(await actions(p.id)).toEqual([
      'executor.start',
      'executor.sending',
      'executor.executed',
    ]);
  });

  it.each(CASES)('$action with an invalid stored payload fails without sending', async (c) => {
    const acct = await accountFor(c.provider);
    const rec = recorder(c.provider);
    deps.getConnector = () => rec.connector;
    const p = await proposal({ accountId: acct, action: c.action, payload: c.bad });
    expect(await executeProposal(deps, p.id)).toEqual({
      status: 'failed',
      reason: 'payload failed validation',
    });
    expect(rec.calls).toHaveLength(0);
  });

  it('refuses an action on the wrong provider (slack.post from Gmail, outlook.send from Slack)', async () => {
    const rec = recorder('slack');
    deps.getConnector = () => rec.connector;
    const a = await proposal({ action: 'slack.post', payload: CASES[1].payload });
    expect(await executeProposal(deps, a.id)).toEqual({
      status: 'failed',
      reason: 'slack.post needs a slack account',
    });
    const slack = await accountFor('slack');
    const b = await proposal({
      accountId: slack,
      action: 'outlook.send',
      payload: CASES[0].payload,
    });
    expect((await executeProposal(deps, b.id)).status).not.toBe('executed');
    expect(rec.calls).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it('only opens a write token of the account provider kind', async () => {
    // A Slack account whose write ref points at a Gmail write secret.
    const acct = await accountFor('slack', { writeKind: 'oauth:gmail:write' });
    const rec = recorder('slack');
    deps.getConnector = () => rec.connector;
    const p = await proposal({ accountId: acct, action: 'slack.post', payload: CASES[1].payload });
    expect((await executeProposal(deps, p.id)).status).toBe('failed');
    expect(rec.calls).toHaveLength(0);
  });

  it('jira actions need ticket.update, re-checked at execution time', async () => {
    const acct = await accountFor('atlassian');
    const rec = recorder('atlassian');
    deps.getConnector = () => rec.connector;
    await db.insert(policies).values({
      userId,
      principal: 'mcp:*',
      accountId: acct,
      resource: 'ticket.update',
      level: 'never',
    });
    const p = await proposal({
      accountId: acct,
      agent: 'mcp:claude',
      action: 'jira.comment',
      payload: CASES[3].payload,
    });
    const out = await executeProposal(deps, p.id);
    expect(out.status).toBe('denied');
    expect((await load(p.id)).error).toMatch(/never/);
    expect(rec.calls).toHaveLength(0);
  });

  it('gmail.label has no payload schema yet and is refused', async () => {
    const p = await proposal({ action: 'gmail.label', payload: { label: 'x' } });
    expect(await executeProposal(deps, p.id)).toEqual({
      status: 'failed',
      reason: 'no payload schema for gmail.label',
    });
    expect(mail.sent).toHaveLength(0);
  });
});
