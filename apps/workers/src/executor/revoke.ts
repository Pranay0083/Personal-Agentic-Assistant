import { and, eq } from 'drizzle-orm';
import { ReconnectRequiredError, type Connector, type OAuthTokens } from '@hub/connectors';
import { accounts, audit, secrets as secretsTable, type Db } from '@hub/db';
import { errorInfo, type Logger } from '@hub/server';
import type { RevokeWriteTokenJob } from '@hub/shared/queues';
import { isRetryableError } from './execute';

export type RevokeDeps = {
  db: Db;
  /** Must be able to decrypt write secrets: only the executor's store can. */
  secrets: {
    get(ref: string, expected?: { userId?: string; kind?: string }): Promise<string>;
    delete(ref: string): Promise<void>;
  };
  getConnector: (provider: string) => Connector;
  log?: Logger;
};

export type RevokeOutcome =
  | { status: 'missing' }
  | { status: 'refused'; reason: string }
  | { status: 'revoked' | 'deleted'; revoked: boolean };

const EXECUTOR = 'system:executor';
export const writeTokenKind = (provider: string) => `oauth:${provider}:write`;

function parseTokens(raw: string): OAuthTokens {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && typeof (v as OAuthTokens).accessToken === 'string') {
      return v as OAuthTokens;
    }
  } catch {
    // not JSON: a bare access token
  }
  return { accessToken: raw };
}

/**
 * Revokes a write-scope token at the provider (best effort), then deletes the secret.
 * Runs in the executor because only it can decrypt write tokens. Idempotent: a missing
 * secret means it is already done. The secret must belong to `job.userId` and be that
 * provider's write kind, so a job can never be used to revoke or delete anything else.
 */
export async function revokeWriteToken(
  deps: RevokeDeps,
  job: RevokeWriteTokenJob,
  opts: { finalAttempt?: boolean } = {},
): Promise<RevokeOutcome> {
  const { db } = deps;
  const target = `account:${job.accountId}`;
  const kind = writeTokenKind(job.provider);
  const [row] = await db
    .select({ id: secretsTable.id, userId: secretsTable.userId, kind: secretsTable.kind })
    .from(secretsTable)
    .where(eq(secretsTable.id, job.secretRef));
  if (!row) return { status: 'missing' };
  if (row.userId !== job.userId || row.kind !== kind) {
    await audit(db, {
      userId: job.userId,
      principal: EXECUTOR,
      action: 'executor.write_token_revoke_refused',
      target,
      details: { reason: 'secret does not match the job' },
    });
    return { status: 'refused', reason: 'secret does not match the job' };
  }

  // Write access is gone from now on, whether or not the provider call below succeeds.
  await db
    .update(accounts)
    .set({ writeTokenRef: null })
    .where(and(eq(accounts.writeTokenRef, row.id), eq(accounts.userId, job.userId)));

  let revoked = false;
  try {
    const connector = deps.getConnector(job.provider);
    const tokens = parseTokens(await deps.secrets.get(row.id, { userId: job.userId, kind }));
    await connector.connect.revoke(tokens);
    revoked = true;
  } catch (err) {
    if (isRetryableError(err) && !(err instanceof ReconnectRequiredError) && !opts.finalAttempt) {
      throw err; // provider hiccup: retry the revoke before deleting the token
    }
    deps.log?.warn({ accountId: job.accountId, ...errorInfo(err) }, 'write token revoke failed');
  }

  await deps.secrets.delete(row.id);
  await audit(db, {
    userId: job.userId,
    principal: EXECUTOR,
    action: 'executor.write_token_revoked',
    target,
    details: { provider: job.provider, revoked },
  });
  return { status: revoked ? 'revoked' : 'deleted', revoked };
}
