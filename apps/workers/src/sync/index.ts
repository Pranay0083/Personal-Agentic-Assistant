import { and, eq, lte } from 'drizzle-orm';
import { ReconnectRequiredError } from '@hub/connectors';
import { accounts, audit, events } from '@hub/db';
import { worker } from '@hub/server';
import { BackfillDays } from '@hub/shared';
import { QUEUES, SyncJob } from '@hub/shared/queues';
import { ensureSubscription, markReconnect } from '../lib/accounts';
import { connectorContext, loadAccount, type AccountRow } from '../lib/context';
import { defaultDeps, errInfo, type WorkerDeps } from '../lib/deps';
import { ingestRecords, type IngestCounts } from '../lib/ingest';
import type { Closable } from '../types';

const PRINCIPAL = 'system:sync';
/** Statuses where sync runs. `paused`/`disconnected` accounts are left alone. */
const SYNCABLE = new Set(['connecting', 'importing', 'live', 'reconnect']);
/** A successful sync moves these to `live`; `importing` stays until backfill finishes. */
const TO_LIVE = new Set(['connecting', 'live', 'reconnect']);
/** Safety valve: how many back-to-back runs one job may do while webhooks keep arriving. */
const MAX_LOOPS = 10;

export type SyncOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'deferred' }
  | { status: 'reconnect' }
  | { status: 'resync'; days: number }
  | ({ status: 'ok'; runs: number } & Omit<IngestCounts, 'newItemIds'>);

export const lockKey = (accountId: string) => `sync:${accountId}`;

export function backfillDaysOf(account: Pick<AccountRow, 'backfillDays'>): 7 | 30 | 90 {
  const p = BackfillDays.safeParse(account.backfillDays);
  return p.success ? p.data : 30;
}

/**
 * One sync job. Runs are serialized per account with a lock; a job that finds the lock
 * held marks the account dirty, and the holder runs again before releasing, so no
 * webhook is lost and no two runs race on the cursor.
 */
export async function runSync(deps: WorkerDeps, job: SyncJob): Promise<SyncOutcome> {
  const first = await loadAccount(deps.db, job.accountId);
  if (!first) return { status: 'skipped', reason: 'account not found' };
  if (!SYNCABLE.has(first.status)) return { status: 'skipped', reason: `status ${first.status}` };

  const key = lockKey(job.accountId);
  let release = await deps.lock.tryAcquire(key);
  if (!release) {
    await deps.lock.markDirty(key);
    // Double-check: the holder may have released between our attempt and the flag.
    release = await deps.lock.tryAcquire(key);
    if (!release) return { status: 'deferred' };
  }

  let outcome: SyncOutcome = { status: 'skipped', reason: 'no run' };
  const total = { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  let runs = 0;
  try {
    // Anything flagged before we got the lock is covered by the run we are about to do.
    await deps.lock.takeDirty(key);
    let again = true;
    while (again) {
      const account = await loadAccount(deps.db, job.accountId);
      if (!account || !SYNCABLE.has(account.status)) break;
      const r = await syncOnce(deps, account, job);
      runs++;
      if (r.status !== 'ok') {
        outcome = r;
        break;
      }
      total.fetched += r.fetched;
      total.inserted += r.inserted;
      total.updated += r.updated;
      total.skipped += r.skipped;
      outcome = { status: 'ok', runs, ...total };
      again = await deps.lock.takeDirty(key);
      if (again && runs >= MAX_LOOPS) {
        // Hand the rest to a fresh job (re-enqueued below) instead of hogging the worker.
        await deps.lock.markDirty(key);
        again = false;
      }
    }
  } finally {
    await release();
  }
  // A webhook may have flagged the account between our last check and the release.
  if (outcome.status === 'ok' && (await deps.lock.takeDirty(key))) {
    await deps.enqueue(QUEUES.sync, {
      accountId: job.accountId,
      reason: job.reason,
    } satisfies SyncJob);
  }
  return outcome;
}

async function syncOnce(
  deps: WorkerDeps,
  account: AccountRow,
  job: SyncJob,
): Promise<SyncOutcome & { status: 'ok' | 'reconnect' | 'resync' | 'skipped' }> {
  const started = deps.now();
  const connector = deps.getConnector(account.provider);
  try {
    const ctx = await connectorContext(deps, account);
    await ensureSubscription(deps, account, connector, ctx);
    const delta = await connector.fetchDelta(ctx);

    if (delta.fullResyncRequired) {
      const days = backfillDaysOf(account);
      await deps.db
        .update(accounts)
        .set({ syncCursor: delta.cursor, status: 'importing' })
        .where(eq(accounts.id, account.id));
      await deps.enqueue(
        QUEUES.backfill,
        { accountId: account.id, days },
        { jobId: `resync-${account.id}-${delta.cursor ?? started.getTime()}` },
      );
      await deps.publishLive(account.userId, { type: 'account.updated', accountId: account.id });
      await audit(deps.db, {
        userId: account.userId,
        principal: PRINCIPAL,
        action: 'sync.run',
        target: `account:${account.id}`,
        details: { reason: job.reason, eventId: job.eventId ?? null, outcome: 'full_resync', days },
      });
      return { status: 'resync', days };
    }

    const counts = await ingestRecords(deps, account, connector, delta.records);
    const status = TO_LIVE.has(account.status) ? 'live' : account.status;
    await deps.db
      .update(accounts)
      .set({ syncCursor: delta.cursor ?? account.syncCursor, lastSyncedAt: deps.now(), status })
      .where(eq(accounts.id, account.id));
    if (status !== account.status) {
      await deps.publishLive(account.userId, { type: 'account.updated', accountId: account.id });
    }
    // Every event received before this run started is covered by it.
    await deps.db
      .update(events)
      .set({ status: 'processed' })
      .where(
        and(
          eq(events.accountId, account.id),
          eq(events.status, 'received'),
          lte(events.createdAt, started),
        ),
      );
    if (job.eventId) {
      await deps.db.update(events).set({ status: 'processed' }).where(eq(events.id, job.eventId));
    }
    await audit(deps.db, {
      userId: account.userId,
      principal: PRINCIPAL,
      action: 'sync.run',
      target: `account:${account.id}`,
      details: {
        reason: job.reason,
        eventId: job.eventId ?? null,
        outcome: 'ok',
        fetched: counts.fetched,
        inserted: counts.inserted,
        updated: counts.updated,
        skipped: counts.skipped,
      },
    });
    const { newItemIds: _ids, ...rest } = counts;
    return { status: 'ok', runs: 1, ...rest };
  } catch (e) {
    if (e instanceof ReconnectRequiredError) {
      await markReconnect(deps, account, PRINCIPAL);
      return { status: 'reconnect' };
    }
    // RetryableError and anything unexpected: let BullMQ back off and retry.
    throw e;
  }
}

/** Starts the sync worker. */
export function start(): Closable[] {
  const deps = defaultDeps('sync');
  const w = worker<SyncJob>(QUEUES.sync, async (job) => runSync(deps, SyncJob.parse(job.data)), 5);
  w.on('failed', (job, err) =>
    deps.log.warn(
      { jobId: job?.id, accountId: job?.data?.accountId, ...errInfo(err) },
      'sync job failed',
    ),
  );
  return [w];
}
