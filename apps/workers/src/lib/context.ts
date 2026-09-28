import { and, eq, isNull } from 'drizzle-orm';
import {
  enabledSources,
  ReconnectRequiredError,
  type Connector,
  type ConnectorContext,
  type OAuthTokens,
  type SubscriptionInfo,
} from '@hub/connectors';
import { accounts, subscriptions, type Db } from '@hub/db';
import type { SecretStore } from '@hub/server/secrets';
import type { AccountLock } from './lock';
import { AccountFilters } from '@hub/shared';

export type AccountRow = typeof accounts.$inferSelect;
/** One (account, source) row: push subscription, delta cursor and meta. `kind` is the source id. */
export type SourceRow = typeof subscriptions.$inferSelect;

export async function loadAccount(db: Db, accountId: string): Promise<AccountRow | null> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return row ?? null;
}

export function accountFilters(account: Pick<AccountRow, 'filters'>): AccountFilters {
  const parsed = AccountFilters.safeParse(account.filters ?? {});
  return parsed.success ? parsed.data : AccountFilters.parse({});
}

export function accountMeta(account: Pick<AccountRow, 'meta'>): Record<string, unknown> {
  const m = account.meta;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

const metaOf = (row: Pick<SourceRow, 'meta'> | null | undefined): Record<string, unknown> => {
  const m = row?.meta;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
};

/** Sources that should sync for this account right now (toggles, defaults, granted scopes). */
export function sourcesOf(connector: Connector, account: AccountRow): string[] {
  return enabledSources(connector.info, accountFilters(account), accountMeta(account));
}

/**
 * Whether the source has been subscribed (push registered, or subscribe() ran for a source
 * without push). Rows created only to hold a cursor (migration, API toggles) are not.
 */
export function isSubscribed(row: SourceRow | null | undefined): boolean {
  if (!row) return false;
  return row.externalSubId !== null || row.expiresAt !== null || !!metaOf(row).subscribedAt;
}

export async function loadSource(
  db: Db,
  accountId: string,
  source: string,
): Promise<SourceRow | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.kind, source)));
  return row ?? null;
}

export async function loadSources(db: Db, accountId: string): Promise<SourceRow[]> {
  return db.select().from(subscriptions).where(eq(subscriptions.accountId, accountId));
}

/** Loads the source row, creating an empty enabled one (cursor null, not subscribed) if missing. */
export async function ensureSourceRow(
  db: Db,
  accountId: string,
  source: string,
  now: Date,
): Promise<SourceRow> {
  const [created] = await db
    .insert(subscriptions)
    .values({ accountId, kind: source, enabled: true, updatedAt: now })
    .onConflictDoNothing({ target: [subscriptions.accountId, subscriptions.kind] })
    .returning();
  if (created) return created;
  const row = (await loadSource(db, accountId, source))!;
  if (!row.enabled) {
    await db
      .update(subscriptions)
      .set({ enabled: true, updatedAt: now })
      .where(eq(subscriptions.id, row.id));
    row.enabled = true;
  }
  return row;
}

/** Stores a source's delta cursor. A null cursor never overwrites a stored one. */
export async function saveCursor(
  db: Db,
  row: SourceRow,
  cursor: string | null | undefined,
  now: Date,
): Promise<void> {
  if (!cursor || cursor === row.cursor) return;
  await db
    .update(subscriptions)
    .set({ cursor, updatedAt: now })
    .where(eq(subscriptions.id, row.id));
  row.cursor = cursor;
}

/**
 * Stores what subscribe()/renew() returned. The returned cursor becomes the source's cursor
 * only if it has none yet (overwriting it would skip changes). `externalSubId`, `expiresAt`
 * and meta are overwritten on subscribe and renew alike (renew may re-register with a new
 * id), and `subscribedAt` marks the source subscribed even when it has no push channel.
 */
export async function saveSubscription(
  db: Db,
  row: SourceRow,
  info: SubscriptionInfo,
  now: Date,
): Promise<void> {
  // Returned meta replaces the old (a re-registered webhook has new ids and a new secret
  // hash); a connector that returns none keeps what was stored.
  const meta = { ...(info.meta ?? metaOf(row)), subscribedAt: now.toISOString() };
  await db
    .update(subscriptions)
    .set({
      externalSubId: info.externalSubId,
      expiresAt: info.expiresAt,
      meta,
      enabled: true,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, row.id));
  Object.assign(row, {
    externalSubId: info.externalSubId,
    expiresAt: info.expiresAt,
    meta,
    enabled: true,
  });
  if (info.cursor && !row.cursor) {
    await db
      .update(subscriptions)
      .set({ cursor: info.cursor })
      .where(and(eq(subscriptions.id, row.id), isNull(subscriptions.cursor)));
    row.cursor = info.cursor;
  }
}

