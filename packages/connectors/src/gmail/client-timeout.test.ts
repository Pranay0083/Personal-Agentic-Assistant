import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetryableError } from '../errors';
import { GMAIL_REQUEST_TIMEOUT_MS, mapGmailError, realClientFactory } from './client';

/** A local server that accepts requests and never answers (a hung Gmail connection). */
let server: Server;
let base = '';
const hung: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((_req, res) => void hung.push(res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of hung) res.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Gmail client timeout', () => {
  it('has a default request timeout', () => {
    expect(GMAIL_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GMAIL_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('a hung send times out and maps to a RetryableError without a status', async () => {
    const factory = realClientFactory(
      { fake: false, clientId: 'c', clientSecret: 's', rootUrl: `${base}/` },
      { timeoutMs: 150 },
    );
    const api = factory({
      tokens: { accessToken: 'ya29.test', expiresAt: Date.now() + 3600_000 },
      externalId: 'me@example.com',
      onTokens: () => {},
    });
    const started = Date.now();
    const err = await api.sendMessage({ raw: 'eA' }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    const mapped = mapGmailError(err);
    expect(mapped).toBeInstanceOf(RetryableError);
    // No status: the executor treats it as ambiguous (may have reached Gmail).
    expect((mapped as RetryableError).status).toBeUndefined();
    expect((mapped as RetryableError).message).not.toContain('ya29');
  });
});
