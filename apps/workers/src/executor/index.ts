import { UnrecoverableError } from 'bullmq';
import { getConnector } from '@hub/connectors';
import { getDb } from '@hub/db';
import { createLogger, publishLive, worker } from '@hub/server';
import { keyProvider, SecretStore } from '@hub/server/secrets';
import { ExecutorJob, QUEUES } from '@hub/shared/queues';
import type { Closable } from '../types';
import { executeProposal, type ExecutorDeps } from './execute';

export * from './execute';

/**
 * Starts the executor worker. Enqueue with jobId `exec-<proposalId>` so duplicate
 * approvals collapse; the advisory lock + atomic claim make it safe even if they don't.
 */
export function start(): Closable[] {
  const log = createLogger('executor');
  const db = getDb();
  const deps: ExecutorDeps = {
    db,
    secrets: new SecretStore(db, keyProvider()),
    getConnector: (provider) => getConnector(provider),
    publishLive,
    now: () => new Date(),
    log,
  };
  const w = worker<unknown>(
    QUEUES.executor,
    async (job) => {
      const parsed = ExecutorJob.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('invalid executor job');
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const outcome = await executeProposal(deps, parsed.data.proposalId, { finalAttempt });
      log.info({ proposalId: parsed.data.proposalId, status: outcome.status }, 'executor job done');
      return outcome;
    },
    2,
  );
  return [w];
}
