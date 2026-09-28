// Entrypoint for apps/mcp: the remote MCP server (see README.md).
import { closeDb, getDb } from '@hub/db';
import { closeQueues, createLogger, enqueue, env, publishLive } from '@hub/server';
import { keyProvider } from '@hub/server/secrets';
import { buildMcpApp } from './app';

const e = env();
const logger = createLogger('mcp');
const app = buildMcpApp({
  db: getDb(),
  secrets: keyProvider(),
  enqueue: (name, data, opts) => enqueue(name, data, opts),
  publishLive,
  publicUrl: e.PUBLIC_MCP_URL,
  logger,
});

const server = app.listen(e.MCP_PORT, () => {
  logger.info({ port: e.MCP_PORT, url: e.PUBLIC_MCP_URL }, 'mcp listening');
});

async function shutdown() {
  server.close();
  await Promise.allSettled([closeDb(), closeQueues()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
