import { ConnectorError, MissingScopeError, ReconnectRequiredError } from '../errors';
import type { FetchFn } from '../lib/http';
import { authorizeUrl, exchangeCode, toTokens } from '../lib/oauth2';
import type {
  AccessKind,
  Connector,
  ConnectorContext,
  ConnectorInfo,
  ExecuteResult,
  Identity,
  OAuthTokens,
  SubscriptionInfo,
} from '../types';
import type { AccessibleResource, AtlassianMe } from './api-types';
import { PROVIDER, atlassianClient, cloudIdOf, oauthConfig } from './client';
import {
  ATLASSIAN_SCOPES,
  ATLASSIAN_URLS,
  CONFLUENCE_SOURCE_SCOPES,
  JIRA_SOURCE_SCOPES,
  READ_SCOPES,
  WRITE_SCOPES,
  atlassianConfigFromEnv,
  isWriteScope,
  webhookSigningSecret,
  type AtlassianConfig,
} from './config';
import {
  confluenceBackfill,
  confluenceDelta,
  normalizeConfluence,
  type ConfluenceRecord,
} from './confluence';
import { startCursor } from './cursor';
import { executeJira, findJiraExecuted, lookupTarget } from './execute';
import { fakeAtlassianFetch, fakeAuthUrl } from './fake';
import { defaultFakeStore, type FakeAtlassianStore } from './fake-store';
import { jiraBackfill, jiraDelta, normalizeJira, type JiraRecord } from './jira';
import {
  deleteWebhooks,
  listWebhooks,
  refreshWebhooks,
  registerWebhooks,
  verifyJiraWebhook,
  webhookIdsOf,
} from './webhooks';

export type AtlassianRecord = JiraRecord | ConfluenceRecord;

export type AtlassianConnectorOptions = {
  /** Defaults to reading process.env on every call. */
  config?: AtlassianConfig | (() => AtlassianConfig);
  /** Replays recorded responses in tests. Defaults to the real fetch (or the fake in fake mode). */
  fetch?: FetchFn;
  /** Fake-mode store; defaults to <repo>/.dev/fake-atlassian.json. */
  fakeStore?: FakeAtlassianStore;
  now?: () => number;
};

export const ATLASSIAN_INFO: ConnectorInfo = {
  name: 'Atlassian',
  covers: 'Jira, Confluence · per site',
  multiAccountNote: 'One account per site',
  sources: [
    {
      id: 'jira',
      label: 'Jira',
      hint: 'Issues you are assigned, reported, watch or are mentioned in. Assigned and reported issues arrive by webhook; watched issues and mentions on the next sync.',
      kind: 'ticket',
      defaultOn: true,
      scopes: JIRA_SOURCE_SCOPES,
    },
    {
      id: 'confluence',
      label: 'Confluence',
      hint: 'Pages you created, watch or are mentioned in. Confluence has no push for this kind of app, so pages sync on the scheduled catch-up (every few minutes).',
      kind: 'note',
      defaultOn: true,
      scopes: CONFLUENCE_SOURCE_SCOPES,
    },
  ],
  options: [],
  writeActions: ['jira.transition', 'jira.comment'],
};

function scopeSet(scope: string | undefined): Set<string> {
  return new Set((scope ?? '').split(/[\s,]+/).filter(Boolean));
}

/** Checks the consent granted what `access` needs; a read grant must not carry write scopes. */
export function checkScopes(scope: string | undefined, access: AccessKind): void {
  const granted = scopeSet(scope);
  if (access === 'write') {
    if (!granted.has(ATLASSIAN_SCOPES.jiraWrite))
      throw new MissingScopeError(PROVIDER, [ATLASSIAN_SCOPES.jiraWrite]);
    return;
  }
  const bad = [...granted].filter(isWriteScope);
  if (bad.length) {
    throw new ConnectorError(PROVIDER, 'read grant unexpectedly includes write scopes');
  }
  const base = [ATLASSIAN_SCOPES.me, ATLASSIAN_SCOPES.offline].filter((s) => !granted.has(s));
  const jira = JIRA_SOURCE_SCOPES.every((s) => granted.has(s));
  const confluence = CONFLUENCE_SOURCE_SCOPES.every((s) => granted.has(s));
  const missing = [...base, ...(jira || confluence ? [] : JIRA_SOURCE_SCOPES)];
  if (missing.length) throw new MissingScopeError(PROVIDER, missing);
}

function productsOf(scopes: string[]): ('jira' | 'confluence')[] {
  const out: ('jira' | 'confluence')[] = [];
  if (scopes.some((s) => s.includes('jira'))) out.push('jira');
  if (scopes.some((s) => s.includes('confluence'))) out.push('confluence');
  return out;
}

