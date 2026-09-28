/** Shared setup for apps/api tests: throwaway DB, fake connector, fake router, captured side effects. */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Connector, ConnectorInfo } from '@hub/connectors';
import type { Provider } from '@hub/shared';
import { createTestDb } from '@hub/db/testing';
import type { RouteRequest, RouteResult } from '@hub/models';
import { LocalKeyProvider, SecretStore } from '@hub/server/secrets';
import type { LiveEvent } from '@hub/shared/queues';
import { buildApi } from './app';
import type { ApiConfig, ApiDeps, GoogleIdentity, OAuthStore } from './deps';

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

/** In-memory OAuthStore with the same NX / GETDEL semantics as Redis; TTLs follow `now`. */
export function memoryOAuthStore(now: () => Date) {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const e = entries.get(key);
    if (e && e.expiresAt <= now().getTime()) entries.delete(key);
    return entries.get(key);
  };
  const store: OAuthStore = {
    setNx: async (key, value, ttlSeconds) => {
      if (live(key)) return false;
      entries.set(key, { value, expiresAt: now().getTime() + ttlSeconds * 1000 });
      return true;
    },
    take: async (key) => {
      const e = live(key);
      entries.delete(key);
      return e?.value ?? null;
    },
  };
  return { store, entries };
}

export function fakeGmailConnector() {
  const revoked: string[] = [];
  const exchanged: string[] = [];
  /** The `access` each exchange was called with (the connector's scope check keys off it). */
  const exchangedAccess: (string | undefined)[] = [];
  const connector = {
    provider: 'gmail',
    info: {
      name: 'Google',
      covers: 'Gmail',
      multiAccountNote: null,
      sources: [{ id: 'mail', label: 'Gmail', hint: null, kind: 'email', defaultOn: true }],
      options: [],
      writeActions: ['gmail.send'],
    },
    configured: () => true,
    connect: {
      authUrl: ({ state, redirectUri, access, loginHint }) => {
        const u = new URL('https://accounts.fake/o/oauth2/auth');
        u.searchParams.set('state', state);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('access', access);
        if (loginHint) u.searchParams.set('login_hint', loginHint);
        return u.toString();
      },
      exchange: async ({ code, access }) => {
        if (!code.startsWith('fake:')) throw new Error('bad code');
        const mailbox = code.slice(5);
        exchanged.push(mailbox);
        exchangedAccess.push(access);
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
  return { connector, revoked, exchanged, exchangedAccess };
}

export const ATLASSIAN_INFO: ConnectorInfo = {
  name: 'Atlassian',
  covers: 'Jira, Confluence',
  multiAccountNote: 'One per site',
  sources: [
    {
      id: 'jira',
      label: 'Jira',
      hint: null,
      kind: 'ticket',
      defaultOn: true,
      scopes: ['read:jira-work'],
    },
    {
      id: 'confluence',
      label: 'Confluence',
      hint: 'Pages you watch',
      kind: 'note',
      defaultOn: true,
      scopes: ['read:confluence-content.all'],
    },
  ],
  options: [
    {
      key: 'projects',
      label: 'Projects',
      hint: null,
      type: 'choice',
      choices: [{ value: 'mine', label: 'Mine' }],
      default: 'mine',
    },
  ],
  writeActions: ['jira.comment'],
};

/**
 * A fake multi-identity connector: code `fake-sites:<user>:<a>,<b>[:<scope>,<scope>]` grants
 * one consent for sites `a` and `b` (identities `cloud-a`, `cloud-b`), by default with the
 * Jira and Confluence read scopes.
 */
export function fakeSitesConnector(
  provider: Provider = 'atlassian',
  opts: { configured?: boolean; info?: Partial<ConnectorInfo> } = {},
) {
  const revoked: string[] = [];
  const connector = {
    provider,
    info: { ...ATLASSIAN_INFO, ...opts.info },
    configured: () => opts.configured ?? true,
    connect: {
      authUrl: ({ state, redirectUri, access, loginHint }) => {
        const u = new URL(`https://${provider}.fake/authorize`);
        u.searchParams.set('state', state);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('access', access);
        if (loginHint) u.searchParams.set('login_hint', loginHint);
        return u.toString();
      },
      exchange: async ({ code }) => {
        const [, user, sites, scopes] = code.split(':');
        if (!user || !sites) throw new Error('bad code');
        const identities = sites.split(',').map((site) => ({
          externalId: `cloud-${site}`,
          displayName: site === 'nameless' ? null : `${site[0]!.toUpperCase()}${site.slice(1)}`,
          routeKeys: [`cloud-${site}`],
          meta: { siteUrl: `https://${site}.atlassian.example` },
        }));
        return {
          tokens: {
            accessToken: rawAccess(`${user}@${sites}`),
            refreshToken: rawRefresh(`${user}@${sites}`),
            scope: scopes
              ? scopes.split(',').join(' ')
              : 'read:jira-work read:confluence-content.all offline_access',
          },
          externalId: identities[0]!.externalId,
          displayName: identities[0]!.displayName,
          identities,
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
  return { connector: connector as Connector, revoked };
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
  const sites = fakeSitesConnector();
  // Implemented but without client credentials on this server.
  const notion = fakeSitesConnector('notion', { configured: false });
  // Implemented, configured, read-only.
  const github = fakeSitesConnector('github', { info: { writeActions: [] } });
  const fakes: Partial<Record<Provider, Connector>> = {
    gmail: gmail.connector,
    atlassian: sites.connector,
    notion: notion.connector,
    github: github.connector,
  };
  const routerCalls: RouteRequest[] = [];
  let answer = 'Answer [1]';
  let clock = new Date('2026-09-28T10:00:00.000Z');
  const google = new Map<string, GoogleIdentity>();
  const oauth = memoryOAuthStore(() => clock);

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
    getConnector: (p) => fakes[p],
    oauthStore: oauth.store,
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

  /** POST /accounts/:provider/connect (or /accounts/:id/write-access) and returns the state. */
  async function startConnect(token: string, url = '/accounts/gmail/connect', payload = {}) {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.body}`);
    return new URL((res.json() as { url: string }).url).searchParams.get('state')!;
  }

  /** The provider redirecting the browser back; returns the response and its pending id. */
  async function callback(state: string, code: string, name = 'google') {
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/${name}/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    });
    const location = String(res.headers.location ?? '');
    const pending = location ? new URL(location).searchParams.get('pending') : null;
    return { res, location, pending };
  }

  /** The app finishing the flow with its own session. */
  function complete(token: string, pending: string) {
    return app.inject({
      method: 'POST',
      url: '/accounts/complete',
      headers: { authorization: `Bearer ${token}` },
      payload: { pending },
    });
  }

  /** Runs the full connect → consent → callback → complete flow with the fake connector. */
  async function connectGmail(token: string, mailbox: string) {
    const state = await startConnect(token);
    const cb = await callback(state, `fake:${mailbox}`);
    if (!cb.pending) throw new Error(`callback failed: ${cb.location || cb.res.body}`);
    const done = await complete(token, cb.pending);
    if (done.statusCode !== 200) throw new Error(`complete failed: ${done.body}`);
    const accountId = (done.json() as { account: { id: string } }).account.id;
    return { res: cb.res, location: cb.location, pending: cb.pending, complete: done, accountId };
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
    sites,
    google,
    routerCalls,
    oauth,
    signIn,
    startConnect,
    callback,
    complete,
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
