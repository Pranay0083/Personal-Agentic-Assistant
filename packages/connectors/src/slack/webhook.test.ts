import { describe, expect, it } from 'vitest';
import { fixture } from '../lib/fake';
import type { SlackConfig } from './config';
import { createSlackConnector } from './connector';
import { checkSlackSignature, mapSlackBody, slackSignature } from './webhook';

const NOW = 1_790_596_800_000;
const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
const load = (name: string) => fixture<Record<string, unknown>>(import.meta.url, name);

const config = (over: Partial<SlackConfig> = {}): SlackConfig => ({
  fake: false,
  clientId: 'cid',
  clientSecret: 'csecret',
  signingSecret: SECRET,
  apiBase: 'https://slack.com/api',
  authorizeUrl: 'https://slack.com/oauth/v2/authorize',
  ...over,
});

function signed(body: unknown, secret = SECRET, ts = String(NOW / 1000)) {
  const rawBody = JSON.stringify(body);
  return {
    headers: {
      'x-slack-signature': slackSignature(secret, ts, rawBody),
      'x-slack-request-timestamp': ts,
      'content-type': 'application/json',
    } as Record<string, string>,
    body,
    rawBody,
  };
}

describe('slack signature', () => {
  const body = load('event-message.json');

  it('accepts a good v0 signature', () => {
    expect(checkSlackSignature(signed(body), [SECRET], NOW)).toEqual({ ok: true });
  });

  it('matches Slack’s documented example', () => {
    // From Slack's "Verifying requests" guide.
    const raw =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
    expect(slackSignature(SECRET, '1531420618', raw)).toBe(
      'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
    );
  });

  it('rejects a bad signature, a tampered body and the wrong secret', () => {
    const req = signed(body);
    expect(
      checkSlackSignature(
        { ...req, headers: { ...req.headers, 'x-slack-signature': 'v0=00' } },
        [SECRET],
        NOW,
      ),
    ).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(
      checkSlackSignature({ ...req, rawBody: req.rawBody.replace('Ev0', 'Ev1') }, [SECRET], NOW),
    ).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(checkSlackSignature(signed(body, 'other'), [SECRET], NOW)).toMatchObject({ ok: false });
  });

  it('rejects stale and future timestamps (more than 5 minutes)', () => {
    const old = signed(body, SECRET, String(NOW / 1000 - 301));
    expect(checkSlackSignature(old, [SECRET], NOW)).toMatchObject({ reason: 'stale timestamp' });
    const future = signed(body, SECRET, String(NOW / 1000 + 301));
    expect(checkSlackSignature(future, [SECRET], NOW)).toMatchObject({ ok: false });
    const edge = signed(body, SECRET, String(NOW / 1000 - 299));
    expect(checkSlackSignature(edge, [SECRET], NOW)).toEqual({ ok: true });
  });

  it('rejects missing headers and an unconfigured secret', () => {
    const req = signed(body);
    expect(checkSlackSignature({ headers: {}, rawBody: req.rawBody }, [SECRET], NOW)).toMatchObject(
      { reason: 'missing signature' },
    );
    expect(
      checkSlackSignature(
        {
          headers: { 'x-slack-signature': req.headers['x-slack-signature'] },
          rawBody: req.rawBody,
        },
        [SECRET],
        NOW,
      ),
    ).toMatchObject({ reason: 'missing signature' });
    expect(checkSlackSignature(req, [], NOW)).toMatchObject({
      reason: 'signing secret not configured',
    });
  });
});