/** Marks a source disabled and forgets its push subscription (the cursor is kept). */
export async function clearSubscription(db: Db, row: SourceRow, now: Date): Promise<void> {
  await db
    .update(subscriptions)
    .set({ enabled: false, externalSubId: null, expiresAt: null, meta: {}, updatedAt: now })
    .where(eq(subscriptions.id, row.id));
  Object.assign(row, { enabled: false, externalSubId: null, expiresAt: null, meta: {} });
}

/**
 * Builds the read-path ConnectorContext for one source of an account: decrypts `token_ref`
 * (never the write token), re-encrypts refreshed tokens in place via SecretStore.replace,
 * and carries the source row's cursor and subscription plus the account's meta.
 */
export async function connectorContext(
  deps: { secrets: SecretStore; lock?: AccountLock },
  account: AccountRow,
  opts: { source?: string; row?: SourceRow | null } = {},
): Promise<ConnectorContext> {
  if (!account.tokenRef) {
    throw new ReconnectRequiredError(account.provider, 'no read token stored');
  }
  const ref = account.tokenRef;
  let tokens: OAuthTokens;
  try {
    tokens = await deps.secrets.getJson<OAuthTokens>(ref, { userId: account.userId });
  } catch {
    throw new ReconnectRequiredError(account.provider, 'stored token unreadable');
  }
  const row = opts.row ?? null;
  const ctx: ConnectorContext = {
    accountId: account.id,
    externalId: account.externalId,
    tokens,
    saveTokens: async (next) => {
      const merged: OAuthTokens = { ...next };
      if (!merged.refreshToken && tokens.refreshToken) merged.refreshToken = tokens.refreshToken;
      tokens = merged;
      ctx.tokens = merged;
      await deps.secrets.replace(ref, JSON.stringify(merged));
    },
    // Sibling accounts from one consent share this secret; one may have rotated it first.
    reloadTokens: async () => {
      tokens = await deps.secrets.getJson<OAuthTokens>(ref, { userId: account.userId });
      return tokens;
    },
    // Serialize refreshes of this grant across sibling accounts (rotating refresh tokens).
    ...(deps.lock
      ? { withRefreshLock: <T>(fn: () => Promise<T>) => withGrantLock(deps.lock!, ref, fn) }
      : {}),
    cursor: row?.cursor ?? null,
    filters: accountFilters(account),
    meta: accountMeta(account),
    subscription: row
      ? { externalSubId: row.externalSubId, expiresAt: row.expiresAt, meta: metaOf(row) }
      : null,
  };
  const source = opts.source ?? row?.kind;
  if (source) ctx.source = source;
  return ctx;
}

/** Points an existing context at a source row (after subscribe/renew changed it). */
export function refreshContext(ctx: ConnectorContext, row: SourceRow): void {
  ctx.source = row.kind;
  ctx.cursor = row.cursor;
  ctx.subscription = {
    externalSubId: row.externalSubId,
    expiresAt: row.expiresAt,
    meta: metaOf(row),
  };
}

const REFRESH_LOCK_TTL_MS = 30_000;
const REFRESH_LOCK_WAIT_MS = 15_000;

/**
 * Runs `fn` holding a lock on one token secret. Waits for a sibling that holds it (it is
 * probably refreshing the same grant), then runs; after the wait budget it runs anyway,
 * because the oauth2 helper still recovers from a lost race by reloading.
 */
async function withGrantLock<T>(lock: AccountLock, ref: string, fn: () => Promise<T>): Promise<T> {
  const key = `grant-refresh:${ref}`;
  const until = Date.now() + REFRESH_LOCK_WAIT_MS;
  let release = await lock.tryAcquire(key, REFRESH_LOCK_TTL_MS);
  while (!release && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    release = await lock.tryAcquire(key, REFRESH_LOCK_TTL_MS);
  }
  try {
    return await fn();
  } finally {
    await release?.();
  }
}
