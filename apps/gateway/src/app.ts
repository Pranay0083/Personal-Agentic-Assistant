import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { and, arrayContains, asc, eq, ne } from 'drizzle-orm';
import type { Connector, WebhookEvent, WebhookReply } from '@hub/connectors';
import { safeEqual, sha256Hex } from '@hub/connectors/lib';
import { accounts, events, subscriptions, type Db } from '@hub/db';
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

type SubRow = typeof subscriptions.$inferSelect;

/** One account an event is for, with the source subscription it matched (if any). */
export type WebhookTarget = { accountId: string; source?: string; sub?: SubRow };

const live = ne(accounts.status, 'disconnected');
const order = [asc(accounts.createdAt), asc(accounts.id)] as const;

/**
 * Maps an event to accounts of `provider` by exactly one of: `externalAccountId`
 * (accounts.external_id), `routeKey` (accounts.route_keys contains it) or `externalSubId`
 * (a subscriptions row; its `kind` is the source). Disconnected accounts and disabled
 * sources never match. Oldest account first, so dedupe keys stay stable.
 */
export async function resolveTargets(
  db: Db,
  provider: Provider,
  ev: WebhookEvent,
): Promise<WebhookTarget[]> {
  if (ev.externalSubId) {
    const rows = await db
      .select({ accountId: accounts.id, sub: subscriptions })
      .from(subscriptions)
      .innerJoin(accounts, eq(accounts.id, subscriptions.accountId))
      .where(
        and(
          eq(subscriptions.externalSubId, ev.externalSubId),
          eq(subscriptions.enabled, true),
          eq(accounts.provider, provider),
          live,
        ),
      )
      .orderBy(...order);
    return rows.map((r) => ({ accountId: r.accountId, source: r.sub.kind, sub: r.sub }));
  }
  let by;
  if (ev.externalAccountId) by = eq(accounts.externalId, ev.externalAccountId);
  else if (ev.routeKey) by = arrayContains(accounts.routeKeys, [ev.routeKey]);
  else return [];
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), by, live))
    .orderBy(...order);
  if (!ev.subscriptionSecret || !ev.source) {
    return rows.map((r) => ({ accountId: r.id, ...(ev.source ? { source: ev.source } : {}) }));
  }
  // A secret to check: find each account's subscription for the event's source.
  const out: WebhookTarget[] = [];
  for (const r of rows) {
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.accountId, r.id), eq(subscriptions.kind, ev.source)));
    out.push({ accountId: r.id, source: ev.source, ...(sub ? { sub } : {}) });
  }
  return out;
}

const secretHashOf = (sub: SubRow | undefined): string | null => {
  const m = sub?.meta as Record<string, unknown> | null | undefined;
  return typeof m?.secretHash === 'string' ? m.secretHash : null;
};

/**
 * The shared-secret check. An event carrying `subscriptionSecret` must match the matched
 * subscription's `meta.secretHash` (sha256 hex, constant-time compare). A subscription that
 * registered a secret also refuses events that arrive without one.
 */
export function secretMatches(ev: WebhookEvent, target: WebhookTarget): boolean {
  const stored = secretHashOf(target.sub);
  if (ev.subscriptionSecret === undefined) return stored === null;
  if (!stored) return false;
  return safeEqual(sha256Hex(ev.subscriptionSecret), stored.toLowerCase());
}

function flatQuery(q: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!q || typeof q !== 'object') return out;
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === 'string') out[k] = first;
  }
  return out;
}

/** Handshake echo: text as-is (Graph validationToken must be text/plain), objects as JSON. */
function sendReply(reply: FastifyReply, r: WebhookReply) {
  reply.code(r.status ?? 200);
  if (typeof r.body === 'string') {
    return reply.type(r.contentType ?? 'text/plain; charset=utf-8').send(r.body);
  }
  return reply
    .type(r.contentType ?? 'application/json; charset=utf-8')
    .send(JSON.stringify(r.body));
}

/**
 * Webhook receiver on `/hooks/:provider` and `/hooks/:provider/:channel` (GET and POST).
 * Verifies with the connector, answers handshakes, maps each event to every matching
 * account (by external id, route key or subscription), checks subscription secrets,
 * dedupes on provider_event_id, enqueues sync for new events only, and answers fast.
 * No provider calls, no content handling.
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
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      req.rawBody = raw;
      done(null, Object.fromEntries(new URLSearchParams(raw)));
    },
  );
  app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    done(null, raw);
  });

  app.get('/healthz', async () => ({ ok: true }));

  const handler = async (
    req: FastifyRequest<{ Params: { provider: string; channel?: string } }>,
    reply: FastifyReply,
  ) => {
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
      method: req.method,
      headers: req.headers,
      query: flatQuery(req.query),
      channel: req.params.channel ?? null,
      body: req.body ?? {},
      rawBody: req.rawBody ?? '',
    });
    if (!verified.ok) {
      // Reason only: never the token or the body.
      req.log.warn({ provider, reason: verified.reason }, 'webhook verification failed');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    let created = 0;
    let unknown = 0;
    let rejected = 0;
    for (const ev of verified.events) {
      const targets = await resolveTargets(deps.db, provider, ev);
      if (targets.length === 0) {
        unknown++;
        continue;
      }
      let index = 0;
      for (const target of targets) {
        if (!secretMatches(ev, target)) {
          // Ids only: never the secret, its hash or the payload.
          req.log.warn(
            { provider, accountId: target.accountId, subscriptionId: target.sub?.id ?? null },
            'webhook subscription secret mismatch',
          );
          rejected++;
          continue;
        }
        const [row] = await deps.db
          .insert(events)
          .values({
            accountId: target.accountId,
            provider,
            providerEventId: providerEventKey(
              provider,
              ev.providerEventId,
              target.accountId,
              index,
            ),
            payload: ev.payload,
            status: 'received',
          })
          .onConflictDoNothing({ target: events.providerEventId })
          .returning({ id: events.id });
        index++;
        if (!row) continue; // duplicate delivery
        const source = target.source ?? ev.source;
        try {
          await deps.enqueue(QUEUES.sync, {
            accountId: target.accountId,
            ...(source ? { source } : {}),
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
      { provider, events: verified.events.length, created, unknown, rejected },
      'webhook accepted',
    );
    if (verified.reply) return sendReply(reply, verified.reply);
    return reply.code(204).send();
  };

  for (const url of ['/hooks/:provider', '/hooks/:provider/:channel']) {
    app.route({ method: ['GET', 'POST'], url, handler });
  }

  return app;
}
