import { and, eq, inArray, isNotNull, lte, lt } from 'drizzle-orm';
import { ReconnectRequiredError } from '@hub/connectors';
import {
  accessRequests,
  accounts,
  audit,
  briefs,
  itemBodies,
  items,
  subscriptions,
  users,
} from '@hub/db';
import { queue, worker } from '@hub/server';
import { UserSettings } from '@hub/shared';
import { QUEUES, SchedulerJob, type SyncJob } from '@hub/shared/queues';
import { ensureSubscription, markReconnect, watchKind } from '../lib/accounts';
import { connectorContext } from '../lib/context';
import { defaultDeps, errInfo, type WorkerDeps } from '../lib/deps';
import type { Closable } from '../types';

const PRINCIPAL = 'system:scheduler';
const HOUR = 3600_000;
const RENEW_WITHIN_MS = 48 * HOUR;
const CATCHUP_EVERY_MS = 15 * 60_000;
/** A brief is due from briefTime until this long after (tolerates a missed tick or two). */
const BRIEF_WINDOW_MIN = 60;
const REQUEST_TTL_MS = 24 * HOUR;

/** BullMQ job schedulers on QUEUES.scheduler. */
export const SCHEDULES: {
  id: SchedulerJob['task'];
  repeat: { pattern?: string; every?: number };
}[] = [
  { id: 'renew-subscriptions', repeat: { pattern: '17 4 * * *' } },
  { id: 'catchup-sync', repeat: { every: CATCHUP_EVERY_MS } },
  { id: 'daily-briefs', repeat: { pattern: '*/15 * * * *' } },
  { id: 'expire-grants', repeat: { pattern: '5 * * * *' } },
  { id: 'purge-expired-bodies', repeat: { pattern: '43 3 * * *' } },
];

/** Rows deleted per batch, and batches per run (the next daily run picks up the rest). */
export const PURGE_BATCH = 500;
export const PURGE_MAX_BATCHES = 200;

/** Renews watches expiring within 48h and subscribes live accounts that have none. */
export async function renewSubscriptions(deps: WorkerDeps) {
  const now = deps.now();
  const rows = await deps.db
    .select()
    .from(accounts)
    .where(inArray(accounts.status, ['live', 'importing']));
  const subs = rows.length
    ? await deps.db
        .select()
        .from(subscriptions)
        .where(
          inArray(
            subscriptions.accountId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  const out = { renewed: 0, subscribed: 0, reconnect: 0, failed: 0, unchanged: 0 };
  for (const account of rows) {
    let connector;
    try {
      connector = deps.getConnector(account.provider);
    } catch {
      continue; // provider not implemented yet
    }
    const sub = subs.find(
      (s) => s.accountId === account.id && s.kind === watchKind(account.provider),
    );
    const due = !sub || !sub.expiresAt || sub.expiresAt.getTime() - now.getTime() < RENEW_WITHIN_MS;
    if (!due) {
      out.unchanged++;
      continue;
    }
    try {
      const ctx = await connectorContext(deps, account);
      await ensureSubscription(deps, account, connector, ctx, { force: true });
      if (sub) out.renewed++;
      else out.subscribed++;
      await audit(deps.db, {
        userId: account.userId,
        principal: PRINCIPAL,
        action: sub ? 'subscription.renewed' : 'subscription.created',
        target: `account:${account.id}`,
      });
    } catch (e) {
      if (e instanceof ReconnectRequiredError) {
        await markReconnect(deps, account, PRINCIPAL);
        out.reconnect++;
      } else {
        out.failed++;
        deps.log.warn({ accountId: account.id, ...errInfo(e) }, 'subscription renewal failed');
      }
    }
  }
  return out;
}

/** Enqueues a catch-up sync for every live account (one per account per 15-min slot). */
export async function catchupSync(deps: WorkerDeps) {
  const rows = await deps.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.status, 'live'));
  const slot = Math.floor(deps.now().getTime() / CATCHUP_EVERY_MS);
  for (const r of rows) {
    await deps.enqueue(QUEUES.sync, { accountId: r.id, reason: 'catchup' } satisfies SyncJob, {
      jobId: `catchup-${r.id}-${slot}`,
    });
  }
  return { enqueued: rows.length };
}