describe('slack events mapping', () => {
  it('answers url_verification with the challenge', () => {
    const r = mapSlackBody(load('event-url-verification.json'));
    expect(r).toEqual({
      ok: true,
      events: [],
      reply: {
        status: 200,
        contentType: 'application/json',
        body: { challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' },
      },
    });
  });

  it('maps event_callback to one event with ids only (no text)', () => {
    const r = mapSlackBody(load('event-message.json'));
    expect(r).toEqual({
      ok: true,
      events: [
        {
          providerEventId: 'Ev0HUB00001',
          routeKey: 'T0ACME0001',
          source: 'messages',
          payload: { type: 'message', channel: 'C0LAUNCH01', ts: '1790596700.000100' },
        },
      ],
    });
    expect(JSON.stringify(r)).not.toContain('Private words');
  });

  it('skips noise (channel joins, edits, bots)', () => {
    expect(mapSlackBody(load('event-channel-join.json'))).toEqual({ ok: true, events: [] });
    const edit = load('event-message.json');
    edit.event = { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '1.000001' };
    expect(mapSlackBody(edit)).toEqual({ ok: true, events: [] });
    const bot = load('event-message.json');
    bot.event = { type: 'message', bot_id: 'B1', channel: 'C1', ts: '1.000001' };
    expect(mapSlackBody(bot)).toEqual({ ok: true, events: [] });
  });

  it('tokens_revoked → reconnect event per revoked user', () => {
    expect(mapSlackBody(load('event-tokens-revoked.json'))).toEqual({
      ok: true,
      events: [
        {
          providerEventId: 'Ev0HUB00003:U0ALEX0001',
          externalAccountId: 'T0ACME0001:U0ALEX0001',
          payload: { reconnect: true, reason: 'tokens_revoked' },
        },
      ],
    });
  });

  it('app_uninstalled → reconnect for the whole team', () => {
    expect(mapSlackBody(load('event-app-uninstalled.json'))).toMatchObject({
      ok: true,
      events: [{ routeKey: 'T0ACME0001', payload: { reconnect: true } }],
    });
  });

  it('app_rate_limited → one catch-up sync per team and minute', () => {
    const r = mapSlackBody(load('event-app-rate-limited.json'));
    expect(r).toEqual({
      ok: true,
      events: [
        {
          providerEventId: 'app_rate_limited:T0ACME0001:1790596740',
          routeKey: 'T0ACME0001',
          source: 'messages',
          payload: { rateLimited: true, minute: 1790596740 },
        },
      ],
    });
  });

  it('acknowledges unknown envelope types and refuses malformed bodies', () => {
    expect(mapSlackBody({ type: 'something_new' })).toEqual({ ok: true, events: [] });
    expect(mapSlackBody(null)).toMatchObject({ ok: false });
    expect(mapSlackBody({ type: 'event_callback' })).toMatchObject({ ok: true, events: [] });
  });
});

describe('slack verifyWebhook', () => {
  const body = load('event-message.json');

  it('verifies and maps; a Slack retry returns the same event id for gateway dedupe', async () => {
    const c = createSlackConnector({ config: config(), now: () => NOW });
    const first = await c.verifyWebhook(signed(body));
    const req = signed(body);
    const retry = await c.verifyWebhook({
      ...req,
      headers: { ...req.headers, 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' },
    });
    expect(first).toMatchObject({ ok: true, events: [{ providerEventId: 'Ev0HUB00001' }] });
    expect(retry).toEqual(first);
  });

  it('refuses unsigned or badly signed requests', async () => {
    const c = createSlackConnector({ config: config(), now: () => NOW });
    expect(
      await c.verifyWebhook({ headers: {}, body, rawBody: JSON.stringify(body) }),
    ).toMatchObject({ ok: false });
    expect(await c.verifyWebhook(signed(body, 'fake-signing-secret'))).toMatchObject({ ok: false });
  });

  it('accepts the literal fake secret only in fake mode', async () => {
    const fake = createSlackConnector({
      config: config({ fake: true, signingSecret: undefined }),
      now: () => NOW,
    });
    expect(await fake.verifyWebhook(signed(body, 'fake-signing-secret'))).toMatchObject({
      ok: true,
    });
    const off = createSlackConnector({
      config: config({ signingSecret: undefined }),
      now: () => NOW,
    });
    expect(await off.verifyWebhook(signed(body, 'fake-signing-secret'))).toMatchObject({
      ok: false,
      reason: 'signing secret not configured',
    });
  });
});
