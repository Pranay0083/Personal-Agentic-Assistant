/**
 * One process per queue in production: `tsx src/main.ts <role>`.
 * `all` runs every worker in one process for local dev.
 */
import { closeDb } from '@hub/db';
import { closeQueues, createLogger } from '@hub/server';
import type { Closable } from './types';

const ROLES = {
  sync: () => import('./sync/index'),
  backfill: () => import('./backfill/index'),
  scheduler: () => import('./scheduler/index'),
  agents: () => import('./agents/index'),
  executor: () => import('./executor/index'),
  notifier: () => import('./notifier/index'),
} as const;
type Role = keyof typeof ROLES;

const log = createLogger('workers');
const arg = process.argv[2] ?? 'all';
const roles: Role[] = arg === 'all' ? (Object.keys(ROLES) as Role[]) : [arg as Role];

const running: Closable[] = [];
for (const role of roles) {
  const load = ROLES[role];
  if (!load) {
    log.error({ role }, 'unknown worker role');
    process.exit(1);
  }
  const mod = await load();
  running.push(...mod.start());
  log.info({ role }, 'worker started');
}

async function shutdown() {
  log.info('shutting down');
  await Promise.allSettled(running.map((w) => w.close()));
  await closeQueues();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
