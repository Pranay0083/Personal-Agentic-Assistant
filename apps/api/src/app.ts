import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerAuthHook } from './auth';
import { makeCtx } from './context';
import type { ApiDeps } from './deps';
import { registerErrorHandling } from './http';
import { accountRoutes } from './routes/accounts';
import { activityRoutes } from './routes/activity';
import { approvalRoutes } from './routes/approvals';
import { askRoutes } from './routes/ask';
import { authRoutes } from './routes/auth';
import { controlRoutes } from './routes/control';
import { eventRoutes } from './routes/events';
import { itemRoutes } from './routes/items';
import { mcpRoutes } from './routes/mcp';
import { meRoutes } from './routes/me';
import { modelRoutes } from './routes/models';
import { permissionRoutes } from './routes/permissions';
import { taskRoutes } from './routes/tasks';
import { todayRoutes } from './routes/today';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    ...(deps.logger
      ? { loggerInstance: deps.logger as unknown as FastifyBaseLogger }
      : { logger: false }),
    // Default request logs include the full URL, and SSE may carry ?token=. We log our own line.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
  });

  // Empty JSON bodies (e.g. POST /control/pause with a content-type header) parse as {}.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('body is not valid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cors, {
    // Native apps send no Origin. In development allow Expo web on any localhost port.
    origin: deps.config.production ? false : LOCAL_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-timezone'],
    maxAge: 600,
  });

  app.addHook('onResponse', async (req, reply) => {
    // Route pattern only: never query strings (tokens) or bodies (message text).
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  registerErrorHandling(app);
  registerAuthHook(app, deps.db, deps.now);

  const ctx = makeCtx(deps, (msg, extra) => app.log.warn(extra ?? {}, msg));

  app.get('/healthz', async () => ({ ok: true }));
  authRoutes(app, ctx);
  meRoutes(app, ctx);
  accountRoutes(app, ctx);
  itemRoutes(app, ctx);
  taskRoutes(app, ctx);
  todayRoutes(app, ctx);
  approvalRoutes(app, ctx);
  permissionRoutes(app, ctx);
  controlRoutes(app, ctx);
  modelRoutes(app, ctx);
  mcpRoutes(app, ctx);
  activityRoutes(app, ctx);
  askRoutes(app, ctx);
  eventRoutes(app, ctx);

  return app;
}
