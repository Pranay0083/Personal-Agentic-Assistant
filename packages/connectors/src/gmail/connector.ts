import { GmailSendPayload } from '@hub/shared';
import { ConnectorError, MissingScopeError } from '../errors';
import type {
  AccessKind,
  Connector,
  ConnectorContext,
  OAuthTokens,
  SubscriptionInfo,
  VerifyResult,
  ConnectorInfo,
} from '../types';
import {
  fromCredentials,
  httpStatusOf,
  mapGmailError,
  oauthClient,
  realClientFactory,
  type GmailApi,
  type GmailClientFactory,
  type GmailMessage,
} from './client';
import { GMAIL_SCOPES, gmailConfigFromEnv, type GmailConfig } from './config';
import { fakeAuth, fakeClientFactory, type FakeClientOptions } from './fake';
import { defaultFakeStore, type FakeGmailStore } from './fake-store';
import { backfillQuery, gmailAccepts, watchLabelIds } from './filters';
import { buildMime, messageIdFor, rfc822SearchId, toBase64Url } from './mime';
import { normalizeGmail, type GmailRecord } from './normalize';
import {
  GmailNotification,
  PubSubPush,
  bearerToken,
  createPubSubVerifier,
  type OidcVerifier,
} from './pubsub';

export type GmailConnectorOptions = {
  /** Defaults to reading process.env on every call (GMAIL_FAKE, GOOGLE_*, GMAIL_PUBSUB_*). */
  config?: GmailConfig | (() => GmailConfig);
  /** Overrides the real/fake client choice (tests). */
  clientFactory?: GmailClientFactory;
  /** Fake-mode store; defaults to the shared file store at <repo>/.dev/fake-gmail.json. */
  fakeStore?: FakeGmailStore;
  fakeClientOptions?: FakeClientOptions;
  /** Pub/Sub OIDC verifier; defaults to Google certs with GMAIL_PUBSUB_AUDIENCE/SERVICE_ACCOUNT. */
  verifier?: OidcVerifier;
};

const READ_SCOPES = [GMAIL_SCOPES.readonly, GMAIL_SCOPES.openid, GMAIL_SCOPES.email];
/**
 * gmail.send is the only Gmail scope; openid+email only identify the mailbox so the API
 * can check the write consent was given by the same Google account.
 */
const WRITE_SCOPES = [GMAIL_SCOPES.send, GMAIL_SCOPES.openid, GMAIL_SCOPES.email];
const WRITE_GMAIL_SCOPES = [
  GMAIL_SCOPES.send,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.insert',
  'https://mail.google.com/',
];

/** Runs `fn` over items with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function checkScopes(scope: string | undefined, access: AccessKind) {
  const granted = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  const needed = access === 'read' ? GMAIL_SCOPES.readonly : GMAIL_SCOPES.send;
  if (!granted.has(needed)) throw new MissingScopeError('gmail', [needed]);
  if (access === 'read' && WRITE_GMAIL_SCOPES.some((s) => granted.has(s))) {
    // include_granted_scopes=false should make this impossible; refuse rather than store it.
    throw new ConnectorError('gmail', 'read grant unexpectedly includes write scopes');
  }
}

/** Catalog entry. The Google Workspace sources (calendar, drive, chat) are added in Phase 5. */
export const GMAIL_INFO: ConnectorInfo = {
  name: 'Google',
  covers: 'Gmail, Calendar, Drive · one sign-in each',
  multiAccountNote: null,
  sources: [{ id: 'mail', label: 'Gmail', hint: null, kind: 'email', defaultOn: true }],
  options: [],
  writeActions: ['gmail.send'],
};

