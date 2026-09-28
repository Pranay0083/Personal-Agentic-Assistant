import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { accounts, audit, auditLog, proposals, type Db } from '@hub/db';
import {
  ConnectorError,
  ReconnectRequiredError,
  RetryableError,
  type Connector,
  type ConnectorContext,
  type ExecuteResult,
  type OAuthTokens,
} from '@hub/connectors';
import { can, parsePrincipal } from '@hub/policy';
import { errorInfo, type Logger } from '@hub/server';
import {
  AccountFilters,
  PROPOSAL_PAYLOADS,
  type ActionResource,
  type ProposalAction,
} from '@hub/shared';
import type { LiveEvent } from '@hub/shared/queues';

/**
 * The executor is the only code that performs external writes, and only for proposals the
 * user approved. Safety properties (tested in execute.test.ts):
 * - A Postgres advisory lock per proposal serialises concurrent jobs; the atomic
 *   `approved → executing` claim is committed before any send.
 * - Policy is re-checked at execution time; a denial fails the proposal without sending.
 * - A proposal found in `executing` (crash between send and bookkeeping) is reconciled with
 *   `connector.findExecuted` before anything is re-sent. Without that lookup it is failed.
 * - Ambiguous failures (network error or timeout after the request may have reached the
 *   provider, or a retry that finds a send was attempted) never re-send because one lookup
 *   missed: the lookup is retried with delays (the provider may not have indexed the send
 *   yet) and, if still not found, the proposal fails `needs_review: delivery unknown`.
 *   An `executor.sending` audit row is written right before every send; an
 *   `executor.retry` row marks a retry that is known not to have sent.
 * - Recipients and content come only from the stored, re-validated payload.
 */

export type ExecutorDeps = {
  db: Db;
  secrets: {
    get(ref: string, expected?: { userId?: string; kind?: string }): Promise<string>;
    replace(ref: string, value: string): Promise<void>;
  };
  /** Connector registry lookup; may throw for unsupported providers. */
  getConnector: (provider: string) => Connector;
  publishLive: (userId: string, event: LiveEvent) => Promise<void>;
  now: () => Date;
  log?: Logger;
  /** Waits between findExecuted lookups after an ambiguous failure. Default 2s, 5s, 15s. */
  reconcileDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export const RECONCILE_DELAYS_MS = [2_000, 5_000, 15_000] as const;
export const NEEDS_REVIEW = 'needs_review: delivery unknown';

export type ExecOutcome =
  | { status: 'missing' }
  | { status: 'skipped'; reason: string }
  | { status: 'executed'; externalId: string; reconciled: boolean }
  | { status: 'failed'; reason: string }
  | { status: 'denied'; reason: string };

/** Policy resource each write action needs. */
export const ACTION_RESOURCE: Record<ProposalAction, ActionResource> = {
  'gmail.send': 'message.send',
  'outlook.send': 'message.send',
  'slack.post': 'message.send',
  'gmail.label': 'email.label',
  'jira.transition': 'ticket.update',
  'jira.comment': 'ticket.update',
};

export function resourceForAction(action: string): ActionResource | null {
  return (ACTION_RESOURCE as Record<string, ActionResource>)[action] ?? null;
}

/** Account provider each action runs on (`accounts.provider`). Anything else is refused. */
export const ACTION_PROVIDER: Record<ProposalAction, string> = {
  'gmail.send': 'gmail',
  'gmail.label': 'gmail',
  'outlook.send': 'microsoft',
  'slack.post': 'slack',
  'jira.transition': 'atlassian',
  'jira.comment': 'atlassian',
};

/** Payload schemas the executor re-validates against right before executing. */
export const PAYLOAD_SCHEMAS: Record<
  string,
  z.ZodType<Record<string, unknown>>
> = PROPOSAL_PAYLOADS;

/** Secret kinds of an account's tokens (the API stores them this way at consent). */
export const readTokenKind = (provider: string) => `oauth:${provider}`;
export const writeTokenKind = (provider: string) => `oauth:${provider}:write`;

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

const NETWORK_CODE =
  /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|EPIPE|UND_ERR|TimeoutError|AbortError)/;

/**
 * True if the request may have reached the provider and been acted on although we got an
 * error: network errors and timeouts (no response), and 5xx other than 503. A 429, a 503
 * or any 4xx is a definite "not done".
 */
