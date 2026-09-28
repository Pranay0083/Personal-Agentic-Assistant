import { and, eq, isNull } from 'drizzle-orm';
import type { Connector, ConnectorContext, SubscriptionInfo } from '@hub/connectors';
import { accounts, audit, subscriptions } from '@hub/db';
import type { AccountRow } from './context';
import type { WorkerDeps } from './deps';

export const watchKind = (provider: string) => `${provider}.watch`;

/** Token is revoked/expired for good: flag the account and tell the app. No retry. */
export async function markReconnect(
  deps: Pick<WorkerDeps, 'db' | 'publishLive'>,
  account: AccountRow,
  principal: string,
) {
  await deps.db.update(accounts).set({ status: 'reconnect' }).where(eq(accounts.id, account.id));
  await audit(deps.db, {
    userId: account.userId,
    principal,
    action: 'account.reconnect_required',
    target: `account:${account.id}`,
    details: { provider: account.provider },
  });
  await deps.publishLive(account.userId, { type: 'account.updated', accountId: account.id });
}

export async function setStatus(
  deps: Pick<WorkerDeps, 'db' | 'publishLive'>,
  account: AccountRow,
  status: string,
  extra: Partial<Pick<AccountRow, 'lastSyncedAt' | 'syncCursor'>> = {},
) {
  const changed = account.status !== status;
  await deps.db
    .update(accounts)
    .set({ status, ...extra })
    .where(eq(accounts.id, account.id));
  account.status = status;
  if (changed)
    await deps.publishLive(account.userId, { type: 'account.updated', accountId: account.id });
}

/**
 * Makes sure the provider push subscription exists and is not expired. On first
 * subscribe the returned cursor (Gmail historyId) becomes the account's sync cursor;
 * an existing cursor is never overwritten (that would skip mail).
 */
export async function ensureSubscription(
  deps: Pick<WorkerDeps, 'db' | 'now'>,
  account: AccountRow,
  connector: Connector,
  ctx: ConnectorContext,
  opts: { force?: boolean } = {},
): Promise<{ changed: boolean; info?: SubscriptionInfo }> {
  const kind = watchKind(account.provider);
  const [sub] = await deps.db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.accountId, account.id), eq(subscriptions.kind, kind)));
  const now = deps.now();
  if (sub && !opts.force && (!sub.expiresAt || sub.expiresAt > now)) return { changed: false };
  const info = sub ? await connector.renew(ctx) : await connector.subscribe(ctx);
  await deps.db
    .insert(subscriptions)
    .values({
      accountId: account.id,
      kind,
      externalSubId: info.externalSubId,
      expiresAt: info.expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [subscriptions.accountId, subscriptions.kind],
      set: { externalSubId: info.externalSubId, expiresAt: info.expiresAt, updatedAt: now },
    });
  if (!account.syncCursor && info.cursor) {
    await deps.db
      .update(accounts)
      .set({ syncCursor: info.cursor })
      .where(and(eq(accounts.id, account.id), isNull(accounts.syncCursor)));
    account.syncCursor = info.cursor;
    ctx.cursor = info.cursor;
  }
  return { changed: true, info };
}
