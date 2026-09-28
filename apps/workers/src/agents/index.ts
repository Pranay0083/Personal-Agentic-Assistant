import { UnrecoverableError } from 'bullmq';
import { audit, getDb } from '@hub/db';
import { BudgetExceededError, createRouter } from '@hub/models';
import { createLogger, enqueue, errorInfo, publishLive, worker } from '@hub/server';
import { createSecretStore, keyProvider } from '@hub/server/secrets';
import { AgentJob, QUEUES } from '@hub/shared/queues';
import type { Closable } from '../types';
import { runBrief } from './brief';
import type { AgentDeps, AgentOutcome } from './context';
import { runExtractor } from './extractor';
import { runReply } from './reply';
import { runTriage } from './triage';

export { runBrief, runExtractor, runReply, runTriage };
export type { AgentDeps, AgentOutcome };

/** Dispatches one agents-queue job. */
export async function runAgentJob(deps: AgentDeps, job: AgentJob): Promise<AgentOutcome> {
  switch (job.agent) {
    case 'triage':
      return runTriage(deps, job.itemId);
    case 'extractor':
      return runExtractor(deps, job.itemId);
    case 'reply':
      return runReply(deps, job.itemId);
    case 'brief':
      return runBrief(deps, job.userId, job.date);
  }
}

/** Starts the agents worker. */
export function start(): Closable[] {
  const log = createLogger('agents');
  const db = getDb();
  const keys = keyProvider();
  const deps: AgentDeps = {
    db,
    router: createRouter({ db, secrets: createSecretStore(db) }),
    enqueue: (queue, data, opts) => enqueue(queue, data, opts),
    publishLive,
    now: () => new Date(),
    keys,
    log,
  };
  const w = worker<unknown>(QUEUES.agents, async (job) => {
    const parsed = AgentJob.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid agent job');
    try {
      const outcome = await runAgentJob(deps, parsed.data);
      log.info(
        { agent: parsed.data.agent, jobId: job.id, status: outcome.status },
        'agent job done',
      );
      return outcome;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await audit(db, {
          userId: err.userId,
          principal: `agent:${parsed.data.agent}`,
          action: 'agent.budget_exceeded',
          target: null,
          details: { capUsd: err.capUsd, spentUsd: err.spentUsd },
        });
        throw new UnrecoverableError('monthly model budget reached');
      }
      // Name and driver code only; worker() hands BullMQ a sanitized error (no SQL params).
      log.warn({ agent: parsed.data.agent, jobId: job.id, ...errorInfo(err) }, 'agent job failed');
      throw err;
    }
  });
  return [w];
}
