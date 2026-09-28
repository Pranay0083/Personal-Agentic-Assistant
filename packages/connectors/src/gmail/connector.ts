import { GmailSendPayload } from '@hub/shared';
import { ConnectorError, ReconnectRequiredError } from '../errors';
import { header } from '../lib/crypto';
import type {
  BackfillPage,
  Connector,
  ConnectorContext,
  DeltaResult,
  ExchangeResult,
  Identity,
  OAuthTokens,
  SubscriptionInfo,
  VerifyResult,
  WebhookRequest,
} from '../types';
import { calendarBackfill, calendarDelta, calendarSyncToken } from './calendar';
import { channelAddress, stopChannel, verifyChannelPush, watchChannel } from './channels';
import {
  chatBackfill,
  chatDelta,
  chatEventsFromPush,
  chatProbe,
  createChatSubscription,
  deleteChatSubscription,
  renewChatSubscription,
} from './chat';
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
import { gmailConfigFromEnv, type GmailConfig } from './config';
import { driveBackfill, driveDelta, driveStartPageToken } from './drive';
import { fakeAuth, fakeClientFactory, type FakeClientOptions } from './fake';
import { fakeRestFactory } from './fake-google';
import { defaultFakeStore, type FakeGmailStore } from './fake-store';
import { backfillQuery, watchLabelIds } from './filters';
import { buildMime, messageIdFor, rfc822SearchId, toBase64Url } from './mime';
import type { GmailRecord } from './normalize';
import {
  GmailNotification,
  PubSubPush,
  bearerToken,
  createPubSubVerifier,
  type OidcVerifier,
} from './pubsub';
import { googleAccepts, normalizeGoogle, type GoogleRecord } from './records';
import { realRestFactory, type GoogleRest, type GoogleRestFactory } from './rest';
import {
  GMAIL_INFO,
  READ_SCOPES,
  WRITE_SCOPES,
  checkGrantedScopes,
  sourceGranted,
  sourceOf,
  type GoogleSource,
} from './scopes';
import { mapLimit, sleep as defaultSleep } from './util';

export { GMAIL_INFO } from './scopes';