export function createGmailConnector(opts: GmailConnectorOptions = {}): Connector<GmailRecord> {
  const cfg = (): GmailConfig =>
    typeof opts.config === 'function' ? opts.config() : (opts.config ?? gmailConfigFromEnv());
  const store = () => opts.fakeStore ?? defaultFakeStore();
  const factoryFor = (c: GmailConfig): GmailClientFactory =>
    opts.clientFactory ??
    (c.fake
      ? fakeClientFactory(store(), {
          ...(c.historyPageSize ? { historyPageSize: c.historyPageSize } : {}),
          ...opts.fakeClientOptions,
        })
      : realClientFactory(c));

  const verifiers = new Map<string, OidcVerifier>();
  const verifierFor = (c: GmailConfig): OidcVerifier | null => {
    if (opts.verifier) return opts.verifier;
    if (!c.pubsubAudience || !c.pubsubServiceAccount) return null;
    const key = `${c.pubsubAudience}|${c.pubsubServiceAccount}`;
    let v = verifiers.get(key);
    if (!v) {
      v = createPubSubVerifier({
        audience: c.pubsubAudience,
        serviceAccountEmail: c.pubsubServiceAccount,
      });
      verifiers.set(key, v);
    }
    return v;
  };

  /**
   * Builds a client for the context, maps provider errors to typed errors, and persists
   * refreshed tokens through ctx.saveTokens before returning.
   */
  async function withClient<T>(
    ctx: ConnectorContext,
    fn: (api: GmailApi, c: GmailConfig) => Promise<T>,
  ): Promise<T> {
    const c = cfg();
    const pending: Promise<void>[] = [];
    const api = factoryFor(c)({
      tokens: ctx.tokens,
      externalId: ctx.externalId,
      onTokens: (t) => {
        const merged: OAuthTokens = { ...ctx.tokens, ...t };
        if (!t.refreshToken && ctx.tokens.refreshToken)
          merged.refreshToken = ctx.tokens.refreshToken;
        ctx.tokens = merged;
        pending.push(ctx.saveTokens(merged));
      },
    });
    try {
      return await fn(api, c);
    } catch (e) {
      throw mapGmailError(e);
    } finally {
      await Promise.allSettled(pending);
    }
  }

  async function fetchMessages(api: GmailApi, ids: string[], accountEmail: string) {
    const got = await mapLimit(ids, 5, async (id) => {
      try {
        return await api.getMessage(id);
      } catch (e) {
        // Deleted between the history entry and our fetch.
        if (httpStatusOf(e) === 404) return null;
        throw e;
      }
    });
    return got
      .filter((m): m is GmailMessage => !!m)
      .map((message): GmailRecord => ({ message, accountEmail }));
  }

  async function watch(ctx: ConnectorContext): Promise<SubscriptionInfo> {
    return withClient(ctx, async (api, c) => {
      if (!c.fake && !c.pubsubTopic)
        throw new ConnectorError('gmail', 'GMAIL_PUBSUB_TOPIC is not set');
      const topicName = c.pubsubTopic ?? 'projects/hub-fake/topics/gmail';
      const res = await api.watch({
        topicName,
        labelIds: watchLabelIds(ctx.filters),
        labelFilterBehavior: 'include',
      });
      return {
        externalSubId: topicName,
        expiresAt: res.expiration ? new Date(Number(res.expiration)) : null,
        cursor: res.historyId ?? null,
      };
    });
  }

  const connector: Connector<GmailRecord> = {
    provider: 'gmail',
    info: GMAIL_INFO,
    configured() {
      const c = cfg();
      return c.fake || (!!c.clientId && !!c.clientSecret);
    },

    connect: {
      authUrl({ state, redirectUri, access, loginHint }) {
        const c = cfg();
        if (c.fake)
          return fakeAuth(store()).authUrl({
            state,
            redirectUri,
            access,
            ...(loginHint ? { loginHint } : {}),
          });
        return oauthClient(c, redirectUri).generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          include_granted_scopes: false,
          scope: access === 'read' ? READ_SCOPES : WRITE_SCOPES,
          state,
          ...(loginHint ? { login_hint: loginHint } : {}),
        });
      },

      async exchange({ code, redirectUri, access }) {
        const c = cfg();
        if (c.fake) {
          const out = await fakeAuth(store()).exchange(code);
          if (access) checkScopes(out.tokens.scope, access);
          return out;
        }
        const client = oauthClient(c, redirectUri);
        let creds;
        try {
          creds = (await client.getToken({ code, redirect_uri: redirectUri })).tokens;
        } catch (e) {
          const mapped = mapGmailError(e);
          throw mapped instanceof ConnectorError
            ? new ConnectorError('gmail', 'oauth code exchange failed', {
                status: mapped.status ?? 400,
              })
            : mapped;
        }
        const tokens = fromCredentials(creds);
        if (access) checkScopes(tokens.scope, access);
        let externalId: string | null = null;
        let displayName: string | null = null;
        if (creds.id_token) {
          const ticket = await client.verifyIdToken({
            idToken: creds.id_token,
            audience: c.clientId!,
          });
          const p = ticket.getPayload();
          if (p?.email && p.email_verified) externalId = p.email.toLowerCase();
          displayName = p?.name ?? null;
        }
        if (!externalId) {
          const ctx: ConnectorContext = {
            accountId: '',
            externalId: '',
            tokens,
            saveTokens: async () => {},
            cursor: null,
            filters: {
              inbox: true,
              sent: true,
              promotions: false,
              labels: [],
              sources: {},
              options: {},
            },
          };
          const profile = await withClient(ctx, (api) => api.getProfile());
          externalId = profile.emailAddress?.toLowerCase() ?? null;
        }
        if (!externalId) throw new ConnectorError('gmail', 'could not determine the Gmail address');
        return { tokens, externalId, displayName };
      },

      async revoke(tokens) {
        const c = cfg();
        if (c.fake) return;
        const client = oauthClient(c);
        try {
          await client.revokeToken(tokens.refreshToken ?? tokens.accessToken);
        } catch (e) {
          // 400 = already invalid/revoked, which is what we wanted.
          if (httpStatusOf(e) === 400) return;
          throw mapGmailError(e);
        }
      },
    },

    subscribe: watch,
    /** Re-watch. The returned cursor must not overwrite a stored one. */
    renew: watch,

    async unsubscribe(ctx) {
      await withClient(ctx, (api) => api.stop());
    },

    async verifyWebhook(req): Promise<VerifyResult> {
      const c = cfg();
      const token = bearerToken(req.headers);
      if (token) {
        const verifier = verifierFor(c);
        if (!verifier) return { ok: false, reason: 'push verification not configured' };
        const r = await verifier(token);
        if (!r.ok) return { ok: false, reason: r.reason };
      } else if (!c.fake) {
        return { ok: false, reason: 'missing bearer token' };
      }
      // Unsigned pushes reach this point only in fake mode (GMAIL_FAKE=1, never production).
      const env = PubSubPush.safeParse(req.body);
      if (!env.success) return { ok: false, reason: 'bad push envelope' };
      let note;
      try {
        note = GmailNotification.safeParse(
          JSON.parse(Buffer.from(env.data.message.data, 'base64').toString('utf8')),
        );
      } catch {
        return { ok: false, reason: 'bad push data' };
      }
      if (!note.success) return { ok: false, reason: 'bad push data' };
      const messageId = (env.data.message.messageId ?? env.data.message.message_id)!;
      return {
        ok: true,
        events: [
          {
            providerEventId: messageId,
            externalAccountId: note.data.emailAddress.trim().toLowerCase(),
            payload: {
              historyId: note.data.historyId,
              messageId,
              ...(env.data.message.publishTime
                ? { publishTime: env.data.message.publishTime }
                : {}),
            },
          },
        ],
      };
    },

    async fetchDelta(ctx) {
      return withClient(ctx, async (api, c) => {
        if (!ctx.cursor) {
          const p = await api.getProfile();
          return { records: [], cursor: p.historyId ?? null };
        }
        const ids = new Set<string>();
        let cursor: string = ctx.cursor;
        let pageToken: string | undefined;
        try {
          do {
            const res = await api.listHistory({
              startHistoryId: ctx.cursor,
              historyTypes: ['messageAdded'],
              maxResults: c.historyPageSize ?? 500,
              ...(pageToken ? { pageToken } : {}),
            });
            for (const h of res.history ?? []) {
              for (const added of h.messagesAdded ?? []) {
                if (added.message?.id) ids.add(added.message.id);
              }
            }
            if (res.historyId) cursor = res.historyId;
            pageToken = res.nextPageToken ?? undefined;
          } while (pageToken);
        } catch (e) {
          if (httpStatusOf(e) === 404) {
            // History too old (or cursor invalid): restart from now, caller backfills.
            const p = await api.getProfile();
            return { records: [], cursor: p.historyId ?? null, fullResyncRequired: true };
          }
          throw e;
        }
        const records = await fetchMessages(api, [...ids], ctx.externalId);
        return { records, cursor };
      });
    },

    async backfill(ctx, { days, pageToken }) {
      return withClient(ctx, async (api, c) => {
        const res = await api.listMessages({
          q: backfillQuery(days, ctx.filters),
          maxResults: c.backfillPageSize ?? 50,
          ...(pageToken ? { pageToken } : {}),
        });
        const ids = (res.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
        const records = await fetchMessages(api, ids, ctx.externalId);
        return { records, nextPageToken: res.nextPageToken ?? null };
      });
    },

    normalize: normalizeGmail,

    accepts: (item, filters) => gmailAccepts(item.labels, filters),

    /**
     * Sends with the write-scope (gmail.send) token in `ctx`. Call `findExecuted` first
     * with the *read* token context: gmail.send cannot search the mailbox.
     */
    async execute(ctx, action, payload, idempotencyKey) {
      if (action !== 'gmail.send')
        throw new ConnectorError('gmail', `unsupported action ${action}`);
      const p = GmailSendPayload.parse(payload);
      const raw = toBase64Url(buildMime({ from: ctx.externalId, payload: p, idempotencyKey }));
      return withClient(ctx, async (api) => {
        const res = await api.sendMessage({ raw, ...(p.threadId ? { threadId: p.threadId } : {}) });
        if (!res.id) throw new ConnectorError('gmail', 'send returned no id');
        return {
          externalId: res.id,
          threadId: res.threadId ?? null,
          messageId: messageIdFor(idempotencyKey),
        };
      });
    },

    /** Looks for a sent message carrying the deterministic Message-ID for this key. */
    async findExecuted(ctx, action, idempotencyKey) {
      if (action !== 'gmail.send') return null;
      return withClient(ctx, async (api) => {
        const res = await api.listMessages({
          q: `rfc822msgid:${rfc822SearchId(idempotencyKey)}`,
          includeSpamTrash: true,
          maxResults: 1,
        });
        const hit = res.messages?.[0];
        if (!hit?.id) return null;
        return {
          externalId: hit.id,
          threadId: hit.threadId ?? null,
          messageId: messageIdFor(idempotencyKey),
        };
      });
    },
  };
  return connector;
}