export function isAmbiguousError(err: unknown): boolean {
  if (err instanceof ReconnectRequiredError) return false;
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown };
  if (typeof e.status === 'number') return e.status >= 500 && e.status !== 503;
  if (err instanceof RetryableError) return true; // no status: network error or timeout
  if (typeof e.code === 'string' && NETWORK_CODE.test(e.code)) return true;
  return e.name === 'TimeoutError' || e.name === 'AbortError';
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof ReconnectRequiredError) return false;
  if (err instanceof RetryableError) return true;
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; code?: unknown; retryable?: unknown };
    if (e.retryable === true) return true;
    if (typeof e.status === 'number') return e.status === 429 || e.status >= 500;
    if (typeof e.code === 'string' && NETWORK_CODE.test(e.code)) {
      return true;
    }
  }
  return false;
}

/**
 * Error text stored on the proposal and in the audit log. Connector errors are written to
 * be safe (no tokens or content); anything else (e.g. a DB error, whose message holds the
 * SQL params) is reduced to its class name and code.
 */
const safeMessage = (err: unknown) => {
  if (err instanceof ConnectorError) return `${err.name}: ${err.message}`.slice(0, 300);
  const info = errorInfo(err);
  return (info.code ? `${info.err} (${info.code})` : info.err).slice(0, 300);
};

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

/**
 * Did an earlier attempt possibly send? True if the latest send marker for this proposal is
 * `executor.sending` (a send was started and never confirmed either way).
 */
async function sendMayHaveHappened(db: Db, userId: string, target: string): Promise<boolean> {
  const [last] = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, userId),
        eq(auditLog.target, target),
        inArray(auditLog.action, ['executor.sending', 'executor.retry']),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(1);
  return last?.action === 'executor.sending';
}

