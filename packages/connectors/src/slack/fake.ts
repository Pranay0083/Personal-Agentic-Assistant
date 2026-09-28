import { randomBytes } from 'node:crypto';
import { defaultFakePath, fixture, JsonFileStore, MemoryStore, type Store } from '../lib/fake';
import type { FetchFn } from '../lib/http';
import { microsToTs, tsToMicros } from './api';
import { SLACK_READ_SCOPES, SLACK_WRITE_SCOPES } from './config';
import type { ConversationType } from './normalize';

/**
 * Fake Slack for CONNECTORS_FAKE=1: a `fetch` that answers the Web API methods the
 * connector calls, from a JSON store shared by api, gateway, workers and the fake:slack
 * script. The real connector code runs unchanged against it. Never used in production.
 */
export type FakeSlackUser = {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  is_bot?: boolean;
};
export type FakeSlackConversation = {
  id: string;
  name: string | null;
  type: ConversationType;
  members: string[];
};
export type FakeSlackMessage = {
  channel: string;
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  thread_ts?: string;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
};
export type FakeWorkspace = {
  team: { id: string; name: string; domain: string };
  selfUserId: string;
  users: FakeSlackUser[];
  conversations: FakeSlackConversation[];
  messages: FakeSlackMessage[];
  revokedTokens: string[];
};
export type FakeSlackState = {
  connectCounter: number;
  lastTs: number;
  workspaces: FakeWorkspace[];
};

type SeedMessage = Omit<FakeSlackMessage, 'ts' | 'thread_ts'> & {
  minutesAgo: number;
  threadOf?: number;
};
type Seed = {
  workspaces: (Omit<FakeWorkspace, 'messages' | 'revokedTokens'> & { messages: SeedMessage[] })[];
};

export function seedFakeSlack(now = Date.now()): FakeSlackState {
  const seed = fixture<Seed>(import.meta.url, 'fake-workspaces.json');
  let lastTs = 0;
  const tsFor = (minutesAgo: number) => microsToTs((now - minutesAgo * 60_000) * 1000);
  const workspaces = seed.workspaces.map((w): FakeWorkspace => {
    const messages = w.messages.map(({ minutesAgo, threadOf, ...m }): FakeSlackMessage => {
      const ts = tsFor(minutesAgo);
      lastTs = Math.max(lastTs, tsToMicros(ts));
      return {
        ...m,
        ts,
        ...(threadOf !== undefined ? { thread_ts: tsFor(threadOf) } : {}),
      };
    });
    // Thread parents carry their own ts as thread_ts, like Slack.
    for (const m of messages) {
      if (messages.some((r) => r.thread_ts === m.ts && r.channel === m.channel)) {
        m.thread_ts = m.ts;
      }
    }
    return { ...w, messages, revokedTokens: [] };
  });
  return { connectCounter: 0, lastTs, workspaces };
}

export class FakeSlackStore {
  constructor(readonly store: Store<FakeSlackState>) {}

  workspaces(): FakeWorkspace[] {
    return this.store.read().workspaces;
  }

  /** By team id, domain or name (case-insensitive). */
  workspace(ref: string): FakeWorkspace | undefined {
    const r = ref.toLowerCase();
    return this.workspaces().find(
      (w) =>
        w.team.id.toLowerCase() === r ||
        w.team.domain.toLowerCase() === r ||
        w.team.name.toLowerCase() === r,
    );
  }

  pickForConnect(hint?: string): string {
    return this.store.update((s) => {
      const hit = hint
        ? s.workspaces.find((w) => [w.team.id, w.team.domain].includes(hint))
        : undefined;
      if (hit) return hit.team.id;
      const w = s.workspaces[s.connectCounter % s.workspaces.length]!;
      s.connectCounter += 1;
      return w.team.id;
    });
  }

  /** Appends a message (as Slack would store it) and returns it. */
  appendMessage(
    teamRef: string,
    m: { channel: string; user: string; text: string; threadTs?: string },
    nowMs = Date.now(),
  ): FakeSlackMessage {
    return this.store.update((s) => {
      const w = s.workspaces.find((x) => x.team.id === teamRef || x.team.domain === teamRef);
      if (!w) throw new Error(`no fake workspace ${teamRef}`);
      if (!w.conversations.some((c) => c.id === m.channel)) {
        throw new Error(`no conversation ${m.channel} in ${w.team.id}`);
      }
      const us = Math.max(nowMs * 1000, s.lastTs + 100);
      s.lastTs = us;
      const msg: FakeSlackMessage = {
        channel: m.channel,
        ts: microsToTs(us),
        user: m.user,
        text: m.text,
      };
      if (m.threadTs) {
        const parent = w.messages.find((p) => p.channel === m.channel && p.ts === m.threadTs);
        if (!parent) throw new Error(`no parent message ${m.threadTs} in ${m.channel}`);
        parent.thread_ts = parent.ts;
        msg.thread_ts = m.threadTs;
      }
      w.messages.push(msg);
      return msg;
    });
  }

