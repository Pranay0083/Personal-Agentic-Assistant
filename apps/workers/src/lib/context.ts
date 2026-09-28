import { eq } from 'drizzle-orm';
import { ReconnectRequiredError, type ConnectorContext, type OAuthTokens } from '@hub/connectors';
import { accounts, type Db } from '@hub/db';
import type { SecretStore } from '@hub/server/secrets';
import { AccountFilters } from '@hub/shared';

export type AccountRow = typeof accounts.$inferSelect;

export async function loadAccount(db: Db, accountId: string): Promise<AccountRow | null> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return row ?? null;
}

export function accountFilters(account: Pick<AccountRow, 'filters'>): AccountFilters {
  const parsed = AccountFilters.safeParse(account.filters ?? {});
  return parsed.success ? parsed.data : AccountFilters.parse({});
}

/**
 * Builds the read-path ConnectorContext for an account: decrypts `token_ref` (never the
 * write token) and re-encrypts refreshed tokens in place via SecretStore.replace.
 */
export async function connectorContext(
  deps: { secrets: SecretStore },
  account: AccountRow,
): Promise<ConnectorContext> {
  if (!account.tokenRef) {
    throw new ReconnectRequiredError(account.provider, 'no read token stored');
  }
  const ref = account.tokenRef;
  let tokens: OAuthTokens;
  try {
    tokens = await deps.secrets.getJson<OAuthTokens>(ref);
  } catch {
    throw new ReconnectRequiredError(account.provider, 'stored token unreadable');
  }
  return {
    accountId: account.id,
    externalId: account.externalId,
    tokens,
    saveTokens: async (next) => {
      const merged: OAuthTokens = { ...next };
      if (!merged.refreshToken && tokens.refreshToken) merged.refreshToken = tokens.refreshToken;
      tokens = merged;
      await deps.secrets.replace(ref, JSON.stringify(merged));
    },
    cursor: account.syncCursor,
    filters: accountFilters(account),
  };
}
