import { randomBytes } from 'node:crypto';
import type { Identity, OAuthTokens } from '../types';
import type { GmailApi, GmailClientFactory, GmailMessage } from './client';
import { GMAIL_SCOPES } from './config';
import type { FakeGmailStore, FakeMailbox } from './fake-store';
import { fixture } from './fixtures/index';
import { header } from './normalize';
import { GOOGLE_SOURCES, SOURCE_SCOPES, type GoogleSource } from './scopes';

/** Error shaped like a gaxios error, so the real error mapping applies to the fake too. */
export class FakeHttpError extends Error {
  readonly response: { status: number; data: unknown; headers: Record<string, string> };

  constructor(status: number, data: unknown, headers: Record<string, string> = {}) {
    super(`fake gmail responded ${status}`);
    this.name = 'FakeHttpError';
    this.response = { status, data, headers };
  }
}

export const notFound = () => new FakeHttpError(404, fixture('history-404.json'));
export const unauthorized = () => new FakeHttpError(401, fixture('error-401.json'));
export const invalidGrant = () => new FakeHttpError(400, fixture('token-invalid-grant.json'));

const LABEL_FOR: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  spam: 'SPAM',
  trash: 'TRASH',
  drafts: 'DRAFT',
  draft: 'DRAFT',
  starred: 'STARRED',
  unread: 'UNREAD',
};

/** Supports the subset of Gmail search the connector issues. */
export function matchesQuery(m: GmailMessage, q: string | undefined, now: number): boolean {
  const labels = m.labelIds ?? [];
  for (const tok of (q ?? '').split(/\s+/).filter(Boolean)) {
    const neg = tok.startsWith('-');
    const [key, ...rest] = (neg ? tok.slice(1) : tok).split(':');
    const val = rest.join(':').toLowerCase();
    let hit: boolean;
    switch (key) {
      case 'newer_than': {
        const n = parseInt(val, 10);
        const unit = val.slice(-1);
        const ms = n * (unit === 'h' ? 3600_000 : unit === 'm' ? 30 * 86400_000 : 86400_000);
        hit = Number(m.internalDate) >= now - ms;
        break;
      }
      case 'in':
      case 'is':
        hit = labels.includes(LABEL_FOR[val] ?? val.toUpperCase());
        break;
      case 'category':
        hit = labels.includes(`CATEGORY_${val.toUpperCase()}`);
        break;
      case 'label':
        hit = labels.some((l) => l.toLowerCase() === val);
        break;
      case 'rfc822msgid': {
        const mid = (header(m.payload, 'Message-ID') ?? '').replace(/^<|>$/g, '').toLowerCase();
        hit = mid === val.replace(/^<|>$/g, '');
        break;
      }
      default:
        hit = true;
    }
    if (neg ? hit : !hit) return false;
  }
  return true;
}

function parseRawHeaders(raw: string) {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const head = text.split(/\r?\n\r?\n/)[0] ?? '';
  const out: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const bodyB64 = text
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join('\n')
    .replace(/\s+/g, '');
  const body = Buffer.from(bodyB64, 'base64').toString('utf8');
  return { headers: out, body };
}

function page<T>(all: T[], pageToken: string | undefined, size: number) {
  const start = pageToken ? Number(pageToken) || 0 : 0;
  const items = all.slice(start, start + size);
  const next = start + size < all.length ? String(start + size) : undefined;
  return { items, next };
}

export type FakeClientOptions = {
  /** Page sizes, small in tests to exercise pagination. */
  historyPageSize?: number;
  now?: () => number;
};

/**
 * Token checks shared by the fake Gmail and fake REST clients: unknown mailbox or a
 * non-fake token → 401, revoked grant → invalid_grant, expired → refresh + onTokens.
 */
export function fakeAuthGuard(
  store: FakeGmailStore,
  externalId: string,
  tokens: OAuthTokens,
  onTokens: (t: OAuthTokens) => void,
  now: () => number,
): () => FakeMailbox {
  const email = externalId.toLowerCase();
  let current: OAuthTokens = { ...tokens };
  return () => {
    const mb = store.mailbox(email);
    if (!mb) throw unauthorized();
    if (mb.revoked) throw invalidGrant();
    if (!current.accessToken?.startsWith('fake-')) throw unauthorized();
    if (current.expiresAt !== undefined && current.expiresAt <= now()) {
      if (!current.refreshToken?.startsWith('fake-')) throw invalidGrant();
      current = {
        ...current,
        accessToken: `fake-access.${randomBytes(6).toString('hex')}`,
        expiresAt: now() + 3600_000,
      };
      onTokens({ ...current });
    }
    return mb;
  };
}

