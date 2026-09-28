import type { JobsOptions } from 'bullmq';
import { getConnector, type Connector } from '@hub/connectors';
import { getDb, type Db } from '@hub/db';
import { createLogger, enqueue, publishLive, redis, type Logger } from '@hub/server';
import { SecretStore, keyProvider, type KeyProvider } from '@hub/server/secrets';
import type { LiveEvent, QueueName } from '@hub/shared/queues';
import { RedisAccountLock, type AccountLock } from './lock';

export type EnqueueFn = (
  name: QueueName,
  data: unknown,
  opts?: JobsOptions & { jobId?: string },
) => Promise<unknown>;

/** Everything the sync/backfill/scheduler logic touches, injectable for tests. */
export type WorkerDeps = {
  db: Db;
  keys: KeyProvider;
  secrets: SecretStore;
  getConnector: (provider: string) => Connector;
  enqueue: EnqueueFn;
  publishLive: (userId: string, event: LiveEvent) => Promise<void>;
  lock: AccountLock;
  log: Logger;
  now: () => Date;
};

export function defaultDeps(name: string): WorkerDeps {
  const db = getDb();
  const keys = keyProvider();
  return {
    db,
    keys,
    secrets: new SecretStore(db, keys),
    getConnector,
    enqueue: (q, data, opts) => enqueue(q, data, opts),
    publishLive,
    lock: new RedisAccountLock(redis()),
    log: createLogger(name),
    now: () => new Date(),
  };
}

/** Safe error summary for logs: class name and HTTP status, never the message body. */
export function errInfo(e: unknown) {
  if (e && typeof e === 'object') {
    const x = e as { name?: unknown; status?: unknown };
    return { err: typeof x.name === 'string' ? x.name : 'Error', status: x.status };
  }
  return { err: typeof e };
}
