import { randomBytes } from 'node:crypto';
import { header, newSubscriptionSecret, safeEqual, sha256Hex } from '../lib/crypto';
import type { ConnectorContext, SubscriptionInfo, VerifyResult, WebhookRequest } from '../types';
import { httpStatusOf } from './client';
import { CALENDAR_ID } from './calendar';
import { DRIVE_CHANGE_PARAMS } from './drive';
import { GOOGLE_API, type GoogleRest } from './rest';

/**
 * Calendar and Drive push notifications ("watch" channels). Each channel gets a random
 * token from newSubscriptionSecret(); Google echoes it in X-Goog-Channel-Token and the
 * gateway compares its sha256 with subscriptions.meta.secretHash. Only the hash is
 * stored. Channels expire and cannot be extended, so renew = watch a new one + stop the old.
 */

export type ChannelSource = 'calendar' | 'drive';

export type GoogleChannel = {
  kind?: string;
  id: string;
  resourceId?: string;
  resourceUri?: string;
  token?: string;
  expiration?: string;
};

/** Channel id prefix tells the source apart when a push arrives. */
export const CHANNEL_PREFIX: Record<ChannelSource, string> = {
  calendar: 'hubcal-',
  drive: 'hubdrv-',
};
/** Asked-for lifetime. Google caps it (Drive changes: 1 week) and returns the real expiry. */
export const CHANNEL_TTL_MS = 7 * 86400_000;
export const CHANNEL_HOOK_PATH = '/hooks/gmail/channel';

const WATCH_URL: Record<ChannelSource, string> = {
  calendar: `${GOOGLE_API.calendar}/calendars/${CALENDAR_ID}/events/watch`,
  drive: `${GOOGLE_API.drive}/changes/watch`,
};
const STOP_URL: Record<ChannelSource, string> = {
  calendar: `${GOOGLE_API.calendar}/channels/stop`,
  drive: `${GOOGLE_API.drive}/channels/stop`,
};

/** The push address, or null when channels can't be used (Google requires https). */
export function channelAddress(gatewayUrl: string | undefined, fake: boolean): string | null {
  const base = (gatewayUrl ?? (fake ? 'http://localhost:4001' : '')).replace(/\/$/, '');
  if (!base) return null;
  if (!fake && !base.startsWith('https://')) return null;
  return `${base}${CHANNEL_HOOK_PATH}`;
}

export async function watchChannel(
  rest: GoogleRest,
  source: ChannelSource,
  opts: { address: string; pageToken?: string },
  now = Date.now(),
): Promise<SubscriptionInfo> {
  const { secret, secretHash } = newSubscriptionSecret();
  const id = `${CHANNEL_PREFIX[source]}${randomBytes(12).toString('hex')}`;
  const ch = await rest<GoogleChannel>({
    method: 'POST',
    url: WATCH_URL[source],
    params: source === 'drive' ? { pageToken: opts.pageToken, ...DRIVE_CHANGE_PARAMS } : undefined,
    data: {
      id,
      type: 'web_hook',
      address: opts.address,
      token: secret,
      expiration: String(now + CHANNEL_TTL_MS),
    },
  });
  const exp = Number(ch.expiration);
  return {
    externalSubId: ch.id ?? id,
    expiresAt: Number.isFinite(exp) && exp > 0 ? new Date(exp) : null,
    meta: { secretHash, resourceId: ch.resourceId ?? null, channel: source },
  };
}

/** Stops the context's current channel. Already-gone channels (404) are fine. */
export async function stopChannel(
  rest: GoogleRest,
  source: ChannelSource,
  sub: ConnectorContext['subscription'],
): Promise<void> {
  const id = sub?.externalSubId;
  const resourceId = sub?.meta?.resourceId;
  if (!id || typeof resourceId !== 'string') return;
  try {
    await rest({ method: 'POST', url: STOP_URL[source], data: { id, resourceId } });
  } catch (e) {
    if (httpStatusOf(e) !== 404) throw e;
  }
}

/** What the gateway does with `subscriptionSecret`; exported for tests and callers. */
export function channelSecretMatches(
  meta: Record<string, unknown> | null | undefined,
  token: string | null | undefined,
): boolean {
  const hash = meta?.secretHash;
  if (typeof hash !== 'string' || !token) return false;
  return safeEqual(sha256Hex(token), hash);
}

/**
 * Parses a Calendar/Drive channel notification (headers only, no body). The `sync`
 * handshake sent when a channel opens is acknowledged with no events.
 */
export function verifyChannelPush(req: WebhookRequest): VerifyResult {
  const channelId = header(req.headers, 'x-goog-channel-id');
  const token = header(req.headers, 'x-goog-channel-token');
  const state = header(req.headers, 'x-goog-resource-state');
  const number = header(req.headers, 'x-goog-message-number') ?? '0';
  if (!channelId || !state) return { ok: false, reason: 'missing channel headers' };
  if (!token) return { ok: false, reason: 'missing channel token' };
  const source = (Object.keys(CHANNEL_PREFIX) as ChannelSource[]).find((s) =>
    channelId.startsWith(CHANNEL_PREFIX[s]),
  );
  if (!source || !/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) {
    return { ok: false, reason: 'unknown channel' };
  }
  if (state === 'sync') return { ok: true, events: [] };
  return {
    ok: true,
    events: [
      {
        providerEventId: `ch:${channelId}:${number}`,
        externalSubId: channelId,
        source,
        subscriptionSecret: token,
        payload: { channelId, resourceState: state, messageNumber: number },
      },
    ],
  };
}
