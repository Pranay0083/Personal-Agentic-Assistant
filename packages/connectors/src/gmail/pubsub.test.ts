import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GmailConfig } from './config';
import { createGmailConnector } from './connector';
import { FakeGmailStore } from './fake-store';
import { fixture } from './fixtures/index';
import { createPubSubVerifier } from './pubsub';

const AUD = 'https://hub.example/hooks/gmail';
const SA = 'gmail-push@hub-dev.iam.gserviceaccount.com';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';
const certs = async () => ({ [KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() });

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims: Record<string, unknown>, key = privateKey, kid = KID) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64u({
    iss: 'https://accounts.google.com',
    aud: AUD,
    email: SA,
    email_verified: true,
    sub: '1234567890',
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const s = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${s}`;
}

const verify = createPubSubVerifier({ audience: AUD, serviceAccountEmail: SA, getCerts: certs });

describe('Pub/Sub OIDC verification', () => {
  it('accepts a good token', async () => {
    const r = await verify(sign({}));
    expect(r.ok).toBe(true);
  });

  it('rejects the wrong audience', async () => {
    expect(await verify(sign({ aud: 'https://evil.example/hooks/gmail' }))).toEqual({
      ok: false,
      reason: 'invalid token',
    });
  });

  it('rejects the wrong service account email', async () => {
    expect(await verify(sign({ email: 'someone@evil.iam.gserviceaccount.com' }))).toEqual({
      ok: false,
      reason: 'wrong email',
    });
  });

  it('rejects an unverified email', async () => {
    expect((await verify(sign({ email_verified: false }))).ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect((await verify(sign({ iat: past, exp: past + 600 }))).ok).toBe(false);
  });

  it('rejects the wrong issuer', async () => {
    expect((await verify(sign({ iss: 'https://evil.example' }))).ok).toBe(false);
  });

  it('rejects a token signed by another key', async () => {
    expect(await verify(sign({}, other.privateKey))).toEqual({
      ok: false,
      reason: 'invalid token',
    });
  });

  it('rejects an unsigned (alg none) token', async () => {
    const t = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ aud: AUD, email: SA, email_verified: true })}.`;
    expect((await verify(t)).ok).toBe(false);
  });
});

describe('verifyWebhook', () => {
  const push = fixture<Record<string, unknown>>('pubsub-push.json');
  const real: GmailConfig = { fake: false, pubsubAudience: AUD, pubsubServiceAccount: SA };
  const connector = (config: GmailConfig) =>
    createGmailConnector({ config, verifier: verify, fakeStore: FakeGmailStore.memory() });
  const req = (headers: Record<string, string>) => ({
    headers,
    body: push,
    rawBody: JSON.stringify(push),
  });

  it('decodes the push and returns one event', async () => {
    const r = await connector(real).verifyWebhook(req({ authorization: `Bearer ${sign({})}` }));
    expect(r).toEqual({
      ok: true,
      events: [
        {
          providerEventId: '13862519468213717',
          externalAccountId: 'alex@company.example',
          payload: {
            historyId: '1006',
            messageId: '13862519468213717',
            publishTime: '2026-09-28T10:15:30.123Z',
          },
        },
      ],
    });
  });

  it('rejects an unsigned push outside fake mode', async () => {
    expect(await connector(real).verifyWebhook(req({}))).toEqual({
      ok: false,
      reason: 'missing bearer token',
    });
  });

  it('rejects a bad token even in fake mode', async () => {
    const r = await connector({ ...real, fake: true }).verifyWebhook(
      req({ authorization: `Bearer ${sign({ aud: 'nope' })}` }),
    );
    expect(r.ok).toBe(false);
  });

  it('accepts an unsigned push only in fake mode', async () => {
    const r = await connector({ fake: true }).verifyWebhook(req({}));
    expect(r.ok).toBe(true);
  });

  it('fails closed when the verifier is not configured', async () => {
    const c = createGmailConnector({ config: { fake: false } });
    expect(await c.verifyWebhook(req({ authorization: `Bearer ${sign({})}` }))).toEqual({
      ok: false,
      reason: 'push verification not configured',
    });
  });

  it('rejects a malformed envelope', async () => {
    const r = await connector(real).verifyWebhook({
      headers: { authorization: `Bearer ${sign({})}` },
      body: { message: { data: 'not-json' } },
      rawBody: '',
    });
    expect(r.ok).toBe(false);
  });
});
