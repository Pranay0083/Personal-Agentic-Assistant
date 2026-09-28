import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { MissingScopeError, ReconnectRequiredError, type Connector } from '@hub/connectors';
import { accounts, audit, events, subscriptions } from '@hub/db';
import { worker } from '@hub/server';
import { BackfillDays } from '@hub/shared';
import { QUEUES, SyncJob, type BackfillJob } from '@hub/shared/queues';
import {
  disableRemovedSources,
  ensureSubscription,
  markReconnect,
  sourceRow,
} from '../lib/accounts';
import {
  accountMeta,
  connectorContext,
  loadAccount,
  saveCursor,
  sourcesOf,
  type AccountRow,
} from '../lib/context';
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
/** fetchDelta pages per source per run while the provider reports `hasMore`. */
export const MAX_DELTA_PAGES = 20;

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
 * One sync job, for `job.source` or every enabled source of the account. Runs are
 * serialized per account with a lock; a job that finds the lock
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
  const total = { fetched: 0, inserted: 0, updated: 0, changed: 0, skipped: 0 };
  let runs = 0;
  try {
    // Anything flagged before we got the lock is covered by the run we are about to do; if
    // something was flagged, that run covers every source (the flag may be for another one).
    const flagged = await deps.lock.takeDirty(key);
    let only = flagged ? undefined : job.source;
    let again = true;
    while (again) {
      const account = await loadAccount(deps.db, job.accountId);
      if (!account || !SYNCABLE.has(account.status)) break;
      const r = await syncOnce(deps, account, job, only);
      // Later runs (a webhook arrived meanwhile, maybe for another source) cover every source.
      only = undefined;
      runs++;
      if (r.status !== 'ok') {
        outcome = r;
        break;
      }
      total.fetched += r.fetched;
      total.inserted += r.inserted;
      total.updated += r.updated;
      total.changed += r.changed;
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

type SourceCounts = Omit<IngestCounts, 'newItemIds'>;

/**
 * Unprocessed events of the account that ask for more than a delta: `payload.reconnect`
 * (the grant was revoked) and `payload.refreshRouteKeys` (identity data such as GitHub
 * installations changed). Read from the events table, so a deferred job's event counts too.
 */
async function flaggedEvents(deps: WorkerDeps, accountId: string, before: Date) {
  const rows = await deps.db
    .select({
      id: events.id,
      reconnect: sql<boolean>`coalesce((${events.payload}->>'reconnect')::boolean, false)`,
      refresh: sql<boolean>`coalesce((${events.payload}->>'refreshRouteKeys')::boolean, false)`,
      // Graph: renew/resubscribe. Google Workspace Events: lifecycle reminder/suspended/expired.
      renew: sql<boolean>`(coalesce((${events.payload}->>'renew')::boolean, false) OR coalesce((${events.payload}->>'resubscribe')::boolean, false) OR (${events.payload}->>'lifecycle') IS NOT NULL)`,
    })
    .from(events)
    .where(
      and(
        eq(events.accountId, accountId),
        eq(events.status, 'received'),
        lte(events.createdAt, before),
        or(
          sql`${events.payload}->>'reconnect' = 'true'`,
          sql`${events.payload}->>'refreshRouteKeys' = 'true'`,
          sql`${events.payload}->>'renew' = 'true'`,
          sql`${events.payload}->>'resubscribe' = 'true'`,
          sql`${events.payload}->>'lifecycle' IS NOT NULL`,
        ),
      ),
    );
  return {
    reconnect: rows.filter((r) => r.reconnect).map((r) => r.id),
    refresh: rows.filter((r) => r.refresh).map((r) => r.id),
    renew: rows.filter((r) => r.renew).map((r) => r.id),
  };
}

async function markEvents(deps: WorkerDeps, ids: string[]) {
  if (ids.length === 0) return;
  await deps.db.update(events).set({ status: 'processed' }).where(inArray(events.id, ids));
}

/** Re-reads identity data (route keys, meta) through the connector and stores it. */
async function refreshIdentity(deps: WorkerDeps, account: AccountRow, connector: Connector) {
  const ctx = await connectorContext(deps, account);
  const r = await connector.refreshIdentity!(ctx);
  const set: Partial<Pick<AccountRow, 'routeKeys' | 'meta'>> = {};
  if (r.routeKeys) set.routeKeys = [...new Set(r.routeKeys)];
  if (r.meta) set.meta = { ...accountMeta(account), ...r.meta };
  if (Object.keys(set).length === 0) return;
  await deps.db.update(accounts).set(set).where(eq(accounts.id, account.id));
  Object.assign(account, set);
  await audit(deps.db, {
    userId: account.userId,
    principal: PRINCIPAL,
    action: 'account.identity_refreshed',
    target: `account:${account.id}`,
    details: { routeKeys: set.routeKeys?.length ?? null, metaKeys: Object.keys(r.meta ?? {}) },
  });
  await deps.publishLive(account.userId, { type: 'account.updated', accountId: account.id });
}
type SourceResult =
  ({ status: 'ok'; more: boolean } & SourceCounts) | { status: 'resync'; cursor: string | null };

/**
 * One source: make sure it is subscribed, pull deltas while the provider says there is
 * more (bounded), ingest, and save the cursor after every page.
 */
async function syncSource(
  deps: WorkerDeps,
  account: AccountRow,
  connector: Connector,
  source: string,
): Promise<SourceResult> {
  const row = await sourceRow(deps, account, source);
  const ctx = await connectorContext(deps, account, { row });
  await ensureSubscription(deps, connector, ctx, row);
  const counts: SourceCounts = { fetched: 0, inserted: 0, updated: 0, changed: 0, skipped: 0 };
  let more = false;
  for (let page = 0; page < MAX_DELTA_PAGES; page++) {
    const delta = await connector.fetchDelta(ctx);
    if (delta.fullResyncRequired) {
      // Restart from the provider's "now" (or from scratch if it gave none); backfill covers the gap.
      await deps.db
        .update(subscriptions)
        .set({ cursor: delta.cursor, updatedAt: deps.now() })
        .where(eq(subscriptions.id, row.id));
      return { status: 'resync', cursor: delta.cursor };
    }
    const c = await ingestRecords(deps, account, connector, delta.records, { source });
    counts.fetched += c.fetched;
    counts.inserted += c.inserted;
    counts.updated += c.updated;
    counts.changed += c.changed;
    counts.skipped += c.skipped;
    const before = row.cursor;
    await saveCursor(deps.db, row, delta.cursor, deps.now());
    ctx.cursor = row.cursor;
    // A provider that says hasMore without moving the cursor would loop forever.
    more = !!delta.hasMore && row.cursor !== before;
    if (!more) break;
  }
  return { status: 'ok', more, ...counts };
}

async function syncOnce(
  deps: WorkerDeps,
  account: AccountRow,
  job: SyncJob,
  onlySource: string | undefined,
): Promise<SyncOutcome & { status: 'ok' | 'reconnect' | 'resync' | 'skipped' }> {
  const started = deps.now();
  const connector = deps.getConnector(account.provider);
  try {
    const flags = await flaggedEvents(deps, account.id, started);
    if (flags.reconnect.length > 0) {
      // The provider told us the grant is gone (Slack tokens_revoked / app_uninstalled).
      await markEvents(deps, flags.reconnect);
      throw new ReconnectRequiredError(account.provider, 'provider reported revoked access');
    }
    if (flags.refresh.length > 0 && connector.refreshIdentity) {
      await refreshIdentity(deps, account, connector);
      await markEvents(deps, flags.refresh);
    }
    if (flags.renew.length > 0) {
      // Graph lifecycle notifications (reauthorizationRequired / subscriptionRemoved): renew
      // every push subscription of the account now instead of waiting for the daily run.
      await renewPushSubscriptions(deps, account, connector);
      await markEvents(deps, flags.renew);
    }
    await disableRemovedSources(deps, connector, account, (row) =>
      connectorContext(deps, account, { row }),
    );
    const enabled = sourcesOf(connector, account);
    const targets = onlySource ? enabled.filter((s) => s === onlySource) : enabled;

    const total: SourceCounts = { fetched: 0, inserted: 0, updated: 0, changed: 0, skipped: 0 };
    const perSource: Record<string, SourceCounts> = {};
    const resynced: { source: string; cursor: string | null }[] = [];
    let failure: unknown = null;
    let more = false;
    for (const source of targets) {
      let r: SourceResult;
      try {
        r = await syncSource(deps, account, connector, source);
      } catch (e) {
        if (e instanceof ReconnectRequiredError) throw e;
        if (e instanceof MissingScopeError) {
          // The consent doesn't cover this source (e.g. connected before it existed). Retrying
          // can't help; the user has to reconnect or turn the source off.
          deps.log.warn({ accountId: account.id, source }, 'source not granted, skipped');
          continue;
        }
        // One failing source must not hold back the others; the job is retried below.
        failure ??= e;
        deps.log.warn({ accountId: account.id, source, ...errInfo(e) }, 'source sync failed');
        continue;
      }
      if (r.status === 'resync') {
        resynced.push({ source, cursor: r.cursor });
        continue;
      }
      const { status: _s, more: m, ...counts } = r;
      more ||= m;
      perSource[source] = counts;
      total.fetched += counts.fetched;
      total.inserted += counts.inserted;
      total.updated += counts.updated;
      total.changed += counts.changed;
      total.skipped += counts.skipped;
    }
    if (more) await deps.lock.markDirty(lockKey(account.id));

    if (resynced.length > 0) {
      const days = backfillDaysOf(account);
      await deps.db
        .update(accounts)
        .set({ status: 'importing' })
        .where(eq(accounts.id, account.id));
      for (const { source, cursor } of resynced) {
        await deps.enqueue(
          QUEUES.backfill,
          { accountId: account.id, days, source } satisfies BackfillJob,
          { jobId: `resync-${account.id}-${source}-${cursor ?? started.getTime()}` },
        );
        await audit(deps.db, {
          userId: account.userId,
          principal: PRINCIPAL,
          action: 'sync.run',
          target: `account:${account.id}`,
          details: {
            reason: job.reason,
            eventId: job.eventId ?? null,
            source,
            outcome: 'full_resync',
            days,
          },
        });
      }
      await deps.publishLive(account.userId, { type: 'account.updated', accountId: account.id });
      if (failure) throw failure;
      return { status: 'resync', days };
    }
    if (failure) throw failure;

    const status = TO_LIVE.has(account.status) ? 'live' : account.status;
    await deps.db
      .update(accounts)
      .set({ lastSyncedAt: deps.now(), status })
      .where(eq(accounts.id, account.id));
    if (status !== account.status) {
      await deps.publishLive(account.userId, { type: 'account.updated', accountId: account.id });
    }
    if (!onlySource) {
      // Every event received before this all-sources run started is covered by it.
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
    }
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
        ...total,
        sources: perSource,
      },
    });
    return { status: 'ok', runs: 1, ...total };
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

/** Renews (or recreates) the push subscription of each enabled source that has one. */
async function renewPushSubscriptions(
  deps: WorkerDeps,
  account: AccountRow,
  connector: Connector,
): Promise<void> {
  for (const source of sourcesOf(connector, account)) {
    const row = await sourceRow(deps, account, source);
    if (!row.externalSubId) continue; // polled source, nothing to renew
    const ctx = await connectorContext(deps, account, { row });
    await ensureSubscription(deps, connector, ctx, row, { force: true });
  }
}
