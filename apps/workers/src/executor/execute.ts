import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { accounts, audit, auditLog, proposals, type Db } from '@hub/db';
import {
  ReconnectRequiredError,
  RetryableError,
  type Connector,
  type ConnectorContext,
  type ExecuteResult,
  type OAuthTokens,
} from '@hub/connectors';
import { can, parsePrincipal } from '@hub/policy';
import type { Logger } from '@hub/server';
import { AccountFilters, GmailSendPayload, type ActionResource } from '@hub/shared';
import type { LiveEvent } from '@hub/shared/queues';

/**
 * The executor is the only code that performs external writes, and only for proposals the
 * user approved. Safety properties (tested in execute.test.ts):
 * - A Postgres advisory lock per proposal serialises concurrent jobs; the atomic
 *   `approved → executing` claim is committed before any send.
 * - Policy is re-checked at execution time; a denial fails the proposal without sending.
 * - A proposal found in `executing` (crash between send and bookkeeping) is reconciled with
 *   `connector.findExecuted` before anything is re-sent. Without that lookup it is failed.
 * - Recipients and content come only from the stored, re-validated payload.
 */

export type ExecutorDeps = {
  db: Db;
  secrets: {
    get(ref: string): Promise<string>;
    replace(ref: string, value: string): Promise<void>;
  };
  /** Connector registry lookup; may throw for unsupported providers. */
  getConnector: (provider: string) => Connector;
  publishLive: (userId: string, event: LiveEvent) => Promise<void>;
  now: () => Date;
  log?: Logger;
};

export type ExecOutcome =
  | { status: 'missing' }
  | { status: 'skipped'; reason: string }
  | { status: 'executed'; externalId: string; reconciled: boolean }
  | { status: 'failed'; reason: string }
  | { status: 'denied'; reason: string };

/** Policy resource each write action needs. */
export const ACTION_RESOURCE: Record<string, ActionResource> = {
  'gmail.send': 'message.send',
  'slack.post': 'message.send',
  'gmail.label': 'email.label',
  'jira.transition': 'ticket.update',
};

export function resourceForAction(action: string): ActionResource | null {
  return ACTION_RESOURCE[action] ?? null;
}

/** Payload schemas the executor re-validates against right before executing. */
export const PAYLOAD_SCHEMAS: Record<string, z.ZodType<Record<string, unknown>>> = {
  'gmail.send': GmailSendPayload,
};

const EXECUTOR = 'system:executor';
const LOCK_NAMESPACE = 7_310_001;

class PermanentFailure extends Error {}

function parseTokens(raw: string): OAuthTokens {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && typeof (v as OAuthTokens).accessToken === 'string') {
      return v as OAuthTokens;
    }
  } catch {
    // not JSON: a bare access token
  }
  return { accessToken: raw };
}

/** Result stored on the proposal: ids only, never content. */
export function idsOnly(result: ExecuteResult): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(result)) {
    if (!/id$/i.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || v === null) out[k] = v;
  }
  return out;
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof ReconnectRequiredError) return false;
  if (err instanceof RetryableError) return true;
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; code?: unknown; retryable?: unknown };
    if (e.retryable === true) return true;
    if (typeof e.status === 'number') return e.status === 429 || e.status >= 500;
    if (
      typeof e.code === 'string' &&
      /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|UND_ERR)/.test(e.code)
    ) {
      return true;
    }
  }
  return false;
}

