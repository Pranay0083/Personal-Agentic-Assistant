// Entrypoint for apps/gateway. See docs/ARCHITECTURE.md and apps/gateway/README.md.
import { getConnector } from '@hub/connectors';
import { closeDb, getDb } from '@hub/db';
import { closeQueues, createLogger, enqueue, env } from '@hub/server';
import { buildGateway } from './app';

const e = env();
const log = createLogger('gateway');
const app = buildGateway({
  db: getDb(),
  enqueue: (q, data, opts) => enqueue(q, data, opts),
  getConnector,
  logger: log,
});

await app.listen({ port: e.GATEWAY_PORT, host: '0.0.0.0' });
log.info({ port: e.GATEWAY_PORT, gmailFake: e.GMAIL_FAKE }, 'gateway listening');

async function shutdown() {
  await app.close();
  await closeQueues();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