/** A GmailApi served from the fake store. Enforces tokens like Google would. */
export function fakeClientFactory(
  store: FakeGmailStore,
  opts: FakeClientOptions = {},
): GmailClientFactory {
  const now = opts.now ?? Date.now;
  return ({ tokens, externalId, onTokens }) => {
    const email = externalId.toLowerCase();
    const auth = fakeAuthGuard(store, email, tokens, onTokens, now);

    const api: GmailApi = {
      async getProfile() {
        const mb = auth();
        return {
          emailAddress: mb.email,
          messagesTotal: mb.messages.length,
          threadsTotal: new Set(mb.messages.map((m) => m.threadId)).size,
          historyId: String(mb.historyId),
        };
      },
      async watch(req) {
        auth();
        const expiration = now() + 7 * 86400_000;
        const hid = store.update((s) => {
          const mb = s.mailboxes[email]!;
          mb.watch = { expiration, labelIds: req.labelIds ?? [] };
          return mb.historyId;
        });
        return { historyId: String(hid), expiration: String(expiration) };
      },
      async stop() {
        auth();
        store.update((s) => {
          s.mailboxes[email]!.watch = null;
        });
      },
      async listHistory(p) {
        const mb = auth();
        const start = Number(p.startHistoryId);
        if (!Number.isFinite(start) || start < mb.minHistoryId) throw notFound();
        const records = mb.history.filter((h) => Number(h.id) > start);
        const { items, next } = page(
          records,
          p.pageToken,
          p.maxResults ?? opts.historyPageSize ?? 100,
        );
        return {
          ...(items.length ? { history: items } : {}),
          ...(next ? { nextPageToken: next } : {}),
          historyId: String(mb.historyId),
        };
      },
      async getMessage(id) {
        const mb = auth();
        const m = mb.messages.find((x) => x.id === id);
        if (!m) throw notFound();
        return structuredClone(m);
      },
      async listMessages(p) {
        const mb = auth();
        const t = now();
        const all = mb.messages
          .filter(
            (m) =>
              p.includeSpamTrash || !(m.labelIds ?? []).some((l) => l === 'SPAM' || l === 'TRASH'),
          )
          .filter((m) => matchesQuery(m, p.q, t))
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        const { items, next } = page(all, p.pageToken, p.maxResults ?? 100);
        return {
          ...(items.length
            ? { messages: items.map((m) => ({ id: m.id, threadId: m.threadId })) }
            : {}),
          ...(next ? { nextPageToken: next } : {}),
          resultSizeEstimate: all.length,
        };
      },
      async sendMessage({ raw, threadId }) {
        const mb = auth();
        const { headers, body } = parseRawHeaders(raw);
        const sent = store.appendMessage(mb.email, {
          from: mb.email,
          fromName: mb.displayName,
          to: headers.to ?? '',
          subject: headers.subject ?? '',
          body,
          labelIds: ['SENT'],
          ...(threadId ? { threadId } : {}),
          ...(headers['message-id'] ? { messageIdHeader: headers['message-id'] } : {}),
          ...(headers['in-reply-to'] ? { inReplyTo: headers['in-reply-to'] } : {}),
        });
        return { id: sent.message.id, threadId: sent.message.threadId, labelIds: ['SENT'] };
      },
    };
    return api;
  };
}

/**
 * Fake OAuth: the consent screen "signs in" as one of the fake mailboxes. The code is
 * `fake:<email>` (every read scope), `fake:<email>|mail,calendar` (the user unticked the
 * other sources) or `fake-write:<email>` (gmail.send).
 */
export function fakeAuth(store: FakeGmailStore) {
  return {
    authUrl(opts: {
      state: string;
      redirectUri: string;
      access: 'read' | 'write';
      loginHint?: string;
    }) {
      const email = store.pickForConnect(opts.loginHint);
      const url = new URL(opts.redirectUri);
      url.searchParams.set('code', `${opts.access === 'write' ? 'fake-write' : 'fake'}:${email}`);
      url.searchParams.set('state', opts.state);
      return url.toString();
    },
    async exchange(code: string) {
      const m = /^(fake|fake-write):([^|]+)(?:\|([a-z,]*))?$/.exec(code);
      if (!m) throw new FakeHttpError(400, { error: 'invalid_grant' });
      const email = m[2]!.toLowerCase();
      const mb = store.mailbox(email);
      if (!mb) throw new FakeHttpError(400, { error: 'invalid_grant' });
      // A fresh consent un-revokes the fake grant (the "reconnect" flow).
      if (mb.revoked) store.setRevoked(email, false);
      const write = m[1] === 'fake-write';
      const sources = (m[3] ?? GOOGLE_SOURCES.join(','))
        .split(',')
        .filter((x): x is GoogleSource => (GOOGLE_SOURCES as readonly string[]).includes(x));
      const scope = [
        ...(write ? [GMAIL_SCOPES.send] : sources.flatMap((x) => SOURCE_SCOPES[x])),
        GMAIL_SCOPES.openid,
        GMAIL_SCOPES.userinfoEmail,
      ].join(' ');
      const tokens: OAuthTokens = {
        accessToken: `fake-access.${randomBytes(6).toString('hex')}`,
        refreshToken: `fake-refresh.${randomBytes(6).toString('hex')}`,
        expiresAt: Date.now() + 3600_000,
        scope,
      };
      const identity: Identity = {
        externalId: mb.email,
        displayName: mb.displayName,
        routeKeys: [mb.email],
        meta: {
          grantedScopes: scope.split(' '),
          ...(mb.google ? { googleUserId: mb.google.googleUserId } : {}),
          ...(mb.google?.workspace ? { hostedDomain: mb.email.split('@')[1] } : {}),
        },
      };
      return {
        tokens,
        externalId: mb.email,
        displayName: mb.displayName,
        identities: [identity],
      };
    },
  };
}
