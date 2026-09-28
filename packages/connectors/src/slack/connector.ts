import { SlackPostPayload } from '@hub/shared';
import {
  ConnectorError,
  MissingScopeError,
  ReconnectRequiredError,
  RetryableError,
} from '../errors';
import { sha256Hex } from '../lib/crypto';
import type { FetchFn } from '../lib/http';
import type {
  AccessKind,
  Connector,
  ConnectorContext,
  ConnectorInfo,
  ExecuteResult,
  OAuthTokens,
} from '../types';
import {
  createSlackHttp,
  splitExternalId,
  tokensFrom,
  tsToMicros,
  type AuthTest,
  type OAuthV2Response,
  type SearchResponse,
  type SlackHttp,
  type SlackMessage,
  type SlackUser,
} from './api';
import {
  accessOfTokens,
  clientFor,
  FAKE_SIGNING_SECRET,
  isWriteScope,
  SLACK_READ_SCOPES,
  SLACK_WRITE_SCOPES,
  slackConfigFromEnv,
  type SlackConfig,
} from './config';
import {
  decodeCursor,
  deltaQuery,
  encodeCursor,
  initialCursor,
  scanDelta,
  searchDate,
} from './delta';
import {
  defaultFakeSlackStore,
  fakeSlackAuthUrl,
  fakeSlackFetch,
  type FakeSlackStore,
} from './fake';
import {
  conversationType,
  isNoise,
  mentionedUserIds,
  normalizeSlack,
  passesOptions,
  slackAccepts,
  slackOptions,
  threadTsOf,
  type SlackRecord,
} from './normalize';
import { checkSlackSignature, mapSlackBody, parseBody } from './webhook';

export const SLACK_SOURCE = 'messages';

export const SLACK_INFO: ConnectorInfo = {
  name: 'Slack',
  covers: 'One per workspace',
  multiAccountNote: 'One per workspace',
  sources: [
    {
      id: SLACK_SOURCE,
      label: 'Messages',
      hint: 'Channels, threads and DMs',
      kind: 'chat',
      defaultOn: true,
    },
  ],
  options: [
    {
      key: 'channels',
      label: 'Channels',
      hint: 'Which channel messages to read',
      type: 'choice',
      choices: [
        { value: 'joined', label: 'Channels I’m in' },
        { value: 'mentions', label: 'Only messages that mention me' },
      ],
      default: 'joined',
    },
    {
      key: 'dms',
      label: 'Direct messages',
      hint: 'DMs and group DMs',
      type: 'boolean',
      default: true,
    },
  ],
  writeActions: ['slack.post'],
};

/** Message metadata type the executor stamps on every post (findExecuted looks for it). */
export const HUB_EVENT_TYPE = 'hub_action';

export type SlackConnectorOptions = {
  config?: SlackConfig | (() => SlackConfig);
  /** Replays recorded responses in tests. Defaults to the fake API in fake mode, else fetch. */
  fetch?: FetchFn;
  fakeStore?: FakeSlackStore;
  now?: () => number;
  /** search.messages page size and pages per delta call (small in tests). */
  pageSize?: number;
  maxPagesPerDelta?: number;
};

const MAX_BACKFILL_DAYS = 90;
const MAX_BACKFILL_PAGES = 20;
const MAX_USER_LOOKUPS = 100;
const MEMBERSHIP_TTL_MS = 10 * 60_000;
const LOOKUP_DAYS = 3;

const displayName = (u: SlackUser) =>
  u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;

function checkScopes(scope: string | undefined, access: AccessKind) {
  const granted = new Set((scope ?? '').split(/[\s,]+/).filter(Boolean));
  const needed: readonly string[] = access === 'read' ? SLACK_READ_SCOPES : SLACK_WRITE_SCOPES;
  const missing = needed.filter((s) => !granted.has(s));
  if (missing.length) throw new MissingScopeError('slack', missing);
  if (access === 'read' && [...granted].some(isWriteScope)) {
    throw new ConnectorError('slack', 'read grant unexpectedly includes write scopes');
  }
}

