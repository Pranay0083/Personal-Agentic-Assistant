import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import type { QueueName } from '@hub/shared/queues';
import { env } from './env';

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

/** Enqueue with an explicit jobId so duplicate enqueues collapse into one job. */
export async function enqueue<T>(
  name: QueueName,
  data: T,
  opts: JobsOptions & { jobId?: string } = {},
) {
  return (queue(name) as Queue).add(name, data, opts);
}

export function worker<T>(name: QueueName, processor: Processor<T>, concurrency = 5) {
  return new Worker<T>(name, processor, {
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
