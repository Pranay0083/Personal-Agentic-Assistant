import { createHash } from 'node:crypto';
import { MissingScopeError, ReconnectRequiredError } from '@hub/connectors';
import { audit } from '@hub/db';
import { worker } from '@hub/server';
import { BackfillJob, QUEUES } from '@hub/shared/queues';
import { ensureSubscription, markReconnect, setStatus, sourceRow } from '../lib/accounts';
import { connectorContext, loadAccount, sourcesOf } from '../lib/context';
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
  | {
      status: 'page';
      source: string;
      inserted: number;
      skipped: number;
      nextPageToken: string | null;
    };

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);

export const nextPageJobId = (accountId: string, days: number, source: string, pageToken: string) =>
  `backfill-${accountId}-${days}-${source}-${hash(pageToken)}`;

/**
 * One backfill page of one source. A job without `source` fans out: it backfills the
 * account's enabled sources one after another (`source` now, `then` afterwards). The first
 * page of each source marks the account `importing` and makes sure that source is
 * subscribed (so changes arriving during the import are caught by sync); each page
 * re-enqueues the next with its pageToken; the last page of the last source flips the
 * account to `live`.
 */
export async function runBackfill(deps: WorkerDeps, job: BackfillJob): Promise<BackfillOutcome> {
  const account = await loadAccount(deps.db, job.accountId);
  if (!account) return { status: 'skipped', reason: 'account not found' };
  if (SKIP.has(account.status)) return { status: 'skipped', reason: `status ${account.status}` };
  const connector = deps.getConnector(account.provider);
  const enabled = sourcesOf(connector, account);

  // Resolve which source this job is for, skipping sources disabled since it was enqueued.
  let queue = job.source ? [job.source, ...(job.then ?? [])] : enabled;
  queue = queue.filter((s) => enabled.includes(s));
  const source = queue[0];
  const rest = queue.slice(1);
  if (!source) {
    if (account.status === 'importing' || account.status === 'connecting') {
      await setStatus(deps, account, 'live', { lastSyncedAt: deps.now() });
    }
    return { status: 'skipped', reason: 'no enabled sources' };
  }
  const pageToken = source === job.source ? job.pageToken : undefined;

  try {
    const row = await sourceRow(deps, account, source);
    const ctx = await connectorContext(deps, account, { row });
    if (!pageToken) await setStatus(deps, account, 'importing');
    let page;
    try {
      if (!pageToken) await ensureSubscription(deps, connector, ctx, row);
      page = await connector.backfill(ctx, {
        days: job.days,
        ...(pageToken ? { pageToken } : {}),
      });
    } catch (e) {
      if (!(e instanceof MissingScopeError)) throw e;
      // Not granted for this source: move on to the next one instead of failing the import.
      deps.log.warn({ accountId: account.id, source }, 'source not granted, backfill skipped');
      page = { records: [], nextPageToken: null };
    }
    const counts = await ingestRecords(deps, account, connector, page.records, {
      triagePriority: BACKFILL_TRIAGE_PRIORITY,
      source,
    });
    if (page.nextPageToken) {
      await deps.enqueue(
        QUEUES.backfill,
        {
          accountId: account.id,
          days: job.days,
          source,
          ...(rest.length ? { then: rest } : {}),
          pageToken: page.nextPageToken,
        } satisfies BackfillJob,
        { jobId: nextPageJobId(account.id, job.days, source, page.nextPageToken) },
      );
    } else if (rest.length) {
      const [next, ...after] = rest as [string, ...string[]];
      // Deterministic per finishing page, so a retry of this job doesn't start the next twice.
      const minute = Math.floor(deps.now().getTime() / 60_000);
      await deps.enqueue(
        QUEUES.backfill,
        {
          accountId: account.id,
          days: job.days,
          source: next,
          ...(after.length ? { then: after } : {}),
        } satisfies BackfillJob,
        {
          jobId: `backfill-${account.id}-${job.days}-${next}-${hash(`${source}|${pageToken ?? ''}|${minute}`)}`,
        },
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
        source,
        firstPage: !pageToken,
        lastPage: !page.nextPageToken,
        fetched: counts.fetched,
        inserted: counts.inserted,
        updated: counts.updated,
        changed: counts.changed,
        skipped: counts.skipped,
      },
    });
    return {
      status: 'page',
      source,
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