function assertSource(source: string | undefined) {
  if (source && source !== SLACK_SOURCE) {
    throw new ConnectorError('slack', `unknown source ${source}`);
  }
}

const teamDomainOf = (url: string | undefined): string | null => {
  const m = /^https:\/\/([a-z0-9-]+)\.slack\.com\/?/i.exec(url ?? '');
  return m ? m[1]!.toLowerCase() : null;
};

export function createSlackConnector(opts: SlackConnectorOptions = {}): Connector<SlackRecord> {
  const cfg = (): SlackConfig =>
    typeof opts.config === 'function' ? opts.config() : (opts.config ?? slackConfigFromEnv());
  const now = opts.now ?? Date.now;
  const store = () => opts.fakeStore ?? defaultFakeSlackStore();
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPagesPerDelta ?? 5;

  let fakeFetch: FetchFn | null = null;
  const apiFor = (c: SlackConfig): SlackHttp => {
    if (opts.fetch) return createSlackHttp(c.apiBase, opts.fetch);
    if (c.fake) {
      fakeFetch ??= fakeSlackFetch(store(), { now });
      return createSlackHttp(c.apiBase, fakeFetch);
    }
    return createSlackHttp(c.apiBase);
  };

  // Public channels the user is a member of, per account (search also returns others).
  const membership = new Map<string, { at: number; ids: Set<string> }>();

  async function refresh(c: SlackConfig, api: SlackHttp, t: OAuthTokens): Promise<OAuthTokens> {
    if (!t.refreshToken)
      throw new ReconnectRequiredError('slack', 'token expired, no refresh token');
    const { clientId, clientSecret } = clientFor(c, accessOfTokens(c, t.scope));
    const r = await api.call<OAuthV2Response>('oauth.v2.access', {
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: t.refreshToken,
      },
    });
    const next = tokensFrom(r, now());
    return {
      ...next,
      refreshToken: next.refreshToken ?? t.refreshToken,
      ...(next.scope || t.scope ? { scope: next.scope ?? t.scope } : {}),
    };
  }

  /**
   * Runs `fn` with a valid user token. Rotated tokens (Slack token rotation) refresh a
   * minute before expiry, or once on `token_expired`; new tokens go to ctx.saveTokens.
   */
  async function withToken<T>(
    ctx: ConnectorContext,
    fn: (token: string, api: SlackHttp, c: SlackConfig) => Promise<T>,
  ): Promise<T> {
    const c = cfg();
    const api = apiFor(c);
    const renew = async () => {
      const next = await refresh(c, api, ctx.tokens);
      await ctx.saveTokens(next);
      ctx.tokens = next;
    };
    const t = ctx.tokens;
    if (t.expiresAt && t.expiresAt - now() <= 60_000) await renew();
    try {
      return await fn(ctx.tokens.accessToken, api, c);
    } catch (e) {
      if (
        e instanceof ReconnectRequiredError &&
        e.message.endsWith('token_expired') &&
        ctx.tokens.refreshToken
      ) {
        await renew();
        return fn(ctx.tokens.accessToken, api, c);
      }
      throw e;
    }
  }

  async function memberPublicChannels(ctx: ConnectorContext, api: SlackHttp, token: string) {
    const hit = membership.get(ctx.accountId);
    if (hit && now() - hit.at < MEMBERSHIP_TTL_MS) return hit.ids;
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await api.call<{
        channels?: { id: string }[];
        response_metadata?: { next_cursor?: string };
      }>('users.conversations', {
        token,
        query: { types: 'public_channel', exclude_archived: true, limit: 200, cursor },
      });
      for (const ch of r.channels ?? []) ids.add(ch.id);
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    membership.set(ctx.accountId, { at: now(), ids });
    return ids;
  }

  /** users.info, cached for the duration of one call. Unknown users resolve to null. */
  function userResolver(api: SlackHttp, token: string) {
    const cache = new Map<string, SlackUser | null>();
    let lookups = 0;
    return async (id: string): Promise<SlackUser | null> => {
      if (cache.has(id)) return cache.get(id)!;
      if (lookups >= MAX_USER_LOOKUPS) return null;
      lookups += 1;
      let user: SlackUser | null;
      try {
        user =
          (await api.call<{ user?: SlackUser }>('users.info', { token, query: { user: id } }))
            .user ?? null;
      } catch (e) {
        if (e instanceof ReconnectRequiredError || e instanceof RetryableError) throw e;
        user = null; // user_not_found, user_not_visible
      }
      cache.set(id, user);
      return user;
    };
  }

  /** Applies noise and option filters and resolves names; turns matches into records. */
  async function toRecords(
    ctx: ConnectorContext,
    api: SlackHttp,
    token: string,
    matches: SlackMessage[],
  ): Promise<SlackRecord[]> {
    const { teamId, userId } = splitExternalId(ctx.externalId);
    const options = slackOptions(ctx.filters);
    const candidates = matches
      .filter((m) => m.channel?.id && !isNoise(m))
      .map((m) => ({ m, type: conversationType(m.channel!) }))
      .filter(({ m, type }) => passesOptions(options, type, m, userId));
    let joined: Set<string> | null = null;
    if (options.channels === 'joined' && candidates.some((x) => x.type === 'channel')) {
      joined = await memberPublicChannels(ctx, api, token);
    }
    const resolve = userResolver(api, token);
    const teamDomain =
      (typeof ctx.meta?.teamDomain === 'string' ? ctx.meta.teamDomain : null) ??
      teamDomainOf(candidates[0]?.m.permalink);
    const out: SlackRecord[] = [];
    for (const { m, type } of candidates) {
      if (type === 'channel' && joined && !joined.has(m.channel!.id)) continue;
      const author = m.user ? await resolve(m.user) : null;
      if (author?.is_bot) continue;
      const names: Record<string, string> = {};
      for (const id of mentionedUserIds(m.text)) {
        const u = await resolve(id);
        if (u) names[id] = displayName(u);
      }
      const { channel, ...message } = m;
      out.push({
        teamId,
        teamDomain,
        selfUserId: userId,
        channel: {
          id: channel!.id,
          type,
          name: type === 'channel' || type === 'group' ? (channel!.name ?? null) : null,
        },
        message,
        authorName: author ? displayName(author) : null,
        names,
      });
    }
    return out;
  }

  const search = (api: SlackHttp, token: string, query: string, page: number, count = pageSize) =>
    api.call<SearchResponse>('search.messages', {
      token,
      query: { query, sort: 'timestamp', sort_dir: 'desc', count, page, highlight: false },
    });

  /** Looks for a message by the user carrying our metadata key in one conversation. */
  async function findInConversation(
    api: SlackHttp,
    token: string,
    userId: string,
    keyHash: string,
    where: { channel: string; threadTs: string | null; oldest: string; latest: string },
  ): Promise<SlackMessage | null> {
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const r = await api.call<{
        messages?: SlackMessage[];
        response_metadata?: { next_cursor?: string };
      }>(where.threadTs ? 'conversations.replies' : 'conversations.history', {
        token,
        query: {
          channel: where.channel,
          ...(where.threadTs ? { ts: where.threadTs } : {}),
          oldest: where.oldest,
          latest: where.latest,
          inclusive: true,
          limit: 200,
          include_all_metadata: true,
          cursor,
        },
      });
      const hit = (r.messages ?? []).find(
        (m) =>
          m.user === userId &&
          m.metadata?.event_type === HUB_EVENT_TYPE &&
          m.metadata.event_payload?.key === keyHash,
      );
      if (hit) return hit;
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return null;
  }

  const connector: Connector<SlackRecord> = {
    provider: 'slack',
    info: SLACK_INFO,

    configured() {
      const c = cfg();
      return c.fake || (!!c.clientId && !!c.clientSecret && !!c.signingSecret);
    },

    connect: {
      authUrl({ state, redirectUri, access, loginHint }) {
        const c = cfg();
        if (c.fake) {
          return fakeSlackAuthUrl(store(), {
            state,
            redirectUri,
            access,
            ...(loginHint ? { loginHint } : {}),
          });
        }
        const u = new URL(c.authorizeUrl);
        u.searchParams.set('client_id', clientFor(c, access).clientId);
        // User-token scopes only; no bot scopes, so no bot token is ever issued.
        u.searchParams.set(
          'user_scope',
          (access === 'read' ? SLACK_READ_SCOPES : SLACK_WRITE_SCOPES).join(','),
        );
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('state', state);
        if (loginHint && /^[TE][A-Z0-9]+$/.test(loginHint)) u.searchParams.set('team', loginHint);
        return u.toString();
      },

      async exchange({ code, redirectUri, access }) {
        const c = cfg();
        const api = apiFor(c);
        const { clientId, clientSecret } = clientFor(c, access ?? 'read');
        const r = await api.call<OAuthV2Response>('oauth.v2.access', {
          form: {
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          },
        });
        const user = r.authed_user;
        const team = r.team;
        if (!user?.id || !user.access_token || !team?.id) {
          throw new ConnectorError('slack', 'oauth response has no user token or team');
        }
        const tokens = tokensFrom(r, now());
        if (access) checkScopes(tokens.scope, access);
        const who = await api.call<AuthTest>('auth.test', { token: tokens.accessToken });
        if (who.user_id !== user.id || who.team_id !== team.id) {
          throw new ConnectorError('slack', 'token identity does not match the consent');
        }
        const externalId = `${team.id}:${user.id}`;
        const displayName = team.name ?? who.team ?? team.id;
        return {
          tokens,
          externalId,
          displayName,
          identities: [
            {
              externalId,
              displayName,
              routeKeys: [team.id],
              meta: {
                teamId: team.id,
                teamName: displayName,
                teamDomain: teamDomainOf(who.url),
                userId: user.id,
                grantedScopes: (tokens.scope ?? '').split(' ').filter(Boolean),
              },
            },
          ],
        };
      },

      async revoke(tokens) {
        const api = apiFor(cfg());
        try {
          await api.call('auth.revoke', { token: tokens.accessToken });
        } catch (e) {
          // Already revoked or expired: that is the goal.
          if (e instanceof ReconnectRequiredError) return;
          throw e;
        }
      },
    },

    /** Slack's Events API subscription is app-level; nothing to create per account. */
    async subscribe(ctx) {
      assertSource(ctx.source);
      return { externalSubId: null, expiresAt: null, cursor: encodeCursor(initialCursor(now())) };
    },

    async renew(ctx) {
      assertSource(ctx.source);
      return { externalSubId: null, expiresAt: null };
    },

    async verifyWebhook(req) {
      const c = cfg();
      const secrets = [c.signingSecret, c.fake ? FAKE_SIGNING_SECRET : undefined].filter(
        (s): s is string => !!s,
      );
      const check = checkSlackSignature(req, secrets, now());
      if (!check.ok) return check;
      return mapSlackBody(parseBody(req));
    },

    async fetchDelta(ctx) {
      assertSource(ctx.source);
      if (!ctx.cursor) return { records: [], cursor: encodeCursor(initialCursor(now())) };
      const cur = decodeCursor(ctx.cursor);
      if (!cur) {
        return {
          records: [],
          cursor: encodeCursor(initialCursor(now())),
          fullResyncRequired: true,
        };
      }
      return withToken(ctx, async (token, api) => {
        const query = deltaQuery(cur);
        const scan = await scanDelta({
          cursor: cur,
          search: (page) => search(api, token, query, page),
          maxPages,
        });
        const records = await toRecords(ctx, api, token, scan.matches);
        return {
          records,
          cursor: encodeCursor(scan.cursor),
          ...(scan.hasMore ? { hasMore: true } : {}),
        };
      });
    },

    /** Messages of the last `days` (1–90), newest first, at most 20 pages of search results. */
    async backfill(ctx, { days, pageToken }) {
      assertSource(ctx.source);
      const d = Math.min(Math.max(1, Math.floor(days) || 1), MAX_BACKFILL_DAYS);
      const page = pageToken ? Number(pageToken) : 1;
      if (!Number.isInteger(page) || page < 1 || page > MAX_BACKFILL_PAGES) {
        return { records: [], nextPageToken: null };
      }
      const cutoffMs = now() - d * 86_400_000;
      return withToken(ctx, async (token, api) => {
        const res = await search(api, token, `after:${searchDate(cutoffMs - 86_400_000)}`, page);
        const all = res.messages?.matches ?? [];
        const matches = all.filter((m) => m.ts && tsToMicros(m.ts) >= cutoffMs * 1000);
        const pages = res.messages?.paging?.pages ?? res.messages?.pagination?.page_count ?? page;
        const reachedCutoff = matches.length < all.length;
        const next =
          !reachedCutoff && all.length > 0 && page < pages && page < MAX_BACKFILL_PAGES
            ? String(page + 1)
            : null;
        return { records: await toRecords(ctx, api, token, matches), nextPageToken: next };
      });
    },

    normalize: (raw) => normalizeSlack(raw),

    accepts: (item, filters) => slackAccepts(item, filters),

    /**
     * Posts as the user with the write-consent token. The message carries Slack message
     * metadata `{event_type:'hub_action', event_payload:{key: sha256(idempotencyKey)}}`
     * so findExecuted can recognise it after a crash.
     */
    async execute(ctx, action, payload, idempotencyKey): Promise<ExecuteResult> {
      if (action !== 'slack.post')
        throw new ConnectorError('slack', `unsupported action ${action}`);
      const p = SlackPostPayload.parse(payload);
      return withToken(ctx, async (token, api) => {
        const res = await api.call<{ channel: string; ts: string }>('chat.postMessage', {
          token,
          body: {
            channel: p.channel,
            text: p.text,
            ...(p.threadTs ? { thread_ts: p.threadTs } : {}),
            // Post the text literally: no @-name linking, no previews of links in it.
            parse: 'none',
            link_names: false,
            unfurl_links: false,
            unfurl_media: false,
            metadata: {
              event_type: HUB_EVENT_TYPE,
              event_payload: { key: sha256Hex(idempotencyKey) },
            },
          },
        });
        if (!res?.ts) throw new ConnectorError('slack', 'chat.postMessage returned no ts');
        const channel = res.channel ?? p.channel;
        return {
          externalId: `${channel}:${res.ts}`,
          channel,
          ts: res.ts,
          threadTs: p.threadTs ?? null,
        };
      });
    },

    /**
     * Finds an earlier post for this key. The interface gives no channel, so: list the
     * user's own recent messages with search.messages (`from:<@me>`, last 3 days), then
     * read those conversations/threads with `include_all_metadata` and match the key.
     * Needs the read token (search:read, *:history), like Gmail's lookup.
     */
    async findExecuted(ctx, action, idempotencyKey) {
      if (action !== 'slack.post') return null;
      const { userId } = splitExternalId(ctx.externalId);
      const keyHash = sha256Hex(idempotencyKey);
      return withToken(ctx, async (token, api) => {
        const since = now() - LOOKUP_DAYS * 86_400_000;
        const res = await search(
          api,
          token,
          `from:<@${userId}> after:${searchDate(since - 86_400_000)}`,
          1,
          50,
        );
        const groups = new Map<
          string,
          { channel: string; threadTs: string | null; oldest: string; latest: string }
        >();
        for (const m of res.messages?.matches ?? []) {
          if (!m.channel?.id || !m.ts || m.user !== userId) continue;
          const thread = threadTsOf(m);
          const threadTs = thread && thread !== m.ts ? thread : null;
          const k = `${m.channel.id}|${threadTs ?? ''}`;
          const g = groups.get(k);
          if (!g) {
            groups.set(k, { channel: m.channel.id, threadTs, oldest: m.ts, latest: m.ts });
          } else {
            if (tsToMicros(m.ts) < tsToMicros(g.oldest)) g.oldest = m.ts;
            if (tsToMicros(m.ts) > tsToMicros(g.latest)) g.latest = m.ts;
          }
        }
        for (const g of groups.values()) {
          const hit = await findInConversation(api, token, userId, keyHash, g);
          if (hit) {
            return {
              externalId: `${g.channel}:${hit.ts}`,
              channel: g.channel,
              ts: hit.ts,
              threadTs: g.threadTs,
            };
          }
        }
        return null;
      });
    },
  };
  return connector;
}
