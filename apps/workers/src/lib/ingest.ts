import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Connector, NormalizedItem } from '@hub/connectors';
import { itemBodies, items } from '@hub/db';
import { itemBodyContext, seal } from '@hub/server/secrets';
import { QUEUES } from '@hub/shared/queues';
import { accountFilters, type AccountRow } from './context';
import type { WorkerDeps } from './deps';

export const BODY_RETENTION_DAYS = 90;

/** `enqueue()` maps it to a BullMQ-safe id (see safeJobId in @hub/server). */
export const triageJobId = (itemId: string) => `triage:${itemId}`;

/** Triage job for an item whose content changed; one per content version. */
export const retriageJobId = (itemId: string, hash: string) =>
  `triage-${itemId}-${hash.slice(0, 8)}`;

/** Label carrying the content hash of an item (ingest owns labels; triage owns `triage`). */
export const CONTENT_LABEL = 'hub:content:';
/** `<ns>:status:<v>` / `<ns>:state:<v>` (jira:status, github:state): part of the content. */
const STATUS_LABEL = /^[a-z0-9_-]+:(status|state):/i;

/**
 * Hash of what makes a record worth re-triaging: title, body and status labels. Read/unread
 * and other labels don't count, so they never cause triage churn.
 */
export function contentHash(item: Pick<NormalizedItem, 'title' | 'body' | 'labels'>): string {
  const status = item.labels.filter((l) => STATUS_LABEL.test(l)).sort();
  return createHash('sha256')
    .update(JSON.stringify([item.title ?? '', item.body ?? '', status]))
    .digest('hex')
    .slice(0, 32);
}

const storedHash = (labels: unknown): string | null => {
  if (!Array.isArray(labels)) return null;
  const l = labels.find((x): x is string => typeof x === 'string' && x.startsWith(CONTENT_LABEL));
  return l ? l.slice(CONTENT_LABEL.length) : null;
};

export type IngestCounts = {
  fetched: number;
  inserted: number;
  /** Already known, including `changed`. */
  updated: number;
  /** Known items whose content changed: refreshed and re-triaged. */
  changed: number;
  skipped: number;
  newItemIds: string[];
};

/**
 * The one ingest path for sync and backfill: normalize (with the source the records came
 * from), apply the account's filters, upsert on (account_id, external_id), encrypt bodies
 * into item_bodies, then publish `item.created` and enqueue triage for new items.
 *
 * Known items (a ticket, page, PR or thread re-synced after an edit or a new comment) are
 * compared by content hash: if title, body or status labels changed, the item is refreshed
 * (new sealed body, title, summary, labels, received_at), `item.updated` is published and
 * triage runs again under a per-version job id. Otherwise only the labels are updated.
 */
export async function ingestRecords(
  deps: Pick<WorkerDeps, 'db' | 'keys' | 'enqueue' | 'publishLive' | 'now'>,
  account: AccountRow,
  connector: Connector,
  records: unknown[],
  opts: { triagePriority?: number; source?: string } = {},
): Promise<IngestCounts> {
  const counts: IngestCounts = {
    fetched: records.length,
    inserted: 0,
    updated: 0,
    changed: 0,
    skipped: 0,
    newItemIds: [],
  };
  const filters = accountFilters(account);
  const wanted = new Map<string, NormalizedItem>();
  for (const raw of records) {
    const item = connector.normalize(raw, opts.source);
    if (!item || (connector.accepts && !connector.accepts(item, filters, opts.source))) {
      counts.skipped++;
      continue;
    }
    wanted.set(item.externalId, item);
  }
  if (wanted.size === 0) return counts;

  const existing = await deps.db
    .select({
      id: items.id,
      externalId: items.externalId,
      labels: items.labels,
      bodyRef: items.bodyRef,
    })
    .from(items)
    .where(and(eq(items.accountId, account.id), inArray(items.externalId, [...wanted.keys()])));
  const known = new Map(existing.map((r) => [r.externalId, r]));

  const now = deps.now();
  const expiresAt = new Date(now.getTime() + BODY_RETENTION_DAYS * 86400_000);
  const changed: { itemId: string; hash: string }[] = [];

  for (const item of wanted.values()) {
    const hash = contentHash(item);
    const labels = [
      ...item.labels.filter((l) => !l.startsWith(CONTENT_LABEL)),
      CONTENT_LABEL + hash,
    ];
    const prior = known.get(item.externalId);
    if (prior) {
      counts.updated++;
      const was = storedHash(prior.labels);
      // Items stored before hashing existed get a baseline, not a re-triage.
      if (was === null || was === hash) {
        await deps.db.update(items).set({ labels, updatedAt: now }).where(eq(items.id, prior.id));
        continue;
      }
      const envelope = item.body
        ? await seal(deps.keys, item.body, itemBodyContext(account.id))
        : null;
      await deps.db.transaction(async (tx) => {
        let bodyRef: string | null = null;
        if (envelope) {
          const [b] = await tx
            .insert(itemBodies)
            .values({ accountId: account.id, contentType: 'text/plain', ...envelope, expiresAt })
            .returning({ id: itemBodies.id });
          bodyRef = b!.id;
        }
        await tx
          .update(items)
          .set({
            title: item.title,
            summary: item.summary,
            author: item.author,
            authorAddress: item.authorAddress,
            url: item.url,
            labels,
            bodyRef,
            receivedAt: item.receivedAt,
            updatedAt: now,
          })
          .where(eq(items.id, prior.id));
        if (prior.bodyRef) await tx.delete(itemBodies).where(eq(itemBodies.id, prior.bodyRef));
      });
      counts.changed++;
      changed.push({ itemId: prior.id, hash });
      continue;
    }
    // Bound to the account: the envelope fails to open if moved to another account's row.
    const envelope = item.body
      ? await seal(deps.keys, item.body, itemBodyContext(account.id))
      : null;
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
          labels,
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

  for (const { itemId, hash } of changed) {
    await deps.publishLive(account.userId, { type: 'item.updated', itemId });
    await deps.enqueue(
      QUEUES.agents,
      { agent: 'triage', itemId },
      {
        jobId: retriageJobId(itemId, hash),
        ...(opts.triagePriority ? { priority: opts.triagePriority } : {}),
      },
    );
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
