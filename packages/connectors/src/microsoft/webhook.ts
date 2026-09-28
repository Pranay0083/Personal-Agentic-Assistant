import { sha256Hex } from '../lib/index';
import type { VerifyResult, WebhookEvent, WebhookRequest } from '../types';
import type { GraphChangeNotification } from './graph-types';

/**
 * Graph webhooks (change and lifecycle notifications share one URL).
 *
 * - Validation handshake: Graph POSTs `?validationToken=<token>` when a subscription is
 *   created; we must answer 200 text/plain with the token (URL-decoded) within 10 s.
 * - Notifications: `{ value: [...] }`. Each one carries `clientState`, the random secret we
 *   registered; the gateway compares its sha256 with `subscriptions.meta.secretHash` of the
 *   subscription matched by `subscriptionId`, which is what Microsoft recommends for
 *   notifications without resource data. (Rich notifications would add `validationTokens`
 *   JWTs; we never request resource data, so there are none.) Entries without a
 *   clientState are dropped here.
 * - Answer 202 quickly; the body is ignored by Graph.
 *
 * Event payloads hold ids only.
 */

const MAX_VALIDATION_TOKEN = 2048;

function queryParam(req: WebhookRequest, name: string): string | undefined {
  const direct = req.query?.[name];
  if (typeof direct === 'string') return direct;
  return undefined;
}

/** `Users/{id}/Messages/{id}` → mail, `Users/{id}/Events/{id}` → calendar, … */
export function sourceOfResource(resource: string | undefined): string | undefined {
  if (!resource) return undefined;
  const r = resource.toLowerCase();
  if (/(^|\/)chats(\(|\/)/.test(r) || r.includes('getallmessages')) return 'teams';
  if (/(^|\/)teams(\(|\/)/.test(r) && r.includes('channels')) return 'channels';
  if (/(^|\/)(messages|mailfolders)(\(|\/|$)/.test(r)) return 'mail';
  if (/(^|\/)(events|calendars?|calendarview)(\(|\/|$)/.test(r)) return 'calendar';
  if (/(^|\/)drives?(\(|\/|$)/.test(r)) return 'onedrive';
  return undefined;
}

const LIFECYCLE = new Set(['reauthorizationRequired', 'subscriptionRemoved', 'missed']);

/** Coarse bucket so identical id-less notifications minutes apart still sync (dedupe window). */
const bucket = (now: number) => Math.floor(now / 60_000);

function eventFor(n: GraphChangeNotification, now: number): WebhookEvent | null {
  if (!n.subscriptionId || typeof n.clientState !== 'string' || !n.clientState) return null;
  const base = {
    externalSubId: n.subscriptionId,
    subscriptionSecret: n.clientState,
  };
  if (n.lifecycleEvent) {
    if (!LIFECYCLE.has(n.lifecycleEvent)) return null;
    // reauthorizationRequired → renew (PATCH also reauthorizes); subscriptionRemoved →
    // renew, which recreates on 404; missed → a normal delta from the stored cursor
    // recovers everything (delta sources) or the watermark does (teams).
    const action =
      n.lifecycleEvent === 'missed'
        ? { fullDelta: true }
        : n.lifecycleEvent === 'subscriptionRemoved'
          ? { resubscribe: true, fullDelta: true }
          : { renew: true };
    return {
      ...base,
      providerEventId: `lc:${sha256Hex(
        [
          n.subscriptionId,
          n.lifecycleEvent,
          n.subscriptionExpirationDateTime ?? '',
          bucket(now),
        ].join('|'),
      ).slice(0, 40)}`,
      payload: {
        subscriptionId: n.subscriptionId,
        lifecycleEvent: n.lifecycleEvent,
        ...action,
        ...(n.tenantId ? { tenantId: n.tenantId } : {}),
      },
    };
  }
  const source = sourceOfResource(n.resource ?? n.resourceData?.['@odata.id']);
  const resourceId = n.resourceData?.id;
  const etag = n.resourceData?.['@odata.etag'];
  // Unique per change: Graph's notification id when present, else the resource version.
  const identity = n.id ?? etag ?? String(bucket(now));
  return {
    ...base,
    ...(source ? { source } : {}),
    providerEventId: `n:${sha256Hex(
      [n.subscriptionId, n.changeType ?? '', resourceId ?? n.resource ?? '', identity].join('|'),
    ).slice(0, 40)}`,
    payload: {
      subscriptionId: n.subscriptionId,
      ...(n.changeType ? { changeType: n.changeType } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(n.tenantId ? { tenantId: n.tenantId } : {}),
    },
  };
}

export function verifyGraphWebhook(req: WebhookRequest, now = Date.now()): VerifyResult {
  const token = queryParam(req, 'validationToken');
  if (token !== undefined) {
    if (!token || token.length > MAX_VALIDATION_TOKEN) {
      return { ok: false, reason: 'bad validation token' };
    }
    return { ok: true, events: [], reply: { status: 200, contentType: 'text/plain', body: token } };
  }
  const body = req.body as { value?: unknown } | null;
  if (!body || typeof body !== 'object' || !Array.isArray(body.value)) {
    return { ok: false, reason: 'bad notification body' };
  }
  const events: WebhookEvent[] = [];
  let dropped = 0;
  for (const raw of body.value as GraphChangeNotification[]) {
    const ev = raw && typeof raw === 'object' ? eventFor(raw, now) : null;
    if (ev) events.push(ev);
    else dropped++;
  }
  if (events.length === 0 && dropped > 0) return { ok: false, reason: 'no valid notifications' };
  return { ok: true, events, reply: { status: 202, body: '' } };
}
