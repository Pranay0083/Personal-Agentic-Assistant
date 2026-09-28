import { eq } from 'drizzle-orm';
import type { Connector, ConnectorContext, SubscriptionInfo } from '@hub/connectors';
import { accounts, audit } from '@hub/db';
import {
  clearSubscription,
  ensureSourceRow,
  isSubscribed,
  loadSources,
  refreshContext,
  saveSubscription,
  sourcesOf,
  type AccountRow,
  type SourceRow,
} from './context';
import { errInfo, type WorkerDeps } from './deps';

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
  extra: Partial<Pick<AccountRow, 'lastSyncedAt'>> = {},
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
 * Makes sure one source's subscription row exists and is subscribed and not expired.
 * Sources without push get a row too (externalSubId null) that holds the cursor. On first
 * subscribe the returned cursor becomes the source's cursor; an existing cursor is never
 * overwritten (that would skip changes). `ctx` must be for `row.kind`; it is updated.
 */
export async function ensureSubscription(
  deps: Pick<WorkerDeps, 'db' | 'now'>,
  connector: Connector,
  ctx: ConnectorContext,
  row: SourceRow,
  opts: { force?: boolean } = {},
): Promise<{ changed: boolean; renewed: boolean; info?: SubscriptionInfo }> {
  const now = deps.now();
  const subscribed = isSubscribed(row);
  if (subscribed && !opts.force && (!row.expiresAt || row.expiresAt > now)) {
    return { changed: false, renewed: false };
  }
  refreshContext(ctx, row);
  const info = subscribed ? await connector.renew(ctx) : await connector.subscribe(ctx);
  await saveSubscription(deps.db, row, info, now);
  refreshContext(ctx, row);
  return { changed: true, renewed: subscribed, info };
}

/** The source row for `source`, created if missing. */
export async function sourceRow(
  deps: Pick<WorkerDeps, 'db' | 'now'>,
  account: AccountRow,
  source: string,
): Promise<SourceRow> {
  return ensureSourceRow(deps.db, account.id, source, deps.now());
}

/**
 * Sources that are no longer enabled (toggled off, or no longer granted) get `enabled=false`
 * and, if they were subscribed, `connector.unsubscribe`. Unsubscribe failures are logged and
 * the row is still disabled: the gateway drops notifications for disabled sources.
 */
export async function disableRemovedSources(
  deps: Pick<WorkerDeps, 'db' | 'now' | 'log'>,
  connector: Connector,
  account: AccountRow,
  ctxFor: (row: SourceRow) => Promise<ConnectorContext>,
): Promise<string[]> {
  const enabled = new Set(sourcesOf(connector, account));
  const rows = await loadSources(deps.db, account.id);
  const disabled: string[] = [];
  for (const row of rows) {
    if (enabled.has(row.kind)) continue;
    if (!row.enabled && !isSubscribed(row)) continue;
    if (isSubscribed(row) && connector.unsubscribe) {
      try {
        await connector.unsubscribe(await ctxFor(row));
      } catch (e) {
        deps.log.warn(
          { accountId: account.id, source: row.kind, ...errInfo(e) },
          'unsubscribe failed',
        );
      }
    }
    await clearSubscription(deps.db, row, deps.now());
    disabled.push(row.kind);
  }
  return disabled;
}
