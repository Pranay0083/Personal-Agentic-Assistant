import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context';

/** SSE relay of live events (ids only) for the session user. */
export function eventRoutes(app: FastifyInstance, ctx: Ctx) {
  const heartbeatMs = ctx.heartbeatMs ?? 25_000;

  app.get('/events', (req, reply) => {
    const userId = req.auth.userId;
    reply.hijack();
    const res = reply.raw;
    // Keep headers set by hooks (CORS) since hijack bypasses Fastify's send pipeline.
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v;
    res.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    let closed = false;
    const unsubscribe = ctx.subscribeLive(userId, (event) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, heartbeatMs);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    // res 'close' (not req 'close', which fires once the request is read) = client went away.
    res.on('close', cleanup);
    res.on('error', cleanup);
  });
}