const safeMessage = (err: unknown) =>
  (err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error').slice(0, 300);

export async function executeProposal(
  deps: ExecutorDeps,
  proposalId: string,
  opts: { finalAttempt?: boolean } = {},
): Promise<ExecOutcome> {
  const { db } = deps;
  return db.transaction(async (tx) => {
    // Serialise every job for this proposal. The lock is released on commit, rollback or
    // when a crashed worker's connection drops. try-lock (not a blocking wait) so duplicate
    // jobs never tie up pool connections: the holder finishes the work (its own job retries
    // if it crashes), so a duplicate can simply stand down.
    const res = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${proposalId})) as locked`,
    );
    const locked = (res as unknown as { locked: boolean }[])[0]?.locked === true;
    if (!locked) return { status: 'skipped', reason: 'in progress' } as const;
    return run(deps, proposalId, opts);
  });
}

async function run(
  deps: ExecutorDeps,
  proposalId: string,
  opts: { finalAttempt?: boolean },
): Promise<ExecOutcome> {
  // All bookkeeping below autocommits on `db` (not the lock transaction), so the
  // `executing` claim is durable before the send happens.
  const { db } = deps;
  const [row] = await db
    .select({ proposal: proposals, account: accounts })
    .from(proposals)
    .innerJoin(accounts, eq(proposals.accountId, accounts.id))
    .where(eq(proposals.id, proposalId));
  if (!row) return { status: 'missing' };
  const { proposal, account } = row;
  const userId = proposal.userId;
  const target = `proposal:${proposalId}`;

  const publish = () => deps.publishLive(userId, { type: 'proposal.updated', proposalId });
  const fail = async (reason: string, kind: 'executor.failed' | 'executor.denied') => {
    await db
      .update(proposals)
      .set({ status: 'failed', error: reason.slice(0, 300) })
      .where(
        and(eq(proposals.id, proposalId), inArray(proposals.status, ['approved', 'executing'])),
      );
    await audit(db, {
      userId,
      principal: EXECUTOR,
      action: kind,
      target,
      details: { reason: reason.slice(0, 300) },
    });
    await publish();
    return kind === 'executor.denied'
      ? ({ status: 'denied', reason } as const)
      : ({ status: 'failed', reason } as const);
  };

  let resumed: boolean;
  if (proposal.status === 'approved') {
    const claimed = await db
      .update(proposals)
      .set({ status: 'executing' })
      .where(and(eq(proposals.id, proposalId), eq(proposals.status, 'approved')))
      .returning({ id: proposals.id });
    if (claimed.length === 0) return { status: 'skipped', reason: 'already claimed' };
    // Re-approved after an earlier attempt: that attempt may have sent. Reconcile first.
    const [prior] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userId),
          eq(auditLog.action, 'executor.start'),
          eq(auditLog.target, target),
        ),
      )
      .limit(1);
    resumed = !!prior;
  } else if (proposal.status === 'executing') {
    resumed = true;
  } else {
    return { status: 'skipped', reason: `status is ${proposal.status}` };
  }
  await audit(db, {
    userId,
    principal: EXECUTOR,
    action: 'executor.start',
    target,
    details: { action: proposal.action, accountId: account.id, resumed },
  });
  await publish();

  try {
    // 1. Policy, re-checked now: the level may have changed or the user may have paused.
    const resource = resourceForAction(proposal.action);
    if (!resource) throw new PermanentFailure(`unsupported action ${proposal.action}`);
    let decision;
    try {
      decision = await can(
        db,
        parsePrincipal(proposal.agent, userId),
        account.id,
        resource,
        'write',
      );
    } catch {
      return await fail(`unknown principal ${proposal.agent}`, 'executor.denied');
    }
    if (!decision.allow) return await fail(`policy denied: ${decision.reason}`, 'executor.denied');
    // needsApproval is satisfied: only approved proposals reach this point.

    // 2. Payload, re-validated. Recipients come only from here.
    const schema = PAYLOAD_SCHEMAS[proposal.action];
    if (!schema) throw new PermanentFailure(`no payload schema for ${proposal.action}`);
    const parsed = schema.safeParse(proposal.payload);
    if (!parsed.success) throw new PermanentFailure('payload failed validation');
    const payload = parsed.data;

    // 3. Write-scope token (separate consent). Decrypted only here.
    if (!account.writeTokenRef) throw new PermanentFailure('write access not granted');
    let connector: Connector;
    try {
      connector = deps.getConnector(account.provider);
    } catch {
      throw new PermanentFailure(`no connector for ${account.provider}`);
    }
    if (!connector.execute)
      throw new PermanentFailure(`${account.provider} cannot execute ${proposal.action}`);

    const makeCtx = async (ref: string): Promise<ConnectorContext> => ({
      accountId: account.id,
      externalId: account.externalId,
      tokens: parseTokens(await deps.secrets.get(ref)),
      saveTokens: (tokens) => deps.secrets.replace(ref, JSON.stringify(tokens)),
      cursor: account.syncCursor,
      filters: AccountFilters.parse(account.filters ?? {}),
    });

    // 4. Crash-safe retry: did an earlier attempt already send?
    if (resumed) {
      if (!connector.findExecuted) {
        throw new PermanentFailure(
          'an earlier attempt may have sent this; not retrying to avoid a duplicate',
        );
      }
      // Gmail's send scope cannot search the mailbox, so the lookup uses the read token.
      const lookupRef = account.tokenRef ?? account.writeTokenRef;
      const found = await connector.findExecuted(
        await makeCtx(lookupRef),
        proposal.action,
        proposal.idempotencyKey,
      );
      if (found) return await markExecuted(deps, proposalId, userId, found, true);
    }

    const result = await connector.execute(
      await makeCtx(account.writeTokenRef),
      proposal.action,
      payload,
      proposal.idempotencyKey,
    );
    return await markExecuted(deps, proposalId, userId, result, false);
  } catch (err) {
    if (err instanceof PermanentFailure) return await fail(err.message, 'executor.failed');
    if (err instanceof ReconnectRequiredError)
      return await fail('reconnect required', 'executor.failed');
    if (isRetryableError(err)) {
      if (opts.finalAttempt) {
        return await fail(
          `gave up after retries (${safeMessage(err)}); it may not have been sent`,
          'executor.failed',
        );
      }
      deps.log?.warn(
        { proposalId, error: err instanceof Error ? err.name : 'error' },
        'executor retrying',
      );
      // Status stays `executing`; the retry reconciles with findExecuted before re-sending.
      throw err;
    }
    return await fail(safeMessage(err), 'executor.failed');
  }
}

async function markExecuted(
  deps: ExecutorDeps,
  proposalId: string,
  userId: string,
  result: ExecuteResult,
  reconciled: boolean,
): Promise<ExecOutcome> {
  const ids = idsOnly(result);
  await deps.db
    .update(proposals)
    .set({ status: 'executed', executedAt: deps.now(), result: ids, error: null })
    .where(and(eq(proposals.id, proposalId), eq(proposals.status, 'executing')));
  await audit(deps.db, {
    userId,
    principal: EXECUTOR,
    action: 'executor.executed',
    target: `proposal:${proposalId}`,
    details: { ...ids, reconciled },
  });
  await deps.publishLive(userId, { type: 'proposal.updated', proposalId });
  return { status: 'executed', externalId: result.externalId, reconciled };
}
