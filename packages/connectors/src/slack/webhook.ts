import { z } from 'zod';
import { hmacHex, header, safeEqual } from '../lib/crypto';
import type { VerifyResult, WebhookEvent, WebhookRequest } from '../types';
import { isNoise } from './normalize';

/** Slack signs every request; requests older than this are replays. */
export const MAX_SKEW_SECONDS = 5 * 60;

/** `v0=` + HMAC-SHA256(secret, `v0:<timestamp>:<raw body>`), hex. */
export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${hmacHex('sha256', secret, `v0:${timestamp}:${rawBody}`)}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function checkSlackSignature(
  req: Pick<WebhookRequest, 'headers' | 'rawBody'>,
  secrets: string[],
  nowMs = Date.now(),
): SignatureCheck {
  if (secrets.length === 0) return { ok: false, reason: 'signing secret not configured' };
  const sig = header(req.headers, 'x-slack-signature');
  const ts = header(req.headers, 'x-slack-request-timestamp');
  if (!sig || !ts) return { ok: false, reason: 'missing signature' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(nowMs / 1000 - Number(ts)) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale timestamp' };
  }
  const good = secrets.some((s) => safeEqual(slackSignature(s, ts, req.rawBody), sig));
  return good ? { ok: true } : { ok: false, reason: 'bad signature' };
}

const UrlVerification = z.object({ type: z.literal('url_verification'), challenge: z.string() });

const AppRateLimited = z.object({
  type: z.literal('app_rate_limited'),
  team_id: z.string(),
  minute_rate_limited: z.number(),
});

const InnerEvent = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    channel: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    ts: z.string().optional(),
    event_ts: z.string().optional(),
    message: z.object({ ts: z.string().optional() }).loose().optional(),
    tokens: z
      .object({
        oauth: z.array(z.string()).optional(),
        bot: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .loose();

const EventCallback = z.object({
  type: z.literal('event_callback'),
  team_id: z.string().optional(),
  event_id: z.string(),
  event: InnerEvent,
  authorizations: z
    .array(z.object({ team_id: z.string().nullish(), user_id: z.string().optional() }).loose())
    .optional(),
});

/** Message events that never produce an item: skip the sync entirely. */
function skipMessageEvent(e: z.infer<typeof InnerEvent>): boolean {
  if (e.type !== 'message') return false;
  // Edits and deletes: the item already exists (items dedupe on external id).
  if (e.subtype === 'message_changed' || e.subtype === 'message_deleted') return true;
  return isNoise({
    ...(e.subtype ? { subtype: e.subtype } : {}),
    ...(e.bot_id ? { bot_id: e.bot_id } : {}),
    ...(e.user ? { user: e.user } : {}),
  });
}

/**
 * Maps a verified Events API body to webhook events. Payloads carry ids only, never text.
 * - `url_verification`: echo the challenge.
 * - `event_callback`: one event routed by team id, deduped by the gateway on `event_id`
 *   (Slack retries reuse the id, so a retry is dropped there).
 * - `tokens_revoked`: one event per revoked user with `payload.reconnect: true`, routed to
 *   that user's account (`<team>:<user>`). The sync worker marks it `reconnect`; if it
 *   ignores the flag, the next Slack call fails with token_revoked and does the same.
 * - `app_uninstalled`: every account of the team, `reconnect: true`.
 * - `app_rate_limited`: Slack drops events for that minute, so emit one catch-up sync per
 *   team and minute; the search-based delta recovers whatever was dropped.
 */
export function mapSlackBody(body: unknown): VerifyResult {
  const uv = UrlVerification.safeParse(body);
  if (uv.success) {
    return {
      ok: true,
      events: [],
      reply: {
        status: 200,
        contentType: 'application/json',
        body: { challenge: uv.data.challenge },
      },
    };
  }
  const rl = AppRateLimited.safeParse(body);
  if (rl.success) {
    return {
      ok: true,
      events: [
        {
          providerEventId: `app_rate_limited:${rl.data.team_id}:${rl.data.minute_rate_limited}`,
          routeKey: rl.data.team_id,
          source: 'messages',
          payload: { rateLimited: true, minute: rl.data.minute_rate_limited },
        },
      ],
    };
  }
  const cb = EventCallback.safeParse(body);
  if (!cb.success) {
    const type = (body as { type?: unknown } | null)?.type;
    // Unknown envelope types are acknowledged and ignored; malformed bodies are refused.
    return typeof type === 'string' ? { ok: true, events: [] } : { ok: false, reason: 'bad body' };
  }
  const { event, event_id: eventId } = cb.data;
  const teamId = cb.data.team_id ?? cb.data.authorizations?.[0]?.team_id ?? null;
  if (!teamId) return { ok: false, reason: 'event without team' };

  if (event.type === 'tokens_revoked') {
    const users = event.tokens?.oauth ?? [];
    return {
      ok: true,
      events: users.map((u): WebhookEvent => ({
        providerEventId: `${eventId}:${u}`,
        externalAccountId: `${teamId}:${u}`,
        payload: { reconnect: true, reason: 'tokens_revoked' },
      })),
    };
  }
  if (event.type === 'app_uninstalled') {
    return {
      ok: true,
      events: [
        {
          providerEventId: eventId,
          routeKey: teamId,
          payload: { reconnect: true, reason: 'app_uninstalled' },
        },
      ],
    };
  }
  if (skipMessageEvent(event)) return { ok: true, events: [] };

  const ts = event.ts ?? event.message?.ts ?? event.event_ts;
  return {
    ok: true,
    events: [
      {
        providerEventId: eventId,
        routeKey: teamId,
        source: 'messages',
        payload: {
          type: event.type,
          ...(event.channel ? { channel: event.channel } : {}),
          ...(ts ? { ts } : {}),
        },
      },
    ],
  };
}

/** Parses the signed raw bytes (what the signature covers); falls back to the parsed body. */
export function parseBody(req: Pick<WebhookRequest, 'body' | 'rawBody'>): unknown {
  try {
    return JSON.parse(req.rawBody);
  } catch {
    return req.body && typeof req.body === 'object' ? req.body : null;
  }
}
