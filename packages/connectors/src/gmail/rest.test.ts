import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountFilters } from '@hub/shared';
import type { ConnectorContext, OAuthTokens } from '../types';
import type { GmailConfig } from './config';
import { createGmailConnector } from './connector';
import { fixture } from './fixtures/index';

/** The real OAuth2Client.request transport against a local server replaying fixtures. */
let server: Server;
let base = '';
const seen: { method: string; path: string; query: string; auth: string | undefined }[] = [];
type Reply = { status: number; body: unknown };
/** A list is answered in order (last entry repeats). */
let routes: Record<string, Reply | Reply[]> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    seen.push({
      method: req.method!,
      path: u.pathname,
      query: u.search,
      auth: req.headers.authorization,
    });
    req.resume();
    const hit = routes[`${req.method} ${u.pathname}`];
    const r = (Array.isArray(hit) ? (hit.length > 1 ? hit.shift() : hit[0]) : hit) ?? {
      status: 404,
      body: {},
    };
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const config = (): GmailConfig => ({
  fake: false,
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  rootUrl: `${base}/`,
  oauthEndpoints: { oauth2TokenUrl: `${base}/token` },
});

function ctx(tokens: OAuthTokens, cursor: string | null) {
  const saved: OAuthTokens[] = [];
  const c: ConnectorContext = {
    accountId: '00000000-0000-4000-8000-000000000001',
    externalId: 'alex@company.example',
    tokens,
    saveTokens: async (t) => {
      saved.push(t);
    },
    source: 'calendar',
    cursor,
    filters: AccountFilters.parse({}),
  };
  return { c, saved };
}

describe('real REST transport (local fixture server)', () => {
  it('refreshes, sends the bearer token, and maps 410 to a full resync', async () => {
    seen.length = 0;
    routes = {
      'POST /token': { status: 200, body: fixture('token-refresh.json') },
      // The syncToken call → 410; the follow-up (timeMin) → a fresh token.
      'GET /calendar/v3/calendars/primary/events': [
        { status: 410, body: fixture('calendar-410.json') },
        { status: 200, body: fixture('calendar-sync-token.json') },
      ],
    };
    const { c, saved } = ctx(
      { accessToken: 'ya29.old', refreshToken: '1//r', expiresAt: 1 },
      'tok',
    );
    const delta = await createGmailConnector({ config }).fetchDelta(c);
    expect(delta.fullResyncRequired).toBe(true);
    expect(delta.cursor).toBe('CKCx7eKT1YgDEKCx7eKT1YgDGAUghIDAhQI=');
    const api = seen.filter((s) => s.path.startsWith('/calendar/'));
    expect(api[0]!.query).toContain('syncToken=tok');
    expect(
      api.every(
        (s) =>
          s.auth ===
          `Bearer ${fixture<{ access_token: string }>('token-refresh.json').access_token}`,
      ),
    ).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.refreshToken).toBe('1//r');
  });
});
