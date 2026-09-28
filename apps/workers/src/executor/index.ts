import { UnrecoverableError } from 'bullmq';
import { getConnector } from '@hub/connectors';
import { getDb } from '@hub/db';
import { createLogger, publishLive, worker } from '@hub/server';
import { createSecretStore } from '@hub/server/secrets';
import { ExecutorJob, QUEUES, RevokeWriteTokenJob } from '@hub/shared/queues';
import type { Closable } from '../types';
import { executeProposal, type ExecutorDeps } from './execute';
import { revokeWriteToken } from './revoke';

export * from './execute';
export * from './revoke';

/**
 * Starts the executor worker. Enqueue with jobId `exec-<proposalId>` so duplicate
 * approvals collapse; the advisory lock + atomic claim make it safe even if they don't.
 * Also handles `revoke-write-token` jobs (see RevokeWriteTokenJob).
 */
export function start(): Closable[] {
  const log = createLogger('executor');
  const db = getDb();
  // The only SecretStore that may decrypt write-scope tokens. With KMS, only the executor's
  // IAM role has Decrypt on WRITE_KMS_KEY_ID.
  const secrets = createSecretStore(db, { allowWriteDecrypt: true });
  const deps: ExecutorDeps = {
    db,
    secrets,
    getConnector: (provider) => getConnector(provider),
    publishLive,
    now: () => new Date(),
    log,
  };
  const w = worker<unknown>(
    QUEUES.executor,
    async (job) => {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const revoke = RevokeWriteTokenJob.safeParse(job.data);
      if (revoke.success) {
        const outcome = await revokeWriteToken({ ...deps, secrets }, revoke.data, {
          finalAttempt,
        });
        log.info({ accountId: revoke.data.accountId, status: outcome.status }, 'revoke job done');
        return outcome;
      }
      const parsed = ExecutorJob.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('invalid executor job');
      const outcome = await executeProposal(deps, parsed.data.proposalId, { finalAttempt });
      log.info({ proposalId: parsed.data.proposalId, status: outcome.status }, 'executor job done');
      return outcome;
    },
    2,
  );
  return [w];
}