  /** Simulates the user revoking the app (every token of the workspace stops working). */
  revokeAll(teamRef: string): void {
    this.store.update((s) => {
      const w = s.workspaces.find((x) => x.team.id === teamRef || x.team.domain === teamRef);
      if (w) w.revokedTokens.push(`*`);
    });
  }
}

export const DEFAULT_FAKE_SLACK_PATH = () => defaultFakePath('slack');

let shared: FakeSlackStore | null = null;
/** The file store at <repo>/.dev/fake-slack.json, shared across processes. */
export function defaultFakeSlackStore(): FakeSlackStore {
  shared ??= new FakeSlackStore(
    new JsonFileStore<FakeSlackState>(DEFAULT_FAKE_SLACK_PATH(), () => seedFakeSlack()),
  );
  return shared;
}

export function memoryFakeSlackStore(now = Date.now()): FakeSlackStore {
  return new FakeSlackStore(new MemoryStore(() => seedFakeSlack(now)));
}

/** Fake consent screen: straight back to the redirect with `code=fake:<team>`. */
export function fakeSlackAuthUrl(
  store: FakeSlackStore,
  opts: { state: string; redirectUri: string; access: 'read' | 'write'; loginHint?: string },
): string {
  const team = store.pickForConnect(opts.loginHint);
  const url = new URL(opts.redirectUri);
  url.searchParams.set('code', `${opts.access === 'write' ? 'fake-write' : 'fake'}:${team}`);
  url.searchParams.set('state', opts.state);
  return url.toString();
}

// ---- The fake Web API ----

type Params = Record<string, string | undefined> & { __json?: Record<string, unknown> };
type TokenInfo = { team: string; user: string; kind: 'r' | 'w'; exp: number; raw: string };

const TOKEN_TTL_S = 12 * 3600;

function mintTokens(w: FakeWorkspace, kind: 'r' | 'w', nowMs: number) {
  const rand = () => randomBytes(6).toString('hex');
  const exp = Math.floor(nowMs / 1000) + TOKEN_TTL_S;
  return {
    access_token: `fake-xoxp.${w.team.id}.${w.selfUserId}.${kind}.${exp}.${rand()}`,
    refresh_token: `fake-xoxe.${w.team.id}.${w.selfUserId}.${kind}.${rand()}`,
    expires_in: TOKEN_TTL_S,
    scope: (kind === 'w' ? SLACK_WRITE_SCOPES : SLACK_READ_SCOPES).join(','),
  };
}

function parseToken(raw: string | undefined): TokenInfo | null {
  const m = /^fake-xoxp\.([A-Z0-9]+)\.([A-Z0-9]+)\.([rw])\.(\d+)\.[a-f0-9]+$/.exec(raw ?? '');
  return m
    ? { team: m[1]!, user: m[2]!, kind: m[3] as 'r' | 'w', exp: Number(m[4]), raw: raw! }
    : null;
}

const channelObject = (c: FakeSlackConversation) => ({
  id: c.id,
  name: c.type === 'im' ? (c.members[1] ?? c.id) : c.name,
  is_channel: c.type === 'channel',
  is_group: c.type === 'group',
  is_im: c.type === 'im',
  is_mpim: c.type === 'mpim',
  is_private: c.type !== 'channel',
});

const permalink = (w: FakeWorkspace, m: FakeSlackMessage) => {
  const base = `https://${w.team.domain}.slack.com/archives/${m.channel}/p${m.ts.replace('.', '')}`;
  return m.thread_ts && m.thread_ts !== m.ts
    ? `${base}?thread_ts=${m.thread_ts}&cid=${m.channel}`
    : base;
};

function apiMessage(m: FakeSlackMessage, withMetadata: boolean) {
  const { channel: _c, metadata, ...rest } = m;
  return { type: 'message', ...rest, ...(withMetadata && metadata ? { metadata } : {}) };
}

