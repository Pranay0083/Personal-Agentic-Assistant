/** Shared setup for apps/api tests: throwaway DB, fake connector, fake router, captured side effects. */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Connector } from '@hub/connectors';
import { createTestDb } from '@hub/db/testing';
import type { RouteRequest, RouteResult } from '@hub/models';
import { LocalKeyProvider, SecretStore } from '@hub/server/secrets';
import type { LiveEvent } from '@hub/shared/queues';
import { buildApi } from './app';
import type { ApiConfig, ApiDeps, GoogleIdentity } from './deps';

export const TEST_CONFIG: ApiConfig = {
  production: false,
  devAuth: true,
  sessionSecret: 'test-session-secret-0123456789-abcdefghijkl',
  appScheme: 'hub',
  publicApiUrl: 'http://api.test',
  publicMcpUrl: 'http://mcp.test/mcp',
  googleOAuthRedirectUri: 'http://api.test/oauth/google/callback',
  googleSigninClientIds: ['ios-client', 'web-client'],
};

export const rawAccess = (mailbox: string) => `ya29.RAWACCESS-${mailbox}`;
export const rawRefresh = (mailbox: string) => `1//RAWREFRESH-${mailbox}`;

export function fakeGmailConnector() {
  const revoked: string[] = [];
  const exchanged: string[] = [];
  const connector = {
    provider: 'gmail',
    connect: {
      authUrl: ({ state, redirectUri, access, loginHint }) => {
        const u = new URL('https://accounts.fake/o/oauth2/auth');
        u.searchParams.set('state', state);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('access', access);
        if (loginHint) u.searchParams.set('login_hint', loginHint);
        return u.toString();
      },
      exchange: async ({ code }) => {
        if (!code.startsWith('fake:')) throw new Error('bad code');
        const mailbox = code.slice(5);
        exchanged.push(mailbox);
        return {
          tokens: { accessToken: rawAccess(mailbox), refreshToken: rawRefresh(mailbox) },
          externalId: mailbox,
          displayName: null,
        };
      },
      revoke: async (tokens) => {
        revoked.push(tokens.accessToken);
      },
    },
    subscribe: async () => ({ externalSubId: null, expiresAt: null }),
    renew: async () => ({ externalSubId: null, expiresAt: null }),
    verifyWebhook: async () => ({ ok: false, reason: 'fake' }),
    fetchDelta: async () => ({ records: [], cursor: null }),
    backfill: async () => ({ records: [], nextPageToken: null }),
    normalize: () => null,
  } satisfies Connector;
  return { connector, revoked, exchanged };
}

export type Job = { name: string; data: unknown; opts?: { jobId?: string } };

export async function setup(overrides: Partial<ApiDeps> = {}) {
  const t = await createTestDb();
  const keys = new LocalKeyProvider(randomBytes(32).toString('base64'));
  const secrets = new SecretStore(t.db, keys);
  const jobs: Job[] = [];
  const live: { userId: string; event: LiveEvent }[] = [];
  const subscribers = new Map<string, Set<(e: LiveEvent) => void>>();
  const gmail = fakeGmailConnector();
  const routerCalls: RouteRequest[] = [];
  let answer = 'Answer [1]';
  let clock = new Date('2026-09-28T10:00:00.000Z');
  const google = new Map<string, GoogleIdentity>();

  const deps: ApiDeps = {
    db: t.db,
    secrets,
    keys,
    enqueue: async (name, data, opts) => {
      // Mirrors BullMQ: a duplicate jobId collapses into the existing job.
      if (opts?.jobId && jobs.some((j) => j.name === name && j.opts?.jobId === opts.jobId)) return;
      jobs.push({ name, data, opts });
    },
    publishLive: async (userId, event) => {
      live.push({ userId, event });
      for (const cb of subscribers.get(userId) ?? []) cb(event);
    },
    subscribeLive: (userId, cb) => {
      const set = subscribers.get(userId) ?? new Set();
      set.add(cb);
      subscribers.set(userId, set);
      return () => set.delete(cb);
    },
    getConnector: (p) => (p === 'gmail' ? gmail.connector : undefined),
    router: {
      generate: async (req): Promise<RouteResult> => {
        routerCalls.push(req);
        return {
          text: answer,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'fake-model',
          provider: 'fake',
          fallbackUsed: false,
          costUsd: 0,
        };
      },
    },
    now: () => clock,
    config: TEST_CONFIG,
    verifyGoogleIdToken: async (idToken, audiences) => {
      const id = google.get(idToken);
      if (!id || !audiences.includes('ios-client')) throw new Error('invalid');
      return id;
    },
    logger: false,
    ...overrides,
  };
  const app = await buildApi(deps);

  async function signIn(email: string, headers: Record<string, string> = {}) {
    const res = await app.inject({ method: 'POST', url: '/auth/dev', payload: { email }, headers });
    if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
    const body = res.json() as { token: string; user: { id: string } };
    return {
      token: body.token,
      userId: body.user.id,
      auth: { authorization: `Bearer ${body.token}` },
    };
  }

  /** Runs the full connect → consent → callback flow with the fake connector. */
  async function connectGmail(token: string, mailbox: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts/gmail/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.body}`);
    const state = new URL((res.json() as { url: string }).url).searchParams.get('state')!;
    const cb = await app.inject({
      method: 'GET',
      url: `/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`fake:${mailbox}`)}`,
    });
    const location = String(cb.headers.location ?? '');
    const accountId = new URL(location).searchParams.get('accountId');
    return { res: cb, location, accountId: accountId! };
  }

  return {
    t,
    app: app as FastifyInstance,
    deps,
    keys,
    secrets,
    jobs,
    live,
    gmail,
    google,
    routerCalls,
    signIn,
    connectGmail,
    setAnswer: (a: string) => (answer = a),
    setNow: (d: Date) => (clock = d),
    now: () => clock,
    async close() {
      await app.close();
      await t.drop();
    },
  };
}

export type TestEnv = Awaited<ReturnType<typeof setup>>;
