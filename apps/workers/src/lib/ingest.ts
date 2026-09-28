import { and, eq, inArray } from 'drizzle-orm';
import type { Connector, NormalizedItem } from '@hub/connectors';
import { itemBodies, items } from '@hub/db';
import { seal } from '@hub/server/secrets';
import { QUEUES } from '@hub/shared/queues';
import { accountFilters, type AccountRow } from './context';
import type { WorkerDeps } from './deps';

export const BODY_RETENTION_DAYS = 90;

/** `enqueue()` maps it to a BullMQ-safe id (see safeJobId in @hub/server). */
export const triageJobId = (itemId: string) => `triage:${itemId}`;

export type IngestCounts = {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  newItemIds: string[];
};

/**
 * The one ingest path for sync and backfill: normalize, apply the account's filters,
 * upsert on (account_id, external_id), encrypt bodies into item_bodies, then — only for
 * newly inserted items — publish `item.created` and enqueue triage.
 */
export async function ingestRecords(
  deps: Pick<WorkerDeps, 'db' | 'keys' | 'enqueue' | 'publishLive' | 'now'>,
  account: AccountRow,
  connector: Connector,
  records: unknown[],
  opts: { triagePriority?: number } = {},
): Promise<IngestCounts> {
  const counts: IngestCounts = {
    fetched: records.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    newItemIds: [],
  };
  const filters = accountFilters(account);
  const wanted = new Map<string, NormalizedItem>();
  for (const raw of records) {
    const item = connector.normalize(raw);
    if (!item || (connector.accepts && !connector.accepts(item, filters))) {
      counts.skipped++;
      continue;
    }
    wanted.set(item.externalId, item);
  }
  if (wanted.size === 0) return counts;

  const existing = await deps.db
    .select({ id: items.id, externalId: items.externalId })
    .from(items)
    .where(and(eq(items.accountId, account.id), inArray(items.externalId, [...wanted.keys()])));
  const existingIds = new Map(existing.map((r) => [r.externalId, r.id]));

  const now = deps.now();
  const expiresAt = new Date(now.getTime() + BODY_RETENTION_DAYS * 86400_000);

  for (const item of wanted.values()) {
    const id = existingIds.get(item.externalId);
    if (id) {
      // Labels change (read, archived); content does not. No new triage.
      await deps.db
        .update(items)
        .set({ labels: item.labels, updatedAt: now })
        .where(eq(items.id, id));
      counts.updated++;
      continue;
    }
    const envelope = item.body ? await seal(deps.keys, item.body) : null;
    const insertedId = await deps.db.transaction(async (tx) => {
      let bodyRef: string | null = null;
      if (envelope) {
        const [b] = await tx
          .insert(itemBodies)
          .values({ accountId: account.id, contentType: 'text/plain', ...envelope, expiresAt })
          .returning({ id: itemBodies.id });
        bodyRef = b!.id;
      }
      const [row] = await tx
        .insert(items)
        .values({
          accountId: account.id,
          kind: item.kind,
          externalId: item.externalId,
          threadId: item.threadId,
          author: item.author,
          authorAddress: item.authorAddress,
          title: item.title,
          bodyRef,
          summary: item.summary,
          url: item.url,
          labels: item.labels,
          receivedAt: item.receivedAt,
        })
        .onConflictDoNothing({ target: [items.accountId, items.externalId] })
        .returning({ id: items.id });
      if (!row && bodyRef) {
        // Lost a race with a concurrent ingest of the same message.
        await tx.delete(itemBodies).where(eq(itemBodies.id, bodyRef));
      }
      return row?.id ?? null;
    });
    if (insertedId) {
      counts.inserted++;
      counts.newItemIds.push(insertedId);
    } else {
      counts.updated++;
    }
  }

  for (const itemId of counts.newItemIds) {
    await deps.publishLive(account.userId, { type: 'item.created', itemId, accountId: account.id });
    await deps.enqueue(
      QUEUES.agents,
      { agent: 'triage', itemId },
      {
        jobId: triageJobId(itemId),
        ...(opts.triagePriority ? { priority: opts.triagePriority } : {}),
      },
    );
  }
  return counts;
}
