import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES, type QueueName, type RevokeWriteTokenJob } from '@hub/shared/queues';
import { env } from './env';
import { sanitizeJobError } from './errors';

let connection: Redis | undefined;

export function redis(): Redis {
  connection ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

/** Retries with exponential backoff; failed jobs stay in the failed set (our dead-letter queue). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: false,
};

const queues = new Map<string, Queue>();

export function queue<T = unknown>(name: QueueName): Queue<T> {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: redis() as ConnectionOptions,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, q);
  }
  return q as Queue<T>;
}

/**
 * BullMQ rejects custom job ids containing `:` (unless they have exactly three parts),
 * so callers can use readable ids like `triage:<itemId>` and we normalize them here.
 */
export function safeJobId(jobId: string): string {
  return jobId.replaceAll(':', '-');
}

/** Enqueue with an explicit jobId so duplicate enqueues collapse into one job. */
export async function enqueue<T>(
  name: QueueName,
  data: T,
  opts: JobsOptions & { jobId?: string } = {},
) {
  const jobId = opts.jobId === undefined ? undefined : safeJobId(opts.jobId);
  return (queue(name) as Queue).add(name, data, { ...opts, jobId });
}

/**
 * A BullMQ worker. Errors escaping `processor` are replaced by a sanitized error (class name
 * and code only), so database errors with bound params never land in Redis `failedReason`
 * or in `failed` event logs.
 */
export function worker<T>(name: QueueName, processor: Processor<T>, concurrency = 5) {
  const safe: Processor<T> = async (job, token, signal) => {
    try {
      return await processor(job, token, signal);
    } catch (err) {
      throw sanitizeJobError(err);
    }
  };
  return new Worker<T>(name, safe, {
    connection: new Redis(env().REDIS_URL, { maxRetriesPerRequest: null }) as ConnectionOptions,
    concurrency,
  });
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  await connection?.quit();
  connection = undefined;
}

/**
 * Hands a write-scope token to the executor to revoke at the provider and delete.
 * Only the executor can decrypt write tokens, so callers (e.g. DELETE /accounts/:id) must
 * not delete the secret themselves. Idempotent per secret.
 */
export async function requestWriteTokenRevocation(
  enqueueFn: (name: QueueName, data: unknown, opts?: { jobId?: string }) => Promise<unknown>,
  job: Omit<RevokeWriteTokenJob, 'task'>,
): Promise<void> {
  const data: RevokeWriteTokenJob = { task: 'revoke-write-token', ...job };
  await enqueueFn(QUEUES.executor, data, { jobId: `revoke-write-${job.secretRef}` });
}
