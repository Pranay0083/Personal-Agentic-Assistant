import { createHmac, randomBytes } from 'node:crypto';
import { ConnectorError } from '../errors';
import { header, newSubscriptionSecret, safeEqual, sha256Hex } from '../lib/crypto';
import type { SubscriptionInfo, VerifyResult, WebhookRequest } from '../types';
import type { RegisteredWebhook, WebhookList, WebhookRegistration } from './api-types';
import { PROVIDER, type AtlassianClient } from './client';
import { startCursor } from './cursor';

/**
 * Jira dynamic webhooks for an OAuth 2.0 (3LO) app.
 *
 * Authentication (two independent checks, both required):
 * 1. Atlassian signs every delivery to an OAuth 2.0 app with a JWT in `Authorization:
 *    Bearer`, HS256 with the app's client secret. We verify the signature, the algorithm
 *    and `exp`/`nbf` when present. That proves the delivery came from Atlassian for *our
 *    app*, but not for which user.
 * 2. The registered URL is `<gateway>/hooks/atlassian?sub=<subId>&t=<secret>`. `sub` is the
 *    subscription's external id (routing), `t` a random per-subscription secret whose
 *    sha256 is stored as `subscriptions.meta.secretHash`; the gateway compares it. The
 *    secret itself is stored nowhere on our side.
 *
 * Webhook JQL filters only support a few fields (`assignee`, `reporter`, `project`,
 * `status`, ...; no `watcher`, no text search) and `=`/`!=`/`IN`/`NOT IN`, so the push
 * covers issues assigned to or reported by the user. Watched issues and mentions are
 * picked up by the delta query on the next sync (every push or catch-up syncs them all).
 * Limit: 5 webhooks per app per user per site; we use 2. They expire after 30 days;
 * `renew` extends them with `PUT /rest/api/3/webhook/refresh`.
 */

export const WEBHOOK_EVENTS = [
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
  'comment_created',
  'comment_updated',
];

export const WEBHOOK_TTL_MS = 30 * 86400_000;

export function webhookFilters(accountId: string): string[] {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId))
    throw new ConnectorError(PROVIDER, 'bad Atlassian account id');
  return [`assignee = "${accountId}"`, `reporter = "${accountId}"`];
}

export function webhookUrl(gatewayUrl: string, subId: string, secret: string): string {
  const u = new URL(`${gatewayUrl.replace(/\/$/, '')}/hooks/atlassian`);
  u.searchParams.set('sub', subId);
  u.searchParams.set('t', secret);
  return u.toString();
}

export type JiraSubscriptionMeta = {
  secretHash: string;
  webhookIds: number[];
  cloudId: string;
};

export async function registerWebhooks(
  api: AtlassianClient,
  o: { gatewayUrl: string; cloudId: string; accountId: string; now: number },
): Promise<SubscriptionInfo> {
  const subId = `atl_${randomBytes(12).toString('base64url')}`;
  const { secret, secretHash } = newSubscriptionSecret();
  const res = await api.jira<WebhookRegistration>('/webhook', {
    method: 'POST',
    body: {
      url: webhookUrl(o.gatewayUrl, subId, secret),
      webhooks: webhookFilters(o.accountId).map((jqlFilter) => ({
        jqlFilter,
        events: WEBHOOK_EVENTS,
      })),
    },
  });
  const webhookIds = (res?.webhookRegistrationResult ?? [])
    .map((r) => r.createdWebhookId)
    .filter((id): id is number => typeof id === 'number');
  if (!webhookIds.length) throw new ConnectorError(PROVIDER, 'webhook registration failed');
  const meta: JiraSubscriptionMeta = { secretHash, webhookIds, cloudId: o.cloudId };
  return {
    externalSubId: subId,
    expiresAt: new Date(o.now + WEBHOOK_TTL_MS),
    cursor: startCursor(o.now),
    meta,
  };
}

export async function listWebhooks(api: AtlassianClient): Promise<RegisteredWebhook[]> {
  const out: RegisteredWebhook[] = [];
  for (let startAt = 0, i = 0; i < 20; i++) {
    const page = await api.jira<WebhookList>('/webhook', { query: { startAt, maxResults: 100 } });
    out.push(...(page.values ?? []));
    if (page.isLast !== false || !page.values?.length) break;
    startAt += page.values.length;
  }
  return out;
}