/** Fetch that serves slack.com/api/* from the store. */
export function fakeSlackFetch(store: FakeSlackStore, opts: { now?: () => number } = {}): FetchFn {
  const now = opts.now ?? Date.now;
  const ok = (body: Record<string, unknown>) => ({ ok: true, ...body });
  const err = (error: string) => ({ ok: false, error });

  function handle(method: string, p: Params, auth: string | undefined): Record<string, unknown> {
    if (method === 'oauth.v2.access') return oauthAccess(p);
    const t = parseToken(auth);
    if (!t) return err('invalid_auth');
    const s = store.store.read();
    const w = s.workspaces.find((x) => x.team.id === t.team);
    if (!w) return err('invalid_auth');
    if (w.revokedTokens.includes('*') || w.revokedTokens.includes(t.raw))
      return err('token_revoked');
    if (t.exp * 1000 <= now()) return err('token_expired');
    const conv = (id: string | undefined) => w.conversations.find((c) => c.id === id);
    const visible = (c: FakeSlackConversation) =>
      c.members.includes(t.user) || c.type === 'channel';
    const needRead = () => (t.kind === 'r' ? null : err('missing_scope'));

    switch (method) {
      case 'auth.test':
        return ok({
          url: `https://${w.team.domain}.slack.com/`,
          team: w.team.name,
          user: w.users.find((u) => u.id === t.user)?.name ?? t.user,
          team_id: w.team.id,
          user_id: t.user,
        });
      case 'auth.revoke':
        store.store.update((st) => {
          st.workspaces.find((x) => x.team.id === w.team.id)?.revokedTokens.push(t.raw);
        });
        return ok({ revoked: true });
      case 'users.info': {
        const u = w.users.find((x) => x.id === p.user);
        if (!u) return err('user_not_found');
        return ok({
          user: {
            id: u.id,
            team_id: w.team.id,
            name: u.name,
            real_name: u.real_name,
            deleted: false,
            is_bot: !!u.is_bot,
            profile: { display_name: u.display_name, real_name: u.real_name },
          },
        });
      }
      case 'users.conversations': {
        const denied = needRead();
        if (denied) return denied;
        const types = (p.types ?? 'public_channel').split(',');
        const map: Record<ConversationType, string> = {
          channel: 'public_channel',
          group: 'private_channel',
          im: 'im',
          mpim: 'mpim',
        };
        const channels = w.conversations
          .filter((c) => c.members.includes(t.user) && types.includes(map[c.type]))
          .map(channelObject);
        return ok({ channels, response_metadata: { next_cursor: '' } });
      }
      case 'search.messages': {
        const denied = needRead();
        if (denied) return denied;
        const q = p.query ?? '';
        const after = /after:(\d{4}-\d{2}-\d{2})/.exec(q)?.[1];
        const from = /from:<@([A-Z0-9]+)>/.exec(q)?.[1];
        const afterUs = after ? (Date.parse(`${after}T00:00:00Z`) + 86_400_000) * 1000 : 0;
        const all = w.messages
          .filter((m) => {
            const c = conv(m.channel);
            if (!c || !visible(c)) return false;
            if (m.subtype === 'channel_join') return false; // not indexed
            if (from && m.user !== from) return false;
            return tsToMicros(m.ts) >= afterUs;
          })
          .sort((a, b) => tsToMicros(b.ts) - tsToMicros(a.ts));
        if (p.sort_dir === 'asc') all.reverse();
        const count = Math.min(Number(p.count ?? 20), 100);
        const page = Number(p.page ?? 1);
        const pages = Math.max(1, Math.ceil(all.length / count));
        const slice = all.slice((page - 1) * count, page * count);
        return ok({
          query: q,
          messages: {
            total: all.length,
            paging: { count, total: all.length, page, pages },
            pagination: { total_count: all.length, page, per_page: count, page_count: pages },
            matches: slice.map((m) => ({
              iid: `${m.channel}-${m.ts}`,
              team: w.team.id,
              channel: channelObject(conv(m.channel)!),
              type: 'message',
              user: m.user,
              username: w.users.find((u) => u.id === m.user)?.name,
              ...(m.bot_id ? { bot_id: m.bot_id } : {}),
              ...(m.subtype ? { subtype: m.subtype } : {}),
              ts: m.ts,
              text: m.text,
              permalink: permalink(w, m),
            })),
          },
        });
      }
      case 'conversations.history':
      case 'conversations.replies': {
        const denied = needRead();
        if (denied) return denied;
        const c = conv(p.channel);
        if (!c) return err('channel_not_found');
        if (!c.members.includes(t.user)) return err('not_in_channel');
        const inclusive = p.inclusive === 'true' || p.inclusive === '1';
        const oldest = p.oldest ? tsToMicros(p.oldest) : 0;
        const latest = p.latest ? tsToMicros(p.latest) : Number.POSITIVE_INFINITY;
        const inRange = (m: FakeSlackMessage) => {
          const us = tsToMicros(m.ts);
          return inclusive ? us >= oldest && us <= latest : us > oldest && us < latest;
        };
        const meta = p.include_all_metadata === 'true';
        let list = w.messages.filter((m) => m.channel === c.id);
        if (method === 'conversations.history') {
          list = list
            .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
            .filter(inRange)
            .sort((a, b) => tsToMicros(b.ts) - tsToMicros(a.ts));
        } else {
          list = list
            .filter((m) => m.ts === p.ts || m.thread_ts === p.ts)
            .filter((m) => m.ts === p.ts || inRange(m))
            .sort((a, b) => tsToMicros(a.ts) - tsToMicros(b.ts));
          if (!list.some((m) => m.ts === p.ts)) return err('thread_not_found');
        }
        const limit = Math.min(Number(p.limit ?? 100), 999);
        const start = Number(p.cursor ?? 0) || 0;
        const page = list.slice(start, start + limit);
        const next = start + limit < list.length ? String(start + limit) : '';
        return ok({
          messages: page.map((m) => apiMessage(m, meta)),
          has_more: !!next,
          response_metadata: { next_cursor: next },
        });
      }
      case 'chat.postMessage': {
        if (t.kind !== 'w') return err('missing_scope');
        const b = p.__json ?? {};
        const channel = String(b.channel ?? '');
        const text = typeof b.text === 'string' ? b.text : '';
        if (!conv(channel)) return err('channel_not_found');
        if (!text) return err('no_text');
        const threadTs = typeof b.thread_ts === 'string' ? b.thread_ts : undefined;
        let msg: FakeSlackMessage;
        try {
          msg = store.appendMessage(
            w.team.id,
            { channel, user: t.user, text, ...(threadTs ? { threadTs } : {}) },
            now(),
          );
        } catch {
          return err('thread_not_found');
        }
        const md = b.metadata as FakeSlackMessage['metadata'] | undefined;
        if (md?.event_type) {
          store.store.update((st) => {
            const target = st.workspaces
              .find((x) => x.team.id === w.team.id)
              ?.messages.find((m) => m.channel === channel && m.ts === msg.ts);
            if (target) target.metadata = md;
          });
        }
        return ok({
          channel,
          ts: msg.ts,
          message: apiMessage({ ...msg, ...(md ? { metadata: md } : {}) }, true),
        });
      }
      default:
        return err('unknown_method');
    }
  }

  function oauthAccess(p: Params): Record<string, unknown> {
    if (p.grant_type === 'refresh_token') {
      const m = /^fake-xoxe\.([A-Z0-9]+)\.([A-Z0-9]+)\.([rw])\./.exec(p.refresh_token ?? '');
      const w = m ? store.workspace(m[1]!) : undefined;
      if (!m || !w || w.revokedTokens.includes('*')) return err('invalid_refresh_token');
      const t = mintTokens(w, m[3] as 'r' | 'w', now());
      return ok({
        ...t,
        token_type: 'user',
        user_id: w.selfUserId,
        team: { id: w.team.id, name: w.team.name },
      });
    }
    const m = /^(fake|fake-write):(.+)$/.exec(p.code ?? '');
    const w = m ? store.workspace(m[2]!) : undefined;
    if (!m || !w) return err('invalid_code');
    // A fresh consent restores a revoked fake grant (the reconnect flow).
    store.store.update((st) => {
      const x = st.workspaces.find((y) => y.team.id === w.team.id);
      if (x) x.revokedTokens = x.revokedTokens.filter((r) => r !== '*');
    });
    const t = mintTokens(w, m[1] === 'fake-write' ? 'w' : 'r', now());
    return ok({
      app_id: 'A0FAKEHUB1',
      authed_user: { id: w.selfUserId, token_type: 'user', ...t },
      team: { id: w.team.id, name: w.team.name },
      enterprise: null,
      is_enterprise_install: false,
    });
  }

  return (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = url.pathname.replace(/^\/api\//, '');
    const params: Params = Object.fromEntries(url.searchParams.entries());
    const headers = new Headers(init?.headers);
    const ct = headers.get('content-type') ?? '';
    if (typeof init?.body === 'string') {
      if (ct.includes('application/json')) {
        params.__json = JSON.parse(init.body) as Record<string, unknown>;
      } else {
        for (const [k, v] of new URLSearchParams(init.body)) params[k] = v;
      }
    }
    const auth = headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const body = handle(method, params, auth);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchFn;
}
