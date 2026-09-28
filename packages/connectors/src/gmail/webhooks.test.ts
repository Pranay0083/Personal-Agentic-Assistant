import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../lib/crypto';
import type { WebhookRequest } from '../types';
import { channelSecretMatches, verifyChannelPush } from './channels';
import type { GmailConfig } from './config';
import { createGmailConnector } from './connector';
import { FakeGmailStore } from './fake-store';
import { fixture } from './fixtures/index';
import { createPubSubVerifier } from './pubsub';

const calendarHeaders = fixture<Record<string, string>>('channel-push-calendar.json');
const driveSync = fixture<Record<string, string>>('channel-push-drive-sync.json');
const channelReq = (headers: Record<string, string>): WebhookRequest => ({
  method: 'POST',
  headers,
  channel: 'channel',
  body: {},
  rawBody: '',
});

describe('Calendar/Drive channel pushes', () => {
  it('routes by channel id and hands the token to the gateway', () => {
    expect(verifyChannelPush(channelReq(calendarHeaders))).toEqual({
      ok: true,
      events: [
        {
          providerEventId: 'ch:hubcal-9f1c2d3e4b5a69788796a5b4:226548',
          externalSubId: 'hubcal-9f1c2d3e4b5a69788796a5b4',
          source: 'calendar',
          subscriptionSecret: 'tok_calendar_fixture_secret_1',
          payload: {
            channelId: 'hubcal-9f1c2d3e4b5a69788796a5b4',
            resourceState: 'exists',
            messageNumber: '226548',
          },
        },
      ],
    });
  });

  it('the stored hash matches the good token and rejects a bad one', () => {
    const meta = { secretHash: sha256Hex('tok_calendar_fixture_secret_1') };
    const r = verifyChannelPush(channelReq(calendarHeaders));
    const secret = r.ok ? r.events[0]!.subscriptionSecret : undefined;
    expect(channelSecretMatches(meta, secret)).toBe(true);
    expect(channelSecretMatches(meta, 'tok_forged')).toBe(false);
    expect(channelSecretMatches(meta, '')).toBe(false);
    expect(channelSecretMatches({}, secret)).toBe(false);
  });

  it('acknowledges the sync handshake with no events', () => {
    expect(verifyChannelPush(channelReq(driveSync))).toEqual({ ok: true, events: [] });
  });

  it('rejects pushes without a token or from channels we did not open', () => {
    const { 'x-goog-channel-token': _t, ...noToken } = calendarHeaders;
    expect(verifyChannelPush(channelReq(noToken))).toEqual({
      ok: false,
      reason: 'missing channel token',
    });
    expect(
      verifyChannelPush(channelReq({ ...calendarHeaders, 'x-goog-channel-id': 'someone-else' })).ok,
    ).toBe(false);
    expect(verifyChannelPush(channelReq({ 'x-goog-channel-token': 't' })).ok).toBe(false);
  });

  it('the connector sends /hooks/gmail/channel pushes here, even when the path is missing', async () => {
    const c = createGmailConnector({ config: { fake: false } });
    const r = await c.verifyWebhook(channelReq(driveSync));
    expect(r).toEqual({ ok: true, events: [] });
    const sniffed = await c.verifyWebhook({ ...channelReq(calendarHeaders), channel: null });
    expect(sniffed.ok && sniffed.events[0]!.externalSubId).toBe('hubcal-9f1c2d3e4b5a69788796a5b4');
    expect((await c.verifyWebhook({ ...channelReq(calendarHeaders), channel: 'nope' })).ok).toBe(
      false,
    );
  });
});

// ---- Workspace Events (Chat) over Pub/Sub ----

const EVENTS_AUD = 'https://hub.example/hooks/gmail/events';
const GMAIL_AUD = 'https://hub.example/hooks/gmail';
const SA = 'push@hub-dev.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-events';
const certs = async () => ({ [KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(aud: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64u({
    iss: 'https://accounts.google.com',
    aud,
    email: SA,
    email_verified: true,
    sub: '1',
    iat: now,
    exp: now + 3600,
  });
  const s = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(privateKey)
    .toString('base64url');
  return `${head}.${body}.${s}`;
}

describe('Chat event push (/hooks/gmail/events)', () => {
  const push = fixture<Record<string, unknown>>('events-pubsub-push.json');
  const lifecycle = fixture<Record<string, unknown>>('events-lifecycle-push.json');
  const connector = (config: Partial<GmailConfig> = {}) =>
    createGmailConnector({
      config: { fake: false, ...config },
      fakeStore: FakeGmailStore.memory(),
      verifier: createPubSubVerifier({
        audience: GMAIL_AUD,
        serviceAccountEmail: SA,
        getCerts: certs,
      }),
      eventsVerifier: createPubSubVerifier({
        audience: EVENTS_AUD,
        serviceAccountEmail: SA,
        getCerts: certs,
      }),
    });
  const req = (
    body: unknown,
    token?: string,
    channel: string | null = 'events',
  ): WebhookRequest => ({
    headers: token ? { authorization: `Bearer ${token}` } : {},
    channel,
    body,
    rawBody: JSON.stringify(body),
  });

  it('routes a message.created CloudEvent to its subscription, ids only', async () => {
    const r = await connector().verifyWebhook(req(push, sign(EVENTS_AUD)));
    expect(r).toEqual({
      ok: true,
      events: [
        {
          providerEventId: 'wse:15123456789012345',
          externalSubId: 'subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw',
          source: 'chat',
          payload: {
            eventType: 'google.workspace.chat.message.v1.created',
            messageId: '15123456789012345',
            space: 'spaces/AAAAq3Lk0aE',
            time: '2026-09-28T09:01:02.123456Z',
          },
        },
      ],
    });
  });

  it('is verified with the events audience, not the Gmail one', async () => {
    expect((await connector().verifyWebhook(req(push, sign(GMAIL_AUD)))).ok).toBe(false);
    // And a Gmail-audience token can't smuggle a Chat event through the Gmail path.
    expect((await connector().verifyWebhook(req(push, sign(GMAIL_AUD), null))).ok).toBe(false);
  });

  it('rejects unsigned pushes outside fake mode, accepts them in fake mode', async () => {
    expect(await connector().verifyWebhook(req(push))).toEqual({
      ok: false,
      reason: 'missing bearer token',
    });
    expect((await connector({ fake: true }).verifyWebhook(req(push))).ok).toBe(true);
  });

  it('passes lifecycle events on so the worker can renew', async () => {
    const r = await connector().verifyWebhook(req(lifecycle, sign(EVENTS_AUD)));
    expect(r.ok && r.events[0]).toMatchObject({
      externalSubId: 'subscriptions/chat-spaces-czpbbTI1Y2Z0NjAw',
      source: 'chat',
      payload: { lifecycle: 'expirationReminder' },
    });
  });

  it('ignores other event types and rejects foreign sources', async () => {
    const withAttrs = (a: Record<string, string>) => ({
      ...push,
      message: {
        ...(push.message as object),
        attributes: { ...(push.message as { attributes: object }).attributes, ...a },
      },
    });
    const other = await connector().verifyWebhook(
      req(withAttrs({ 'ce-type': 'google.workspace.chat.reaction.v1.created' }), sign(EVENTS_AUD)),
    );
    expect(other).toEqual({ ok: true, events: [] });
    const foreign = await connector().verifyWebhook(
      req(withAttrs({ 'ce-source': '//evil.example/subscriptions/x' }), sign(EVENTS_AUD)),
    );
    expect(foreign.ok).toBe(false);
  });
});