/** Extends the webhooks by 30 days. Returns the new expiry (Jira's, or now + 30d). */
export async function refreshWebhooks(
  api: AtlassianClient,
  webhookIds: number[],
  now: number,
): Promise<Date> {
  const res = await api.jira<{ expirationDate?: string } | null>('/webhook/refresh', {
    method: 'PUT',
    body: { webhookIds },
  });
  const at = res?.expirationDate ? Date.parse(res.expirationDate) : NaN;
  return new Date(Number.isFinite(at) ? at : now + WEBHOOK_TTL_MS);
}

export async function deleteWebhooks(api: AtlassianClient, webhookIds: number[]): Promise<void> {
  if (!webhookIds.length) return;
  await api.jira('/webhook', { method: 'DELETE', body: { webhookIds }, allow: [404] });
}

export function webhookIdsOf(meta: Record<string, unknown> | undefined): number[] {
  const ids = meta?.webhookIds;
  return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === 'number') : [];
}

// ---------------------------------------------------------------------------------------
// JWT (HS256) for webhook deliveries.

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(
  token: string,
  secret: string,
  now = Date.now(),
): { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [h, p, s] = parts as [string, string, string];
  let head: { alg?: string };
  let claims: Record<string, unknown>;
  try {
    head = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  if (head.alg !== 'HS256') return { ok: false, reason: 'unexpected token algorithm' };
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (!safeEqual(expected, s)) return { ok: false, reason: 'bad token signature' };
  const leeway = 60;
  const sec = Math.floor(now / 1000);
  if (typeof claims.exp === 'number' && claims.exp + leeway < sec)
    return { ok: false, reason: 'token expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > sec)
    return { ok: false, reason: 'token not yet valid' };
  return { ok: true, claims };
}

type JiraWebhookBody = {
  webhookEvent?: string;
  timestamp?: number;
  matchedWebhookIds?: number[];
  issue?: { id?: string; key?: string };
};

export function verifyJiraWebhook(
  req: WebhookRequest,
  signingSecret: string | undefined,
  now = Date.now(),
): VerifyResult {
  if (!signingSecret) return { ok: false, reason: 'webhook verification not configured' };
  const sub = req.query?.sub;
  const t = req.query?.t;
  if (!sub || !/^atl_[A-Za-z0-9_-]{8,64}$/.test(sub) || !t)
    return { ok: false, reason: 'missing subscription' };
  const auth = header(req.headers, 'authorization');
  const m = auth ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
  if (!m) return { ok: false, reason: 'missing bearer token' };
  const jwt = verifyJwt(m[1]!, signingSecret, now);
  if (!jwt.ok) return jwt;

  const body = (
    req.body && typeof req.body === 'object' ? req.body : safeParse(req.rawBody)
  ) as JiraWebhookBody | null;
  if (!body || typeof body.webhookEvent !== 'string') return { ok: false, reason: 'bad payload' };

  // Same identifier on every retry of one delivery.
  const deliveryId =
    header(req.headers, 'x-atlassian-webhook-identifier') ??
    sha256Hex(req.rawBody || JSON.stringify(body)).slice(0, 32);
  const retry = header(req.headers, 'x-atlassian-webhook-retry');
  const payload: Record<string, unknown> = { webhookEvent: body.webhookEvent };
  if (body.issue?.key && /^[A-Z][A-Z0-9_]+-\d+$/.test(body.issue.key))
    payload.issueKey = body.issue.key;
  if (body.issue?.id) payload.issueId = String(body.issue.id);
  if (Array.isArray(body.matchedWebhookIds))
    payload.matchedWebhookIds = body.matchedWebhookIds.filter((x) => typeof x === 'number');
  if (typeof body.timestamp === 'number') payload.timestamp = body.timestamp;
  if (retry) payload.retry = Number(retry) || 0;
  return {
    ok: true,
    events: [
      {
        providerEventId: `jira:${sub}:${deliveryId}`,
        externalSubId: sub,
        source: 'jira',
        subscriptionSecret: t,
        payload,
      },
    ],
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
