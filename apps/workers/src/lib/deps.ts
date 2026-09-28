import type { JobsOptions } from 'bullmq';
import { getConnector, type Connector } from '@hub/connectors';
import { getDb, type Db } from '@hub/db';
import { createLogger, enqueue, errorInfo, publishLive, redis, type Logger } from '@hub/server';
import {
  createSecretStore,
  keyProvider,
  type KeyProvider,
  type SecretStore,
} from '@hub/server/secrets';
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
    // Read tokens only: this store cannot decrypt write-scope secrets (executor-only).
    secrets: createSecretStore(db),
    getConnector,
    enqueue: (q, data, opts) => enqueue(q, data, opts),
    publishLive,
    lock: new RedisAccountLock(redis()),
    log: createLogger(name),
    now: () => new Date(),
  };
}

/**
 * Safe error summary for logs: class name, driver code (`err.cause.code`) and HTTP status.
 * Never the message: DB errors carry the SQL and its params there.
 */
export const errInfo = errorInfo;
