import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Connector } from '@hub/connectors';
import { accounts, events, type Db } from '@hub/db';
import type { enqueue } from '@hub/server';
import { Provider } from '@hub/shared';
import { QUEUES, type QueueName, type SyncJob } from '@hub/shared/queues';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact request body as received (HMAC schemes such as Slack's sign the raw bytes). */
    rawBody?: string;
  }
}

export type GatewayDeps = {
  db: Db;
  enqueue: (
    name: QueueName,
    data: unknown,
    opts?: Parameters<typeof enqueue>[2],
  ) => Promise<unknown>;
  /** Returns the connector or throws/returns undefined for providers not implemented yet. */
  getConnector: (provider: Provider) => Connector | undefined;
  logger?: FastifyBaseLogger | boolean;
  bodyLimit?: number;
};

/**
 * `<provider>:<id>` for the oldest matching account; later accounts (the same address
 * connected by another user) get `<provider>:<id>:<accountId>` so each has its own row
 * under the unique provider_event_id and dedupe stays per account.
 */
export function providerEventKey(provider: string, id: string, accountId: string, index: number) {
  return index === 0 ? `${provider}:${id}` : `${provider}:${id}:${accountId}`;
}

/**
 * Webhook receiver. Verifies with the connector, maps the provider identity to every
 * matching account, dedupes on provider_event_id, enqueues sync for new events only,
 * and answers fast. No provider calls, no content handling.
 */
export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({
    ...(typeof deps.logger === 'object'
      ? { loggerInstance: deps.logger }
      : { logger: deps.logger ?? false }),
    // Default request logs carry method, url and status only (no headers, no body).
    bodyLimit: deps.bodyLimit ?? 1024 * 1024,
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      const err = new Error('invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    done(null, raw);
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.post<{ Params: { provider: string } }>('/hooks/:provider', async (req, reply) => {
    const parsed = Provider.safeParse(req.params.provider);
    let connector: Connector | undefined;
    if (parsed.success) {
      try {
        connector = deps.getConnector(parsed.data);
      } catch {
        connector = undefined;
      }
    }
    if (!parsed.success || !connector) return reply.code(404).send({ error: 'unknown_provider' });
    const provider = parsed.data;

    const verified = await connector.verifyWebhook({
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody ?? '',
    });
    if (!verified.ok) {
      // Reason only: never the token or the body.
      req.log.warn({ provider, reason: verified.reason }, 'webhook verification failed');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    let created = 0;
    let unknown = 0;
    for (const ev of verified.events) {
      const matches = await deps.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, provider),
            eq(accounts.externalId, ev.externalAccountId),
            ne(accounts.status, 'disconnected'),
          ),
        )
        .orderBy(asc(accounts.createdAt), asc(accounts.id));
      if (matches.length === 0) {
        unknown++;
        continue;
      }
      for (const [i, account] of matches.entries()) {
        const [row] = await deps.db
          .insert(events)
          .values({
            accountId: account.id,
            provider,
            providerEventId: providerEventKey(provider, ev.providerEventId, account.id, i),
            payload: ev.payload,
            status: 'received',
          })
          .onConflictDoNothing({ target: events.providerEventId })
          .returning({ id: events.id });
        if (!row) continue; // duplicate delivery
        try {
          await deps.enqueue(QUEUES.sync, {
            accountId: account.id,
            eventId: row.id,
            reason: 'webhook',
          } satisfies SyncJob);
        } catch (e) {
          // Undo so the provider's retry is not swallowed by dedupe.
          await deps.db.delete(events).where(eq(events.id, row.id));
          throw e;
        }
        created++;
      }
    }
    req.log.info(
      { provider, events: verified.events.length, created, unknown },
      'webhook accepted',
    );
    if (verified.reply !== undefined) return reply.code(200).send(verified.reply);
    return reply.code(204).send();
  });

  return app;
}