type Step =
  | { kind: 'done'; outcome: ExecOutcome }
  | { kind: 'sent'; result: ExecuteResult; reconciled: boolean };

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
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = deps.reconcileDelaysMs ?? RECONCILE_DELAYS_MS;

  const publish = () => deps.publishLive(userId, { type: 'proposal.updated', proposalId });
  const fail = async (
    reason: string,
    kind: 'executor.failed' | 'executor.denied',
    extra: Record<string, unknown> = {},
  ): Promise<ExecOutcome> => {
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
      details: { reason: reason.slice(0, 300), ...extra },
    });
    await publish();
    return kind === 'executor.denied' ? { status: 'denied', reason } : { status: 'failed', reason };
  };
  const needsReview = (why: string) =>
    fail(NEEDS_REVIEW, 'executor.failed', { needsReview: true, why });

  let resumed: boolean;
  // Only for a job that finds the proposal `executing`: a user re-approval is a human
  // decision to try again (after a lookup), not an automatic re-send.
  let ambiguousPrior = false;
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
    ambiguousPrior = await sendMayHaveHappened(db, userId, target);
  } else {
    return { status: 'skipped', reason: `status is ${proposal.status}` };
  }
  await audit(db, {
    userId,
    principal: EXECUTOR,
    action: 'executor.start',
    target,
    details: { action: proposal.action, accountId: account.id, resumed, ambiguousPrior },
  });
  await publish();

  const attempt = async (): Promise<Step> => {
    let sendAttempted = false;
    let lookup: ((waits: readonly number[]) => Promise<ExecuteResult | null>) | null = null;
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
        return {
          kind: 'done',
          outcome: await fail(`unknown principal ${proposal.agent}`, 'executor.denied'),
        };
      }
      if (!decision.allow) {
        return {
          kind: 'done',
          outcome: await fail(`policy denied: ${decision.reason}`, 'executor.denied'),
        };
      }
      // needsApproval is satisfied: only approved proposals reach this point.
      const provider = (ACTION_PROVIDER as Record<string, string>)[proposal.action];
      if (provider !== account.provider) {
        throw new PermanentFailure(`${proposal.action} needs a ${provider ?? 'matching'} account`);
      }

      // 2. Payload, re-validated. Recipients and targets come only from here.
      const schema = PAYLOAD_SCHEMAS[proposal.action];
      if (!schema) throw new PermanentFailure(`no payload schema for ${proposal.action}`);
      const parsed = schema.safeParse(proposal.payload);
      if (!parsed.success) throw new PermanentFailure('payload failed validation');
      const payload = parsed.data;

      // 3. Write-scope token (separate consent). Decrypted only here.
      if (!account.writeTokenRef) throw new PermanentFailure('write access not granted');
      const writeTokenRef = account.writeTokenRef;
      let connector: Connector;
      try {
        connector = deps.getConnector(account.provider);
      } catch {
        throw new PermanentFailure(`no connector for ${account.provider}`);
      }
      if (!connector.execute)
        throw new PermanentFailure(`${account.provider} cannot execute ${proposal.action}`);
      const execute = connector.execute.bind(connector);

      // Tokens are opened with the kind they must have, so a read token (or another
      // provider's token) swapped into writeTokenRef is refused rather than used.
      const makeCtx = async (ref: string, kind: string): Promise<ConnectorContext> => ({
        accountId: account.id,
        externalId: account.externalId,
        tokens: parseTokens(await deps.secrets.get(ref, { userId, kind })),
        saveTokens: (tokens) => deps.secrets.replace(ref, JSON.stringify(tokens)),
        // Writes don't sync, so no cursor. Meta carries provider identity (e.g. Atlassian site).
        cursor: null,
        filters: AccountFilters.parse(account.filters ?? {}),
        meta: (account.meta ?? {}) as Record<string, unknown>,
      });

      if (connector.findExecuted) {
        const find = connector.findExecuted.bind(connector);
        // Gmail's send scope cannot search the mailbox, so the lookup uses the read token.
        const lookupRef = account.tokenRef ?? writeTokenRef;
        const lookupKind = account.tokenRef
          ? readTokenKind(account.provider)
          : writeTokenKind(account.provider);
        let lookupCtx: ConnectorContext | undefined;
        /**
         * Looks for an earlier send, once plus once after each wait. With waits, a lookup
         * error counts as a miss (we are already on the ambiguous path); without, it throws.
         */
        lookup = async (waits) => {
          for (let i = 0; i <= waits.length; i++) {
            if (i > 0) await sleep(waits[i - 1]!);
            try {
              lookupCtx ??= await makeCtx(lookupRef, lookupKind);
              const found = await find(
                lookupCtx,
                proposal.action,
                proposal.idempotencyKey,
                proposal.payload as Record<string, unknown>,
              );
              if (found) return found;
            } catch (err) {
              if (waits.length === 0) throw err;
              deps.log?.warn({ proposalId, ...errorInfo(err) }, 'executor lookup failed');
            }
          }
          return null;
        };
      }

      // 4. Crash-safe retry: did an earlier attempt already send?
      if (resumed) {
        if (!lookup) {
          throw new PermanentFailure(
            'an earlier attempt may have sent this; not retrying to avoid a duplicate',
          );
        }
        const found = await lookup(ambiguousPrior ? delays : []);
        if (found) return { kind: 'sent', result: found, reconciled: true };
        if (ambiguousPrior) {
          return { kind: 'done', outcome: await needsReview('earlier send not found') };
        }
      }

      // 5. Send. The marker is durable before the request, so a crash from here on is
      //    treated as "may have sent" by the next attempt.
      await audit(db, { userId, principal: EXECUTOR, action: 'executor.sending', target });
      sendAttempted = true;
      const result = await execute(
        await makeCtx(writeTokenRef, writeTokenKind(account.provider)),
        proposal.action,
        payload,
        proposal.idempotencyKey,
      );
      return { kind: 'sent', result, reconciled: false };
    } catch (err) {
      if (err instanceof PermanentFailure) {
        return { kind: 'done', outcome: await fail(err.message, 'executor.failed') };
      }
      if (err instanceof ReconnectRequiredError) {
        return { kind: 'done', outcome: await fail('reconnect required', 'executor.failed') };
      }
      if (sendAttempted && isAmbiguousError(err)) {
        // The request may have gone through. Never re-send on one missed lookup: the
        // provider may not have indexed the message yet.
        deps.log?.warn({ proposalId, ...errorInfo(err) }, 'executor send outcome unknown');
        const found = lookup ? await lookup(delays) : null;
        if (found) return { kind: 'sent', result: found, reconciled: true };
        return { kind: 'done', outcome: await needsReview(safeMessage(err)) };
      }
      if (isRetryableError(err)) {
        // Known not sent (rejected before or instead of being processed).
        if (opts.finalAttempt) {
          return {
            kind: 'done',
            outcome: await fail(
              `gave up after retries (${safeMessage(err)}); it was not sent`,
              'executor.failed',
            ),
          };
        }
        await audit(db, {
          userId,
          principal: EXECUTOR,
          action: 'executor.retry',
          target,
          details: { sent: false, error: safeMessage(err) },
        });
        deps.log?.warn({ proposalId, ...errorInfo(err) }, 'executor retrying');
        // Status stays `executing`; the retry reconciles with findExecuted before re-sending.
        throw err;
      }
      return { kind: 'done', outcome: await fail(safeMessage(err), 'executor.failed') };
    }
  };

  const step = await attempt();
  if (step.kind === 'done') return step.outcome;
  // Outside attempt(): if this bookkeeping fails, the job retries, finds `executing` with
  // the send marker, and reconciles instead of re-sending.
  return markExecuted(deps, proposalId, userId, step.result, step.reconciled);
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
