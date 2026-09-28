// Entrypoint for apps/api. See docs/ARCHITECTURE.md.
import { getConnector } from '@hub/connectors';
import { createDb } from '@hub/db';
import { createRouter } from '@hub/models';
import { closeQueues, createLogger, enqueue, env, publishLive, subscribeLive } from '@hub/server';
import { keyProvider, SecretStore } from '@hub/server/secrets';
import { buildApi } from './app';
import { configFromEnv } from './deps';

const e = env();
const logger = createLogger('api');
const { db, close } = createDb(e.DATABASE_URL);
const keys = keyProvider();
const secrets = new SecretStore(db, keys);

const app = await buildApi({
  db,
  secrets,
  keys,
  enqueue,
  publishLive,
  subscribeLive,
  // Throws for unsupported providers; the API turns that into 400 unsupported_provider.
  getConnector,
  router: createRouter({ db, secrets }),
  now: () => new Date(),
  config: configFromEnv(e),
  logger,
});

await app.listen({ port: e.API_PORT, host: '0.0.0.0' });

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await closeQueues();
  await close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
