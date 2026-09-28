import { ConnectorError } from '../errors';
import { newSubscriptionSecret } from '../lib/index';
import type { ConnectorContext, SubscriptionInfo } from '../types';
import { notificationUrl, type MicrosoftConfig } from './config';
import type { Graph } from './graph';
import type { GraphSubscription } from './graph-types';

/**
 * Graph change-notification subscriptions, one per (account, source). Notifications carry
 * ids only (no `includeResourceData`, so no encryption certificate); the sync worker then
 * pulls the delta. Lifecycle notifications go to the same URL (Graph allows it), so the
 * gateway needs one route.
 */
type SubSpec = {
  resource: (ctx: ConnectorContext) => string;
  changeType: string;
  /** Graph maximum, minus a safety margin. */
  maxMinutes: number;
};

const MARGIN_MIN = 15;

export const SUBSCRIPTION_SPECS: Record<string, SubSpec | null> = {
  // Outlook message/event: 10,080 minutes (under 7 days).
  mail: { resource: () => '/me/messages', changeType: 'created', maxMinutes: 10_080 - MARGIN_MIN },
  calendar: {
    resource: () => '/me/events',
    changeType: 'created,updated,deleted',
    maxMinutes: 10_080 - MARGIN_MIN,
  },
  // Teams chatMessage: 4,320 minutes; >1h requires lifecycleNotificationUrl. Delegated
  // Chat.Read supports the user-level resource (work/school accounts only).
  teams: {
    resource: (ctx) => `/users/${ctx.externalId}/chats/getAllMessages`,
    changeType: 'created,updated',
    maxMinutes: 4_320 - MARGIN_MIN,
  },
  // No delegated subscription covers all channels; the source is polled.
  channels: null,
  // driveItem: 42,300 minutes; drive root supports only `updated`.
  onedrive: {
    resource: () => '/me/drive/root',
    changeType: 'updated',
    maxMinutes: 42_300 - MARGIN_MIN,
  },
};

const noSubscription = (reason: string): SubscriptionInfo => ({
  externalSubId: null,
  expiresAt: null,
  meta: { unsupported: reason },
});

function expiry(cfg: MicrosoftConfig, spec: SubSpec) {
  return new Date((cfg.now?.() ?? Date.now()) + spec.maxMinutes * 60_000);
}

export function specFor(ctx: ConnectorContext): SubSpec | null {
  return SUBSCRIPTION_SPECS[ctx.source ?? 'mail'] ?? null;
}

export async function createSubscription(
  cfg: MicrosoftConfig,
  graph: Graph,
  ctx: ConnectorContext,
): Promise<SubscriptionInfo> {
  const spec = specFor(ctx);
  if (!spec) return noSubscription('polled');
  if (ctx.meta?.personal === true && (ctx.source === 'teams' || ctx.source === 'channels')) {
    return noSubscription('personal account');
  }
  const url = notificationUrl(cfg);
  if (!cfg.fake && !url.startsWith('https://')) {
    // Graph refuses non-HTTPS endpoints; in local dev use a tunnel (see report / README).
    throw new ConnectorError('microsoft', 'PUBLIC_GATEWAY_URL must be https for Graph');
  }
  const { secret, secretHash } = newSubscriptionSecret();
  const resource = spec.resource(ctx);
  const body = {
    changeType: spec.changeType,
    notificationUrl: url,
    lifecycleNotificationUrl: url,
    resource,
    expirationDateTime: expiry(cfg, spec).toISOString(),
    clientState: secret,
    latestSupportedTlsVersion: 'v1_2',
  };
  let sub: GraphSubscription;
  try {
    // Graph calls the endpoint with ?validationToken= before this returns (10 s budget).
    sub = await graph.request<GraphSubscription>('/subscriptions', { method: 'POST', body });
  } catch (e) {
    // The user-level chat subscription can be refused (tenant policy, licensing, not yet
    // on v1.0 in some clouds). Teams still syncs on the scheduler's catch-up polls.
    if (
      ctx.source === 'teams' &&
      e instanceof ConnectorError &&
      [400, 403, 404].includes(e.status ?? 0)
    ) {
      return noSubscription('refused by Graph; polled');
    }
    throw e;
  }
  return {
    externalSubId: sub.id,
    expiresAt: new Date(sub.expirationDateTime),
    meta: { secretHash, resource, changeType: spec.changeType },
  };
}

/**
 * Extends the subscription (PATCH also reauthorizes it, per Graph's lifecycle guidance).
 * A subscription Graph removed (404) is recreated with a new id and secret, which covers
 * `subscriptionRemoved`. The caller stores whatever this returns.
 */
export async function renewSubscription(
  cfg: MicrosoftConfig,
  graph: Graph,
  ctx: ConnectorContext,
): Promise<SubscriptionInfo> {
  const spec = specFor(ctx);
  const id = ctx.subscription?.externalSubId;
  if (!spec || !id) return createSubscription(cfg, graph, ctx);
  const res = await graph.request<GraphSubscription | null>(
    `/subscriptions/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: { expirationDateTime: expiry(cfg, spec).toISOString() },
      allow: [404],
    },
  );
  if (!res) return createSubscription(cfg, graph, ctx);
  return {
    externalSubId: res.id ?? id,
    expiresAt: new Date(res.expirationDateTime),
    meta: { ...(ctx.subscription?.meta ?? {}) },
  };
}

export async function deleteSubscription(graph: Graph, ctx: ConnectorContext): Promise<void> {
  const id = ctx.subscription?.externalSubId;
  if (!id) return;
  await graph.request(`/subscriptions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    allow: [404],
  });
}
