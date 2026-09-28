import { createHash } from 'node:crypto';
import { ReconnectRequiredError } from '@hub/connectors';
import { audit } from '@hub/db';
import { worker } from '@hub/server';
import { BackfillJob, QUEUES } from '@hub/shared/queues';
import { ensureSubscription, markReconnect, setStatus } from '../lib/accounts';
import { connectorContext, loadAccount } from '../lib/context';
import { defaultDeps, errInfo, type WorkerDeps } from '../lib/deps';
import { ingestRecords } from '../lib/ingest';
import type { Closable } from '../types';

const PRINCIPAL = 'system:backfill';
/** Backfilled mail is triaged after live mail (BullMQ: higher number = lower priority). */
export const BACKFILL_TRIAGE_PRIORITY = 10;
const SKIP = new Set(['paused', 'disconnected']);

export type BackfillOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'reconnect' }
  | { status: 'page'; inserted: number; skipped: number; nextPageToken: string | null };

export const nextPageJobId = (accountId: string, days: number, pageToken: string) =>
  `backfill-${accountId}-${days}-${createHash('sha256').update(pageToken).digest('hex').slice(0, 20)}`;

/**
 * One backfill page. The first page marks the account `importing` and makes sure the
 * watch exists (so mail arriving during the import is caught by sync); each page
 * re-enqueues the next with its pageToken; the last page flips the account to `live`.
 */
export async function runBackfill(deps: WorkerDeps, job: BackfillJob): Promise<BackfillOutcome> {
  const account = await loadAccount(deps.db, job.accountId);
  if (!account) return { status: 'skipped', reason: 'account not found' };
  if (SKIP.has(account.status)) return { status: 'skipped', reason: `status ${account.status}` };
  const connector = deps.getConnector(account.provider);
  try {
    const ctx = await connectorContext(deps, account);
    if (!job.pageToken) {
      await setStatus(deps, account, 'importing');
      await ensureSubscription(deps, account, connector, ctx);
    }
    const page = await connector.backfill(ctx, {
      days: job.days,
      ...(job.pageToken ? { pageToken: job.pageToken } : {}),
    });
    const counts = await ingestRecords(deps, account, connector, page.records, {
      triagePriority: BACKFILL_TRIAGE_PRIORITY,
    });
    if (page.nextPageToken) {
      await deps.enqueue(
        QUEUES.backfill,
        {
          accountId: account.id,
          days: job.days,
          pageToken: page.nextPageToken,
        } satisfies BackfillJob,
        { jobId: nextPageJobId(account.id, job.days, page.nextPageToken) },
      );
    } else {
      await setStatus(deps, account, 'live', { lastSyncedAt: deps.now() });
    }
    await audit(deps.db, {
      userId: account.userId,
      principal: PRINCIPAL,
      action: 'backfill.page',
      target: `account:${account.id}`,
      details: {
        days: job.days,
        firstPage: !job.pageToken,
        lastPage: !page.nextPageToken,
        fetched: counts.fetched,
        inserted: counts.inserted,
        updated: counts.updated,
        skipped: counts.skipped,
      },
    });
    return {
      status: 'page',
      inserted: counts.inserted,
      skipped: counts.skipped,
      nextPageToken: page.nextPageToken,
    };
  } catch (e) {
    if (e instanceof ReconnectRequiredError) {
      await markReconnect(deps, account, PRINCIPAL);
      return { status: 'reconnect' };
    }
    throw e;
  }
}

/** Starts the backfill worker. */
export function start(): Closable[] {
  const deps = defaultDeps('backfill');
  const w = worker<BackfillJob>(
    QUEUES.backfill,
    async (job) => runBackfill(deps, BackfillJob.parse(job.data)),
    2,
  );
  w.on('failed', (job, err) =>
    deps.log.warn(
      { jobId: job?.id, accountId: job?.data?.accountId, ...errInfo(err) },
      'backfill job failed',
    ),
  );
  return [w];
}
