import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../errors';
import { safeEqual, sha256Hex } from '../lib/index';
import type { WebhookEvent } from '../types';
import { NOW, fx, replay, testCtx } from './test-helpers';

const req = (body: unknown, query?: Record<string, string>) => ({
  headers: { 'content-type': 'application/json' },
  body,
  rawBody: body === undefined ? '' : JSON.stringify(body),
  ...(query ? { query } : {}),
});

/** What the gateway does with `subscriptionSecret` (it owns the compare). */
const gatewayAccepts = (ev: WebhookEvent, storedHash: string) =>
  !!ev.subscriptionSecret && safeEqual(sha256Hex(ev.subscriptionSecret), storedHash);

describe('verifyWebhook', () => {
  const { connector } = replay({});

  it('echoes validationToken as text/plain on the creation handshake', async () => {
    const token =
      'Validation: Testing client application reachability for subscription Request-Id: 123';
    const r = await connector.verifyWebhook({
      headers: {},
      body: '',
      rawBody: '',
      query: { validationToken: token },
    });
    expect(r).toEqual({
      ok: true,
      events: [],
      reply: { status: 200, contentType: 'text/plain', body: token },
    });
    const empty = await connector.verifyWebhook({
      headers: {},
      body: '',
      rawBody: '',
      query: { validationToken: '' },
    });
    expect(empty.ok).toBe(false);
  });

  it('returns one event per notification with the subscription id, secret and source', async () => {
    const r = await connector.verifyWebhook(req(fx('notification-mail.json')));
    if (!r.ok) throw new Error(r.reason);
    expect(r.reply).toEqual({ status: 202, body: '' });
    expect(r.events.map((e) => [e.externalSubId, e.source, e.subscriptionSecret])).toEqual([
      ['7f105c7d-2dc5-4530-97cd-4e7ae6534c07', 'mail', 'q1w2e3r4t5y6u7i8o9p0q1w2e3r4t5y6'],
      ['a3c1f2e4-0000-4000-8000-00000000c4a7', 'teams', 'z9x8c7v6b5n4m3z9x8c7v6b5n4m3'],
      ['d7e6f5a4-0000-4000-8000-0000000d71fe', 'onedrive', 'd1r2i3v4e5d1r2i3v4e5'],
    ]);
    expect(new Set(r.events.map((e) => e.providerEventId)).size).toBe(3);
    // Ids only: no resource paths with content, never the secret in the payload.
    expect(r.events[0]!.payload).toEqual({
      subscriptionId: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
      changeType: 'created',
      resourceId: 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AIiLKjG2I7E-Xvk-ys6MD0wAAMf9ItAAA',
      tenantId: '2f8e4b1c-7a3d-4e9f-b6c5-1d2e3f4a5b6c',
    });
    expect(JSON.stringify(r.events.map((e) => e.payload))).not.toContain('q1w2e3');
  });

  it('hands the gateway the clientState to compare: good passes, bad is dropped there', async () => {
    const good = sha256Hex('q1w2e3r4t5y6u7i8o9p0q1w2e3r4t5y6');
    const forged = fx<{ value: Record<string, unknown>[] }>('notification-mail.json');
    forged.value[0]!.clientState = 'guessed-secret';
    const ok = await connector.verifyWebhook(req(fx('notification-mail.json')));
    const bad = await connector.verifyWebhook(req(forged));
    if (!ok.ok || !bad.ok) throw new Error('unexpected');
    expect(gatewayAccepts(ok.events[0]!, good)).toBe(true);
    expect(gatewayAccepts(bad.events[0]!, good)).toBe(false);
  });

  it('drops notifications without a clientState and rejects bodies with none valid', async () => {
    const body = fx<{ value: Record<string, unknown>[] }>('notification-mail.json');
    delete body.value[1]!.clientState;
    const r = await connector.verifyWebhook(req(body));
    if (!r.ok) throw new Error(r.reason);
    expect(r.events).toHaveLength(2);
    const none = await connector.verifyWebhook(req({ value: [{ subscriptionId: 'x' }] }));
    expect(none.ok).toBe(false);
    expect((await connector.verifyWebhook(req({ hello: 'world' }))).ok).toBe(false);
  });

  it('dedupes retries of the same change but not different versions', async () => {
    const a = await connector.verifyWebhook(req(fx('notification-mail.json')));
    const b = await connector.verifyWebhook(req(fx('notification-mail.json')));
    const changed = fx<{ value: { resourceData: Record<string, string> }[] }>(
      'notification-mail.json',
    );
    changed.value[0]!.resourceData['@odata.etag'] = 'W/"new-version"';
    const c = await connector.verifyWebhook(req(changed));
    if (!a.ok || !b.ok || !c.ok) throw new Error('unexpected');
    expect(a.events[0]!.providerEventId).toBe(b.events[0]!.providerEventId);
    expect(c.events[0]!.providerEventId).not.toBe(a.events[0]!.providerEventId);
  });

  it('turns lifecycle notifications into sync events with the right follow-up', async () => {
    const r = await connector.verifyWebhook(req(fx('notification-lifecycle.json')));
    if (!r.ok) throw new Error(r.reason);
    expect(r.events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ lifecycleEvent: 'reauthorizationRequired', renew: true }),
      expect.objectContaining({
        lifecycleEvent: 'subscriptionRemoved',
        resubscribe: true,
        fullDelta: true,
      }),
      expect.objectContaining({ lifecycleEvent: 'missed', fullDelta: true }),
    ]);
    expect(r.events.every((e) => e.subscriptionSecret && e.externalSubId)).toBe(true);
    expect(r.events[0]!.providerEventId).toMatch(/^lc:/);
  });
});