/** accessible-resources can list a site once per product; merge them by cloud id. */
export function mergeResources(list: AccessibleResource[]): AccessibleResource[] {
  const by = new Map<string, AccessibleResource>();
  for (const r of list) {
    const prev = by.get(r.id);
    by.set(
      r.id,
      prev ? { ...prev, scopes: [...new Set([...prev.scopes, ...r.scopes])] } : { ...r },
    );
  }
  return [...by.values()];
}

const blankCtx = (tokens: OAuthTokens): ConnectorContext => ({
  accountId: '',
  externalId: '',
  tokens,
  saveTokens: async () => {},
  cursor: null,
  filters: { inbox: true, sent: true, promotions: false, labels: [], sources: {}, options: {} },
});

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Remembers recent execute targets so a same-process retry can look them up without a payload. */
class RecentTargets {
  private map = new Map<string, Record<string, unknown>>();
  set(key: string, payload: Record<string, unknown>) {
    this.map.delete(key);
    this.map.set(key, payload);
    if (this.map.size > 500) this.map.delete(this.map.keys().next().value!);
  }
  get(key: string) {
    return this.map.get(key);
  }
}

export function createAtlassianConnector(
  opts: AtlassianConnectorOptions = {},
): Connector<AtlassianRecord> {
  const cfg = (): AtlassianConfig =>
    typeof opts.config === 'function' ? opts.config() : (opts.config ?? atlassianConfigFromEnv());
  const now = opts.now ?? Date.now;
  const store = () => opts.fakeStore ?? defaultFakeStore();
  const fetchFor = (c: AtlassianConfig): FetchFn | undefined =>
    opts.fetch ?? (c.fake ? fakeAtlassianFetch(store(), { now }) : undefined);
  const client = (ctx: ConnectorContext) => {
    const c = cfg();
    return atlassianClient(c, ctx, fetchFor(c));
  };
  const site = (ctx: ConnectorContext) => ({
    cloudId: cloudIdOf(ctx),
    siteUrl: str(ctx.meta?.siteUrl),
    me: str(ctx.meta?.atlassianAccountId),
  });
  const recent = new RecentTargets();

  async function myAccountId(ctx: ConnectorContext): Promise<string> {
    const known = str(ctx.meta?.atlassianAccountId);
    if (known) return known;
    const me = await client(ctx).call<AtlassianMe>('/me');
    if (!me?.account_id)
      throw new ConnectorError(PROVIDER, 'could not determine the Atlassian user');
    return me.account_id;
  }

  const pollOnly = (): SubscriptionInfo => ({
    externalSubId: null,
    expiresAt: null,
    cursor: startCursor(now()),
    meta: { polling: true },
  });

  async function subscribe(ctx: ConnectorContext): Promise<SubscriptionInfo> {
    if ((ctx.source ?? 'jira') !== 'jira') return pollOnly();
    return registerWebhooks(client(ctx), {
      gatewayUrl: cfg().gatewayUrl,
      cloudId: cloudIdOf(ctx),
      accountId: await myAccountId(ctx),
      now: now(),
    });
  }

  const connector: Connector<AtlassianRecord> = {
    provider: 'atlassian',
    info: ATLASSIAN_INFO,
    configured() {
      const c = cfg();
      return c.fake || (!!c.clientId && !!c.clientSecret);
    },

    connect: {
      authUrl({ state, redirectUri, access }) {
        const c = cfg();
        if (c.fake) return fakeAuthUrl({ state, redirectUri, access });
        if (!c.clientId) throw new ConnectorError(PROVIDER, 'ATLASSIAN_CLIENT_ID is not set');
        return authorizeUrl(
          { authorizeUrl: ATLASSIAN_URLS.authorize, clientId: c.clientId },
          {
            state,
            redirectUri,
            scopes: access === 'read' ? READ_SCOPES : WRITE_SCOPES,
            extra: { audience: ATLASSIAN_URLS.audience, prompt: 'consent' },
          },
        );
      },

      async exchange({ code, redirectUri, access }) {
        const c = cfg();
        const f = fetchFor(c);
        let tokens: OAuthTokens;
        try {
          tokens = toTokens(await exchangeCode(oauthConfig(c, f), { code, redirectUri }));
        } catch (e) {
          if (e instanceof ReconnectRequiredError)
            throw new ConnectorError(PROVIDER, 'oauth code exchange failed', { status: 400 });
          throw e;
        }
        if (access) checkScopes(tokens.scope, access);
        const granted = scopeSet(tokens.scope);
        const api = atlassianClient(c, blankCtx(tokens), f);

        const resources = mergeResources(
          (await api.call<AccessibleResource[]>('/oauth/token/accessible-resources')) ?? [],
        );
        const me = granted.has(ATLASSIAN_SCOPES.me) ? await api.call<AtlassianMe>('/me') : null;
        const accountLevel = [ATLASSIAN_SCOPES.me, ATLASSIAN_SCOPES.offline].filter((s) =>
          granted.has(s),
        );

        const identities: Identity[] = resources
          .map((r): Identity | null => {
            const scopes = [...new Set([...r.scopes, ...accountLevel])];
            const products = productsOf(r.scopes);
            if (!products.length) return null;
            return {
              externalId: r.id,
              displayName: r.name,
              routeKeys: [r.id],
              meta: {
                cloudId: r.id,
                siteUrl: r.url,
                siteName: r.name,
                atlassianAccountId: me?.account_id ?? null,
                grantedScopes: scopes,
                products,
              },
            };
          })
          .filter((i): i is Identity => !!i);
        if (!identities.length)
          throw new ConnectorError(
            PROVIDER,
            'the consent did not include any Jira or Confluence site',
          );
        const first = identities[0]!;
        return {
          tokens,
          externalId: first.externalId,
          displayName: first.displayName,
          identities,
        };
      },

      /**
       * Atlassian has no token revocation endpoint for OAuth 2.0 (3LO) apps. Disconnecting
       * deletes our webhooks (unsubscribe) and drops the stored tokens; the user can also
       * remove the app at id.atlassian.com → Connected apps.
       */
      async revoke() {},
    },

    subscribe,

    /**
     * Extends the Jira webhooks by 30 days. If Jira no longer has them (expired, or the user
     * removed the app), registers new ones: the result then carries a new externalSubId and
     * meta (secretHash) that the caller must store. Never returns a cursor.
     */
    async renew(ctx) {
      if ((ctx.source ?? 'jira') !== 'jira') {
        const { cursor: _c, ...rest } = pollOnly();
        return rest;
      }
      const api = client(ctx);
      const sub = ctx.subscription;
      const ids = webhookIdsOf(sub?.meta);
      if (sub?.externalSubId && ids.length && typeof sub.meta.secretHash === 'string') {
        const live = new Set((await listWebhooks(api)).map((w) => w.id));
        if (ids.every((id) => live.has(id))) {
          const expiresAt = await refreshWebhooks(api, ids, now());
          return { externalSubId: sub.externalSubId, expiresAt, meta: sub.meta };
        }
        await deleteWebhooks(
          api,
          ids.filter((id) => live.has(id)),
        );
      }
      const { cursor: _c, ...fresh } = await subscribe(ctx);
      return fresh;
    },

    async unsubscribe(ctx) {
      if ((ctx.source ?? 'jira') !== 'jira') return;
      await deleteWebhooks(client(ctx), webhookIdsOf(ctx.subscription?.meta));
    },

    async verifyWebhook(req) {
      return verifyJiraWebhook(req, webhookSigningSecret(cfg()), now());
    },

    async fetchDelta(ctx) {
      const api = client(ctx);
      if (ctx.source === 'confluence') return confluenceDelta(api, site(ctx), ctx.cursor, now());
      return jiraDelta(api, site(ctx), ctx.cursor, now());
    },

    async backfill(ctx, { days, pageToken }) {
      const api = client(ctx);
      if (ctx.source === 'confluence') return confluenceBackfill(api, site(ctx), days, pageToken);
      return jiraBackfill(api, site(ctx), days, pageToken);
    },

    normalize(raw) {
      if (raw?.type === 'jira') return normalizeJira(raw);
      if (raw?.type === 'confluence') return normalizeConfluence(raw);
      return null;
    },

    async execute(ctx, action, payload, idempotencyKey) {
      recent.set(idempotencyKey, payload);
      return executeJira(client(ctx), action, payload, idempotencyKey, now());
    },

    /**
     * Looks for the `hub.exec.<hash>` issue property (and, for transitions, the target
     * status; for comments, a comment carrying the marker). Needs the issue key: pass the
     * proposal payload as the 4th argument. Without it only targets executed by this
     * process are known; otherwise it throws rather than report "not sent".
     * Call it with the *read* token context (the write consent cannot read issues).
     */
    async findExecuted(
      ctx: ConnectorContext,
      action: string,
      idempotencyKey: string,
      payload?: Record<string, unknown>,
    ): Promise<ExecuteResult | null> {
      if (action !== 'jira.transition' && action !== 'jira.comment') return null;
      const target = lookupTarget(action, payload ?? recent.get(idempotencyKey));
      if (!target)
        throw new ConnectorError(PROVIDER, 'findExecuted needs the proposal payload (issue key)');
      return findJiraExecuted(client(ctx), action, idempotencyKey, target);
    },
  };
  return connector;
}