/** Local date (YYYY-MM-DD) and minutes since midnight in a timezone; UTC if it is invalid. */
export function localClock(now: Date, timeZone: string) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return localClock(now, 'UTC');
  }
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** For each user whose local time has just passed settings.briefTime, enqueue today's brief. */
export async function dailyBriefs(deps: WorkerDeps) {
  const now = deps.now();
  const rows = await deps.db
    .select({
      id: users.id,
      timezone: users.timezone,
      settings: users.settings,
      paused: users.paused,
    })
    .from(users);
  let enqueued = 0;
  for (const u of rows) {
    if (u.paused) continue;
    const parsed = UserSettings.safeParse(u.settings ?? {});
    const settings = parsed.success ? parsed.data : UserSettings.parse({});
    const { date, minutes } = localClock(now, u.timezone || 'UTC');
    const since = minutes - toMinutes(settings.briefTime);
    if (since < 0 || since >= BRIEF_WINDOW_MIN) continue;
    const [existing] = await deps.db
      .select({ id: briefs.id })
      .from(briefs)
      .where(and(eq(briefs.userId, u.id), eq(briefs.date, date)));
    if (existing) continue;
    await deps.enqueue(
      QUEUES.agents,
      { agent: 'brief', userId: u.id, date },
      { jobId: `brief:${u.id}:${date}` },
    );
    enqueued++;
  }
  return { enqueued };
}

/** Pending access requests older than 24h expire. */
export async function expireGrants(deps: WorkerDeps) {
  const now = deps.now();
  const expired = await deps.db
    .update(accessRequests)
    .set({ status: 'expired', decidedAt: now })
    .where(
      and(
        eq(accessRequests.status, 'pending'),
        lt(accessRequests.createdAt, new Date(now.getTime() - REQUEST_TTL_MS)),
      ),
    )
    .returning({ id: accessRequests.id, userId: accessRequests.userId });
  for (const r of expired) {
    await audit(deps.db, {
      userId: r.userId,
      principal: PRINCIPAL,
      action: 'access_request.expired',
      target: `access_request:${r.id}`,
    });
  }
  return { expired: expired.length };
}

/**
 * Deletes message bodies past `item_bodies.expires_at` (retention, BODY_RETENTION_DAYS) in
 * batches and clears `items.body_ref`. One audit row per user, with counts only.
 */
export async function purgeExpiredBodies(
  deps: Pick<WorkerDeps, 'db' | 'now'>,
  opts: { batchSize?: number; maxBatches?: number } = {},
) {
  const batchSize = opts.batchSize ?? PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? PURGE_MAX_BATCHES;
  const now = deps.now();
  const perUser = new Map<string, number>();
  let deleted = 0;
  let batches = 0;
  for (; batches < maxBatches; batches++) {
    const batch = await deps.db
      .select({ id: itemBodies.id, userId: accounts.userId })
      .from(itemBodies)
      .innerJoin(accounts, eq(itemBodies.accountId, accounts.id))
      .where(and(isNotNull(itemBodies.expiresAt), lte(itemBodies.expiresAt, now)))
      .limit(batchSize);
    if (batch.length === 0) break;
    const ids = batch.map((b) => b.id);
    await deps.db.transaction(async (tx) => {
      await tx.update(items).set({ bodyRef: null }).where(inArray(items.bodyRef, ids));
      await tx.delete(itemBodies).where(inArray(itemBodies.id, ids));
    });
    for (const b of batch) perUser.set(b.userId, (perUser.get(b.userId) ?? 0) + 1);
    deleted += batch.length;
    if (batch.length < batchSize) {
      batches++;
      break;
    }
  }
  for (const [userId, count] of perUser) {
    await audit(deps.db, {
      userId,
      principal: PRINCIPAL,
      action: 'retention.bodies_purged',
      target: null,
      details: { deleted: count },
    });
  }
  return { deleted, users: perUser.size, batches };
}

export async function runSchedulerTask(deps: WorkerDeps, job: SchedulerJob) {
  switch (job.task) {
    case 'renew-subscriptions':
      return renewSubscriptions(deps);
    case 'catchup-sync':
      return catchupSync(deps);
    case 'daily-briefs':
      return dailyBriefs(deps);
    case 'expire-grants':
      return expireGrants(deps);
    case 'purge-expired-bodies':
      return purgeExpiredBodies(deps);
  }
}

export async function installSchedules() {
  const q = queue<SchedulerJob>(QUEUES.scheduler);
  for (const s of SCHEDULES) {
    await q.upsertJobScheduler(s.id, s.repeat, {
      name: s.id,
      data: { task: s.id } as SchedulerJob,
      opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 200 } },
    });
  }
}

/** Starts the scheduler worker and installs the repeatable job schedulers. */
export function start(): Closable[] {
  const deps = defaultDeps('scheduler');
  installSchedules().catch((e: unknown) =>
    deps.log.error({ ...errInfo(e) }, 'failed to install job schedulers'),
  );
  const w = worker<SchedulerJob>(
    QUEUES.scheduler,
    async (job) => runSchedulerTask(deps, SchedulerJob.parse(job.data)),
    1,
  );
  w.on('completed', (job, result) =>
    deps.log.info({ task: job.data.task, result }, 'scheduler task done'),
  );
  w.on('failed', (job, err) =>
    deps.log.warn({ task: job?.data?.task, ...errInfo(err) }, 'scheduler task failed'),
  );
  return [w];
}