describe('subscriptions', () => {
  it('creates a Graph subscription with a random clientState and stores only its hash', async () => {
    const { connector, calls } = replay({
      'POST /v1.0/subscriptions': { status: 201, body: fx('subscription-created.json') },
    });
    const info = await connector.subscribe(testCtx({ source: 'mail' }));
    const sent = JSON.parse(calls[0]!.body!) as Record<string, string>;
    expect(sent).toMatchObject({
      changeType: 'created',
      resource: '/me/messages',
      notificationUrl: 'https://hub.example/hooks/microsoft',
      lifecycleNotificationUrl: 'https://hub.example/hooks/microsoft',
    });
    expect(sent.clientState!.length).toBeGreaterThanOrEqual(32);
    expect(sent.clientState!.length).toBeLessThanOrEqual(128);
    expect(Date.parse(sent.expirationDateTime!) - NOW).toBeLessThanOrEqual(10_080 * 60_000);
    expect(info.externalSubId).toBe('7f105c7d-2dc5-4530-97cd-4e7ae6534c07');
    expect(info.expiresAt!.toISOString()).toBe('2026-10-05T09:45:00.000Z');
    expect(info.meta!.secretHash).toBe(sha256Hex(sent.clientState!));
    expect(JSON.stringify(info)).not.toContain(sent.clientState!);
  });

  it('respects per-resource maximums (Teams 3 days, drive ~30 days)', async () => {
    const { connector, calls } = replay({
      'POST /v1.0/subscriptions': { status: 201, body: fx('subscription-created.json') },
    });
    await connector.subscribe(testCtx({ source: 'teams' }));
    await connector.subscribe(testCtx({ source: 'onedrive' }));
    const [teams, drive] = calls.map((c) => JSON.parse(c.body!) as Record<string, string>);
    expect(teams!.resource).toBe(
      '/users/6b1f3c2a-9d4e-4f7a-8c1b-2e3d4f5a6b7c/chats/getAllMessages',
    );
    expect(Date.parse(teams!.expirationDateTime!) - NOW).toBeLessThanOrEqual(4_320 * 60_000);
    expect(drive!.resource).toBe('/me/drive/root');
    expect(drive!.changeType).toBe('updated');
    expect(Date.parse(drive!.expirationDateTime!) - NOW).toBeLessThanOrEqual(42_300 * 60_000);
    expect(Date.parse(drive!.expirationDateTime!) - NOW).toBeGreaterThan(40_000 * 60_000);
  });

  it('skips Teams for personal accounts and the polled channels source', async () => {
    const { connector, calls } = replay({});
    const personal = await connector.subscribe(
      testCtx({ source: 'teams', meta: { personal: true } }),
    );
    const channels = await connector.subscribe(testCtx({ source: 'channels' }));
    expect(personal.externalSubId).toBeNull();
    expect(channels.externalSubId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('requires an https gateway URL outside fake mode', async () => {
    const { connector } = replay({}, { gatewayUrl: 'http://localhost:4001' });
    await expect(connector.subscribe(testCtx())).rejects.toBeInstanceOf(ConnectorError);
  });

  it('renews by PATCHing expirationDateTime and keeps the stored secret hash', async () => {
    const { connector, calls } = replay({
      'PATCH /v1.0/subscriptions/7f105c7d-2dc5-4530-97cd-4e7ae6534c07': fx(
        'subscription-renewed.json',
      ),
    });
    const info = await connector.renew(
      testCtx({
        subscription: {
          externalSubId: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
          expiresAt: new Date(NOW + 3600_000),
          meta: { secretHash: 'abc' },
        },
      }),
    );
    expect(calls[0]!.method).toBe('PATCH');
    expect(Object.keys(JSON.parse(calls[0]!.body!) as object)).toEqual(['expirationDateTime']);
    expect(info.expiresAt!.toISOString()).toBe('2026-10-12T09:45:00.000Z');
    expect(info.meta).toEqual({ secretHash: 'abc' });
  });

  it('recreates a subscription Graph removed (renew → 404)', async () => {
    const { connector, calls } = replay({
      'PATCH /v1.0/subscriptions/gone': {
        status: 404,
        body: fx('error-subscription-not-found.json'),
      },
      'POST /v1.0/subscriptions': { status: 201, body: fx('subscription-created.json') },
    });
    const info = await connector.renew(
      testCtx({
        subscription: { externalSubId: 'gone', expiresAt: null, meta: { secretHash: 'old' } },
      }),
    );
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
    expect(info.externalSubId).toBe('7f105c7d-2dc5-4530-97cd-4e7ae6534c07');
    expect(info.meta!.secretHash).not.toBe('old');
  });

  it('unsubscribes idempotently', async () => {
    const { connector, calls } = replay({ 'DELETE /v1.0/subscriptions/gone': { status: 404 } });
    await connector.unsubscribe!(
      testCtx({ subscription: { externalSubId: 'gone', expiresAt: null, meta: {} } }),
    );
    expect(calls[0]!.method).toBe('DELETE');
  });
});

describe('teams subscription fallback', () => {
  it('falls back to polling when Graph refuses the user-level chat subscription', async () => {
    const { connector } = replay({
      'POST /v1.0/subscriptions': { status: 403, body: { error: { code: 'Forbidden' } } },
    });
    const info = await connector.subscribe(testCtx({ source: 'teams' }));
    expect(info).toMatchObject({ externalSubId: null, expiresAt: null });
    // Other sources still surface the error.
    await expect(connector.subscribe(testCtx({ source: 'mail' }))).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});