export type GmailConnectorOptions = {
  /** Defaults to reading process.env on every call (GMAIL_FAKE, GOOGLE_*, GMAIL_PUBSUB_*). */
  config?: GmailConfig | (() => GmailConfig);
  /** Overrides the real/fake Gmail client choice (tests). */
  clientFactory?: GmailClientFactory;
  /** Overrides the real/fake Calendar/Drive/Chat/Events transport (tests). */
  restFactory?: GoogleRestFactory;
  /** Fake-mode store; defaults to the shared file store at <repo>/.dev/fake-gmail.json. */
  fakeStore?: FakeGmailStore;
  fakeClientOptions?: FakeClientOptions;
  /** Gmail Pub/Sub OIDC verifier; defaults to Google certs with GMAIL_PUBSUB_AUDIENCE/SERVICE_ACCOUNT. */
  verifier?: OidcVerifier;
  /** Workspace Events Pub/Sub OIDC verifier; defaults to GOOGLE_EVENTS_PUBSUB_AUDIENCE. */
  eventsVerifier?: OidcVerifier;
  /** Waits between Workspace Events operation polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const EMPTY_FILTERS = {
  inbox: true,
  sent: true,
  promotions: false,
  labels: [],
  sources: {},
  options: {},
};

/** A source the account can't use (not granted, not a Workspace account): nothing to do. */
const unavailableSub = (reason: string): SubscriptionInfo => ({
  externalSubId: null,
  expiresAt: null,
  meta: { unavailable: reason },
});

export function createGmailConnector(opts: GmailConnectorOptions = {}): Connector<GoogleRecord> {
  const cfg = (): GmailConfig =>
    typeof opts.config === 'function' ? opts.config() : (opts.config ?? gmailConfigFromEnv());
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const store = () => opts.fakeStore ?? defaultFakeStore();
  const factoryFor = (c: GmailConfig): GmailClientFactory =>
    opts.clientFactory ??
    (c.fake
      ? fakeClientFactory(store(), {
          ...(c.historyPageSize ? { historyPageSize: c.historyPageSize } : {}),
          ...opts.fakeClientOptions,
        })
      : realClientFactory(c));
  const restFor = (c: GmailConfig): GoogleRestFactory =>
    opts.restFactory ??
    (c.fake ? fakeRestFactory(store(), opts.fakeClientOptions) : realRestFactory(c));

  const verifiers = new Map<string, OidcVerifier>();
  const cachedVerifier = (audience?: string, serviceAccountEmail?: string) => {
    if (!audience || !serviceAccountEmail) return null;
    const key = `${audience}|${serviceAccountEmail}`;
    let v = verifiers.get(key);
    if (!v) {
      v = createPubSubVerifier({ audience, serviceAccountEmail });
      verifiers.set(key, v);
    }
    return v;
  };
  const mailVerifier = (c: GmailConfig) =>
    opts.verifier ?? cachedVerifier(c.pubsubAudience, c.pubsubServiceAccount);
  const eventsVerifier = (c: GmailConfig) =>
    opts.eventsVerifier ??
    cachedVerifier(c.eventsAudience, c.eventsServiceAccount ?? c.pubsubServiceAccount);

  /** Persists refreshed tokens through ctx.saveTokens (merged, keeping the refresh token). */
  function tokenSink(ctx: ConnectorContext, pending: Promise<void>[]) {
    return (t: OAuthTokens) => {
      const merged: OAuthTokens = { ...ctx.tokens, ...t };
      if (!t.refreshToken && ctx.tokens.refreshToken) merged.refreshToken = ctx.tokens.refreshToken;
      ctx.tokens = merged;
      pending.push(ctx.saveTokens(merged));
    };
  }

  /** Gmail client for the context; maps provider errors to typed errors. */
  async function withClient<T>(
    ctx: ConnectorContext,
    fn: (api: GmailApi, c: GmailConfig) => Promise<T>,
  ): Promise<T> {
    const c = cfg();
    const pending: Promise<void>[] = [];
    const api = factoryFor(c)({
      tokens: ctx.tokens,
      externalId: ctx.externalId,
      onTokens: tokenSink(ctx, pending),
    });
    try {
      return await fn(api, c);
    } catch (e) {
      throw mapGmailError(e);
    } finally {
      await Promise.allSettled(pending);
    }
  }

  /** Calendar/Drive/Chat/Events transport for the context; same error mapping. */
  async function withRest<T>(
    ctx: ConnectorContext,
    fn: (rest: GoogleRest, c: GmailConfig) => Promise<T>,
  ): Promise<T> {
    const c = cfg();
    const pending: Promise<void>[] = [];
    const rest = restFor(c)({
      tokens: ctx.tokens,
      externalId: ctx.externalId,
      onTokens: tokenSink(ctx, pending),
    });
    try {
      return await fn(rest, c);
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

  // ---- mail (Gmail) ----

  async function mailWatch(ctx: ConnectorContext): Promise<SubscriptionInfo> {
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

  async function mailDelta(ctx: ConnectorContext): Promise<DeltaResult<GmailRecord>> {
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
  }

  async function mailBackfill(
    ctx: ConnectorContext,
    days: number,
    pageToken?: string,
  ): Promise<BackfillPage<GmailRecord>> {
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
  }

  // ---- calendar + drive (watch channels) ----

  async function channelWatch(
    ctx: ConnectorContext,
    source: 'calendar' | 'drive',
    withCursor: boolean,
  ): Promise<SubscriptionInfo> {
    return withRest(ctx, async (rest, c) => {
      let cursor: string | undefined;
      if (withCursor && !ctx.cursor) {
        cursor =
          source === 'calendar'
            ? await calendarSyncToken(rest, now())
            : await driveStartPageToken(rest);
      }
      const address = channelAddress(c.gatewayUrl, c.fake);
      if (!address) {
        // No https gateway: the source still syncs on the scheduler, just without push.
        return {
          externalSubId: null,
          expiresAt: null,
          ...(cursor ? { cursor } : {}),
          meta: { push: 'disabled' },
        };
      }
      const pageToken =
        source === 'drive'
          ? (ctx.cursor ?? cursor ?? (await driveStartPageToken(rest)))
          : undefined;
      const info = await watchChannel(
        rest,
        source,
        { address, ...(pageToken ? { pageToken } : {}) },
        now(),
      );
      return { ...info, ...(cursor ? { cursor } : {}) };
    });
  }

  async function channelRenew(ctx: ConnectorContext, source: 'calendar' | 'drive') {
    const next = await channelWatch(ctx, source, false);
    // The new channel is live; stop the old one. A failed stop only means the old channel
    // pushes until it expires (the gateway drops it once its sub id is replaced).
    await withRest(ctx, (rest) => stopChannel(rest, source, ctx.subscription)).catch((e) => {
      if (e instanceof ReconnectRequiredError) throw e;
    });
    return next;
  }

  // ---- chat (Workspace Events) ----

  const eventsTopic = (c: GmailConfig) =>
    c.eventsTopic ?? (c.fake ? 'projects/hub-fake/topics/workspace-events' : undefined);

  async function chatSubscribe(ctx: ConnectorContext, withCursor: boolean) {
    return withRest(ctx, async (rest, c): Promise<SubscriptionInfo> => {
      const unavailable = await chatProbe(rest);
      if (unavailable) return unavailableSub(unavailable);
      const cursor = withCursor && !ctx.cursor ? new Date(now()).toISOString() : undefined;
      const topic = eventsTopic(c);
      const base = { ...(cursor ? { cursor } : {}) };
      if (!topic)
        return { externalSubId: null, expiresAt: null, ...base, meta: { push: 'disabled' } };
      try {
        const sub = await createChatSubscription(rest, topic, sleep);
        return {
          externalSubId: sub.name,
          expiresAt: sub.expireTime ? new Date(sub.expireTime) : null,
          ...base,
          meta: { state: sub.state ?? null },
        };
      } catch (e) {
        // Events API refused (e.g. admin policy): Chat still syncs on the scheduler.
        if (httpStatusOf(e) === 403) {
          return { externalSubId: null, expiresAt: null, ...base, meta: { push: 'denied' } };
        }
        throw e;
      }
    });
  }

  async function chatRenew(ctx: ConnectorContext): Promise<SubscriptionInfo> {
    const name = ctx.subscription?.externalSubId;
    if (!name) return chatSubscribe(ctx, false);
    return withRest(ctx, async (rest, c) => {
      const topic = eventsTopic(c);
      if (!topic) return { externalSubId: null, expiresAt: null, meta: { push: 'disabled' } };
      const sub = await renewChatSubscription(rest, name, topic, sleep);
      return {
        externalSubId: sub.name,
        expiresAt: sub.expireTime ? new Date(sub.expireTime) : null,
        meta: { state: sub.state ?? null },
      };
    });
  }

  /** Whether this source is usable for the context; otherwise every call is a no-op. */
  const usable = (ctx: ConnectorContext, source: GoogleSource) =>
    sourceGranted(ctx, source) && !ctx.subscription?.meta?.unavailable;

  async function subscribeSource(ctx: ConnectorContext, renewing: boolean) {
    const source = sourceOf(ctx);
    if (!sourceGranted(ctx, source)) return unavailableSub('scope_not_granted');
    switch (source) {
      case 'mail':
        return mailWatch(ctx);
      case 'calendar':
      case 'drive':
        return renewing && ctx.subscription?.externalSubId
          ? channelRenew(ctx, source)
          : channelWatch(ctx, source, !renewing);
      case 'chat':
        return renewing ? chatRenew(ctx) : chatSubscribe(ctx, true);
    }
  }

  // ---- webhooks ----

  async function verifyOidc(req: WebhookRequest, verifier: OidcVerifier | null, fake: boolean) {
    const token = bearerToken(req.headers);
    if (token) {
      if (!verifier) return { ok: false as const, reason: 'push verification not configured' };
      const r = await verifier(token);
      if (!r.ok) return { ok: false as const, reason: r.reason };
    } else if (!fake) {
      return { ok: false as const, reason: 'missing bearer token' };
    }
    // Unsigned pushes get past this point only in fake mode (never production).
    return null;
  }

  function mailEvents(env: PubSubPush): VerifyResult {
    let note;
    try {
      note = GmailNotification.safeParse(
        JSON.parse(Buffer.from(env.message.data, 'base64').toString('utf8')),
      );
    } catch {
      return { ok: false, reason: 'bad push data' };
    }
    if (!note.success) return { ok: false, reason: 'bad push data' };
    const messageId = (env.message.messageId ?? env.message.message_id)!;
    return {
      ok: true,
      events: [
        {
          providerEventId: messageId,
          externalAccountId: note.data.emailAddress.trim().toLowerCase(),
          source: 'mail',
          payload: {
            historyId: note.data.historyId,
            messageId,
            ...(env.message.publishTime ? { publishTime: env.message.publishTime } : {}),
          },
        },
      ],
    };
  }

  /** Which receiver a request is for: the gateway sub-path, else sniffed from its shape. */
  function hookKind(req: WebhookRequest): 'mail' | 'channel' | 'events' | null {
    if (req.channel === 'channel') return 'channel';
    if (req.channel === 'events') return 'events';
    if (req.channel) return null;
    if (header(req.headers, 'x-goog-channel-id')) return 'channel';
    const attrs = (req.body as { message?: { attributes?: Record<string, unknown> } } | null)
      ?.message?.attributes;
    if (attrs && typeof attrs['ce-type'] === 'string') return 'events';
    return 'mail';
  }

  const connector: Connector<GoogleRecord> = {
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
        let out: ExchangeResult;
        if (c.fake) {
          out = await fakeAuth(store()).exchange(code);
        } else {
          out = await realExchange(c, code, redirectUri);
        }
        const granted = access ? checkGrantedScopes(out.tokens.scope, access) : null;
        const first = out.identities?.[0] ?? {
          externalId: out.externalId,
          displayName: out.displayName,
        };
        const meta = { ...first.meta };
        // Only the read grant decides which sources sync; a write consent records nothing.
        if (access === 'read' && granted) meta.grantedScopes = granted;
        else delete meta.grantedScopes;
        const identity: Identity = {
          externalId: first.externalId,
          displayName: first.displayName,
          routeKeys: first.routeKeys ?? [first.externalId],
          meta,
        };
        return { ...out, identities: [identity] };
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

    subscribe: (ctx) => subscribeSource(ctx, false),
    /** Re-watch / extend. The returned info never carries a cursor for channel sources. */
    renew: (ctx) => subscribeSource(ctx, true),

    async unsubscribe(ctx) {
      const source = sourceOf(ctx);
      if (!sourceGranted(ctx, source)) return;
      switch (source) {
        case 'mail':
          await withClient(ctx, (api) => api.stop());
          return;
        case 'calendar':
        case 'drive':
          await withRest(ctx, (rest) => stopChannel(rest, source, ctx.subscription));
          return;
        case 'chat': {
          const name = ctx.subscription?.externalSubId;
          if (name) await withRest(ctx, (rest) => deleteChatSubscription(rest, name));
          return;
        }
      }
    },

    async verifyWebhook(req): Promise<VerifyResult> {
      const c = cfg();
      const kind = hookKind(req);
      if (!kind) return { ok: false, reason: 'unknown hook path' };
      // Channel pushes carry no signature; the gateway checks the token against secretHash.
      if (kind === 'channel') return verifyChannelPush(req);
      const denied = await verifyOidc(
        req,
        kind === 'events' ? eventsVerifier(c) : mailVerifier(c),
        c.fake,
      );
      if (denied) return denied;
      const env = PubSubPush.safeParse(req.body);
      if (!env.success) return { ok: false, reason: 'bad push envelope' };
      return kind === 'events' ? chatEventsFromPush(env.data) : mailEvents(env.data);
    },

    async fetchDelta(ctx): Promise<DeltaResult<GoogleRecord>> {
      const source = sourceOf(ctx);
      if (!usable(ctx, source)) return { records: [], cursor: ctx.cursor };
      switch (source) {
        case 'mail':
          return mailDelta(ctx);
        case 'calendar':
          return withRest(ctx, (rest) =>
            calendarDelta(rest, { cursor: ctx.cursor, accountEmail: ctx.externalId }),
          );
        case 'drive':
          return withRest(ctx, (rest) =>
            driveDelta(rest, { cursor: ctx.cursor, accountEmail: ctx.externalId }),
          );
        case 'chat':
          return withRest(ctx, (rest) =>
            chatDelta(rest, { cursor: ctx.cursor, selfUserId: selfUserId(ctx) }, now()),
          );
      }
    },

    async backfill(ctx, { days, pageToken }): Promise<BackfillPage<GoogleRecord>> {
      const source = sourceOf(ctx);
      if (!usable(ctx, source)) return { records: [], nextPageToken: null };
      const page = pageToken ? { pageToken } : {};
      switch (source) {
        case 'mail':
          return mailBackfill(ctx, days, pageToken);
        case 'calendar':
          return withRest(ctx, (rest) =>
            calendarBackfill(rest, { days, ...page, accountEmail: ctx.externalId }, now()),
          );
        case 'drive':
          return withRest(ctx, (rest) =>
            driveBackfill(rest, { days, ...page, accountEmail: ctx.externalId }, now()),
          );
        case 'chat':
          return withRest(ctx, (rest) =>
            chatBackfill(rest, { days, ...page, selfUserId: selfUserId(ctx) }, now()),
          );
      }
    },

    normalize: normalizeGoogle,

    accepts: googleAccepts,

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

  /** Real Google code exchange: tokens, verified id_token identity (email, sub, hd). */
  async function realExchange(
    c: GmailConfig,
    code: string,
    redirectUri: string,
  ): Promise<ExchangeResult> {
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
    let externalId: string | null = null;
    let displayName: string | null = null;
    const meta: Record<string, unknown> = {};
    if (creds.id_token) {
      const ticket = await client.verifyIdToken({
        idToken: creds.id_token,
        audience: c.clientId!,
      });
      const p = ticket.getPayload();
      if (p?.email && p.email_verified) externalId = p.email.toLowerCase();
      displayName = p?.name ?? null;
      // `sub` is the Google account id Chat uses in `users/<id>`; `hd` marks Workspace accounts.
      if (p?.sub) meta.googleUserId = p.sub;
      if (p?.hd) meta.hostedDomain = p.hd;
    }
    if (!externalId && tokens.scope?.includes('gmail.readonly')) {
      const ctx: ConnectorContext = {
        accountId: '',
        externalId: '',
        tokens,
        saveTokens: async () => {},
        cursor: null,
        filters: EMPTY_FILTERS,
      };
      const profile = await withClient(ctx, (api) => api.getProfile());
      externalId = profile.emailAddress?.toLowerCase() ?? null;
    }
    if (!externalId) throw new ConnectorError('gmail', 'could not determine the Google account');
    return {
      tokens,
      externalId,
      displayName,
      identities: [{ externalId, displayName, routeKeys: [externalId], meta }],
    };
  }

  return connector;
}

/** Google account id of the owner, recorded at connect time (accounts.meta.googleUserId). */
function selfUserId(ctx: ConnectorContext): string | null {
  const v = ctx.meta?.googleUserId;
  return typeof v === 'string' && v ? v : null;
}
