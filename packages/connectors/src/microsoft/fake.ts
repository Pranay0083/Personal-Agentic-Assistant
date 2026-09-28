import { randomBytes, randomUUID } from 'node:crypto';
import type { FetchFn } from '../lib/index';
import type { AccessKind } from '../types';
import { MS_READ_SCOPES, MS_WRITE_SCOPES } from './config';
import type { FakeMicrosoftStore, FakeSubscription, FakeUser } from './fake-store';
import type { GraphChat, GraphMessage } from './graph-types';
import { eventInstant } from './normalize';
import { IDEMPOTENCY_PROPERTY_ID } from './send';

/**
 * A fake Microsoft identity platform + Graph v1.0, served from the fake store through
 * `fetch`. The real connector code runs unchanged against it (CONNECTORS_FAKE=1), so the
 * demo exercises the same delta, paging, subscription and send paths as production.
 *
 * Tokens name the user and consent kind: `fake-access.<r|w>.<user>.<nonce>`. Read tokens
 * cannot send and write (Mail.Send) tokens cannot read, like the real scopes.
 */

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const V1 = '/v1.0';

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const graphError = (status: number, code: string, message = code) =>
  json(status, { error: { code, message } });

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function tokenFor(kind: 'access' | 'refresh', access: AccessKind, key: string) {
  return `fake-${kind}.${access === 'write' ? 'w' : 'r'}.${b64(key)}.${randomBytes(6).toString('hex')}`;
}

function parseToken(t: string | undefined, kind: 'access' | 'refresh') {
  const m = new RegExp(`^fake-${kind}\\.(r|w)\\.([A-Za-z0-9_-]+)\\.[0-9a-f]+$`).exec(t ?? '');
  if (!m) return null;
  return { access: (m[1] === 'w' ? 'write' : 'read') as AccessKind, key: unb64(m[2]!) };
}

/** Unsigned id_token (the connector only reads `tid`/`oid` from it). */
function idToken(u: FakeUser) {
  const header = b64(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64(
    JSON.stringify({
      aud: 'fake-client',
      iss: `https://login.microsoftonline.com/${u.tenantId}/v2.0`,
      tid: u.tenantId,
      oid: u.id,
      preferred_username: u.upn,
      name: u.displayName,
    }),
  );
  return `${header}.${payload}.`;
}

const SUB_MAX_MINUTES: [RegExp, number][] = [
  [/getallmessages|chats/i, 4_320],
  [/drive/i, 42_300],
  [/./, 10_080],
];

export type FakeGraphOptions = { now?: () => number; defaultPageSize?: number };

type Ctx = { url: URL; method: string; body: unknown; headers: Headers; now: number };

function pageSizeOf(c: Ctx, fallback: number): number {
  const prefer = c.headers.get('prefer') ?? '';
  const m = /odata\.maxpagesize=(\d+)/i.exec(prefer);
  const top = Number(c.url.searchParams.get('$top'));
  return m ? Number(m[1]) : Number.isFinite(top) && top > 0 ? top : fallback;
}

function linkWith(c: Ctx, params: Record<string, string>, drop: string[] = []) {
  const u = new URL(c.url.toString());
  for (const d of drop) u.searchParams.delete(d);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Seq-based delta paging shared by mail, calendar and drive. `$skiptoken` = `<from>.<upto>.<offset>`,
 * `$deltatoken` = `<upto>`. The first round (no token) lists `initial` items.
 */
function deltaPage<T>(
  c: Ctx,
  u: FakeUser,
  all: { seq: number; value: T }[],
  initial: () => T[],
  size: number,
  tokenParam = '$deltatoken',
): Response {
  const skip = c.url.searchParams.get('$skiptoken');
  const delta = c.url.searchParams.get(tokenParam);
  let items: T[];
  let from: number;
  let upto: number;
  let offset: number;
  if (skip) {
    const [f, t, o] = skip.split('.').map(Number);
    from = f!;
    upto = t!;
    offset = o!;
  } else {
    from = delta !== null ? Number(delta) : -1;
    upto = u.seq;
    offset = 0;
  }
  if (from >= 0 && from < u.minSeq)
    return graphError(410, 'SyncStateNotFound', 'sync state expired');
  if (from < 0) items = initial();
  else items = all.filter((x) => x.seq > from && x.seq <= upto).map((x) => x.value);
  const slice = items.slice(offset, offset + size);
  const body: Record<string, unknown> = { value: slice };
  if (offset + size < items.length) {
    body['@odata.nextLink'] = linkWith(c, { $skiptoken: `${from}.${upto}.${offset + size}` }, [
      tokenParam,
      '$deltatoken',
    ]);
  } else {
    const params: Record<string, string> = {};
    params[tokenParam] = String(upto);
    body['@odata.deltaLink'] = linkWith(c, params, [
      '$skiptoken',
      '$filter',
      'token',
      '$deltatoken',
    ]);
  }
  return json(200, body);
}

/** `receivedDateTime ge 2026-…` → epoch ms, or null. */
function dateFilter(filter: string | null, field: string, op = 'ge|gt'): number | null {
  if (!filter) return null;
  const m = new RegExp(`${field}\\s+(?:${op})\\s+(\\S+)`, 'i').exec(filter);
  const ms = m ? Date.parse(m[1]!) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function offsetPage<T>(c: Ctx, items: T[], size: number): Response {
  const offset = Number(c.url.searchParams.get('$skiptoken') ?? '0') || 0;
  const body: Record<string, unknown> = { value: items.slice(offset, offset + size) };
  if (offset + size < items.length) {
    body['@odata.nextLink'] = linkWith(c, { $skiptoken: String(offset + size) });
  }
  return json(200, body);
}

function chatWithPreview(u: FakeUser, chat: GraphChat): GraphChat {
  const last = u.chatMessages
    .filter((m) => m.chatId === chat.id)
    .map((m) => m.message)
    .sort((a, b) => (b.createdDateTime ?? '').localeCompare(a.createdDateTime ?? ''))[0];
  return {
    ...chat,
    lastUpdatedDateTime: last?.createdDateTime ?? chat.createdDateTime ?? null,
    lastMessagePreview: last
      ? { id: last.id, createdDateTime: last.createdDateTime ?? null, from: last.from ?? null }
      : null,
  };
}

function recipientsOf(v: unknown): GraphMessage['toRecipients'] {
  return Array.isArray(v) ? (v as GraphMessage['toRecipients']) : [];
}

export function fakeGraphFetch(store: FakeMicrosoftStore, opts: FakeGraphOptions = {}): FetchFn {
  const nowFn = opts.now ?? Date.now;
  const defaultSize = opts.defaultPageSize ?? 50;

  function tokenEndpoint(c: Ctx): Response {
    const form = new URLSearchParams(typeof c.body === 'string' ? c.body : '');
    const grant = form.get('grant_type');
    let key: string;
    let access: AccessKind;
    if (grant === 'authorization_code') {
      const m = /^(fake|fake-write):(.+)$/.exec(form.get('code') ?? '');
      if (!m) return json(400, { error: 'invalid_grant' });
      key = m[2]!.toLowerCase();
      access = m[1] === 'fake-write' ? 'write' : 'read';
      if (!store.user(key)) return json(400, { error: 'invalid_grant' });
      // A fresh consent un-revokes the fake grant (the reconnect flow).
      store.setRevoked(key, false);
    } else if (grant === 'refresh_token') {
      const t = parseToken(form.get('refresh_token') ?? undefined, 'refresh');
      if (!t) return json(400, { error: 'invalid_grant' });
      key = t.key;
      access = t.access;
      const u = store.user(key);
      if (!u || u.revoked) return json(400, { error: 'invalid_grant' });
    } else {
      return json(400, { error: 'unsupported_grant_type' });
    }
    const u = store.user(key)!;
    const scopes = (access === 'write' ? MS_WRITE_SCOPES : MS_READ_SCOPES).filter(
      (s) => s !== 'offline_access',
    );
    return json(200, {
      token_type: 'Bearer',
      scope: scopes.join(' '),
      expires_in: 3600,
      access_token: tokenFor('access', access, key),
      refresh_token: tokenFor('refresh', access, key),
      id_token: idToken(u),
    });
  }

  function graph(c: Ctx): Response {
    const auth = parseToken(c.headers.get('authorization')?.replace(/^Bearer /, ''), 'access');
    const u = auth ? store.user(auth.key) : undefined;
    if (!auth || !u || u.revoked) return graphError(401, 'InvalidAuthenticationToken');
    const path = decodeURIComponent(c.url.pathname.slice(V1.length));
    const needs = (kind: AccessKind) => auth.access === kind;
    const size = pageSizeOf(c, defaultSize);
    const q = c.url.searchParams;
    let m: RegExpExecArray | null;

    // ---- writes (Mail.Send token)
    if (c.method === 'POST' && path === '/me/sendMail') {
      if (!needs('write')) return graphError(403, 'ErrorAccessDenied');
      const msg = (c.body as { message?: Record<string, unknown> }).message ?? {};
      const body = msg.body as { content?: string; contentType?: string } | undefined;
      store.addSent(
        u.key,
        {
          subject: String(msg.subject ?? ''),
          bodyPreview: String(body?.content ?? '').slice(0, 255),
          body: { contentType: body?.contentType ?? 'Text', content: String(body?.content ?? '') },
          from: { emailAddress: { name: u.displayName, address: u.mail ?? u.upn } },
          toRecipients: recipientsOf(msg.toRecipients),
          ccRecipients: recipientsOf(msg.ccRecipients),
          singleValueExtendedProperties: msg.singleValueExtendedProperties as never,
        },
        nowFn(),
      );
      return new Response(null, { status: 202 });
    }
    if (c.method === 'POST' && (m = /^\/me\/messages\/([^/]+)\/reply$/.exec(path))) {
      if (!needs('write')) return graphError(403, 'ErrorAccessDenied');
      const original = u.messages.find((x) => x.message.id === m![1])?.message;
      if (!original) return graphError(404, 'ErrorItemNotFound');
      const b = c.body as { message?: Record<string, unknown>; comment?: string };
      const to = recipientsOf(b.message?.toRecipients);
      store.addSent(
        u.key,
        {
          subject: `RE: ${original.subject ?? ''}`,
          bodyPreview: String(b.comment ?? '').slice(0, 255),
          body: { contentType: 'text', content: String(b.comment ?? '') },
          from: { emailAddress: { name: u.displayName, address: u.mail ?? u.upn } },
          toRecipients: to?.length ? to : original.from ? [original.from] : [],
          ccRecipients: recipientsOf(b.message?.ccRecipients),
          conversationId: original.conversationId ?? null,
          singleValueExtendedProperties: b.message?.singleValueExtendedProperties as never,
        },
        nowFn(),
      );
      return new Response(null, { status: 202 });
    }

    // ---- subscriptions (either token, as Graph checks the resource's read scope)
    if (c.method === 'POST' && path === '/subscriptions') {
      const b = c.body as Record<string, string>;
      if (!b.clientState || !b.notificationUrl || !b.resource) {
        return graphError(400, 'InvalidRequest');
      }
      const max = SUB_MAX_MINUTES.find(([re]) => re.test(b.resource!))![1];
      const wanted = Date.parse(b.expirationDateTime ?? '');
      const cap = nowFn() + max * 60_000;
      if (!Number.isFinite(wanted) || wanted > cap) {
        return graphError(400, 'ExtensionError', 'expirationDateTime beyond the maximum');
      }
      const sub: FakeSubscription = {
        id: randomUUID(),
        userKey: u.key,
        resource: b.resource,
        changeType: b.changeType ?? 'created',
        clientState: b.clientState,
        notificationUrl: b.notificationUrl,
        expirationDateTime: new Date(wanted).toISOString(),
      };
      store.recordSubscription(sub);
      return json(201, { ...sub, clientState: null, applicationId: 'fake-client' });
    }
    if ((m = /^\/subscriptions\/([^/]+)$/.exec(path))) {
      const id = m[1]!;
      const existing = store.read().subscriptions[id];
      if (!existing || existing.userKey !== u.key) return graphError(404, 'ResourceNotFound');
      if (c.method === 'DELETE') {
        store.update((s) => {
          delete s.subscriptions[id];
        });
        return new Response(null, { status: 204 });
      }
      if (c.method === 'PATCH') {
        const exp = String((c.body as { expirationDateTime?: string }).expirationDateTime ?? '');
        store.update((s) => {
          s.subscriptions[id]!.expirationDateTime = new Date(Date.parse(exp)).toISOString();
        });
        return json(200, { ...store.read().subscriptions[id], clientState: null });
      }
    }

    if (c.method !== 'GET') return graphError(405, 'MethodNotAllowed');
    // Every read below needs a read-consent token (Mail.Send cannot read).
    if (!needs('read') && path !== '/me') return graphError(403, 'ErrorAccessDenied');

    if (path === '/me') {
      return json(200, {
        id: u.id,
        displayName: u.displayName,
        userPrincipalName: u.upn,
        mail: u.mail,
      });
    }

    // ---- mail
    if ((m = /^\/me\/mailFolders\/(inbox|sentitems)\/messages\/delta$/i.exec(path))) {
      const folder = m[1]!.toLowerCase();
      const inFolder = u.messages.filter((x) => x.folder === folder);
      const since = dateFilter(q.get('$filter'), 'receivedDateTime');
      return deltaPage(
        c,
        u,
        inFolder.map((x) => ({ seq: x.seq, value: x.message })),
        () =>
          inFolder
            .map((x) => x.message)
            .filter((x) => since === null || Date.parse(x.receivedDateTime ?? '') >= since),
        size,
      );
    }
    if ((m = /^\/me\/mailFolders\/(inbox|sentitems)\/messages$/i.exec(path))) {
      const folder = m[1]!.toLowerCase();
      const filter = q.get('$filter') ?? '';
      let list = u.messages.filter((x) => x.folder === folder).map((x) => x.message);
      const marker = /ep\/value eq '([^']+)'/.exec(filter)?.[1];
      if (marker) {
        list = list.filter((x) =>
          (x.singleValueExtendedProperties ?? []).some(
            (p) => p.id === IDEMPOTENCY_PROPERTY_ID && p.value === marker,
          ),
        );
      }
      const since = dateFilter(filter, 'receivedDateTime');
      if (since !== null) list = list.filter((x) => Date.parse(x.receivedDateTime ?? '') >= since);
      list.sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''));
      return offsetPage(c, list, size);
    }

    // ---- calendar
    if (path === '/me/calendarView/delta' || path === '/me/calendarView') {
      const start = Date.parse(q.get('startDateTime') ?? '');
      const end = Date.parse(q.get('endDateTime') ?? '');
      const inWindow = (e: FakeUser['events'][number]['event']) => {
        const s = Date.parse(eventInstant(e.start) ?? '');
        return (!Number.isFinite(start) || s >= start) && (!Number.isFinite(end) || s < end);
      };
      const events = u.events.filter((x) => inWindow(x.event));
      if (path === '/me/calendarView')
        return offsetPage(
          c,
          events.map((x) => x.event),
          size,
        );
      return deltaPage(
        c,
        u,
        events.map((x) => ({ seq: x.seq, value: x.event })),
        () => events.map((x) => x.event),
        size,
      );
    }

    // ---- teams (work accounts only)
    if (
      path === '/me/chats' ||
      /^\/chats\/[^/]+\/messages$/.test(path) ||
      path === '/me/joinedTeams'
    ) {
      if (u.personal) return graphError(403, 'Forbidden', 'not supported for personal accounts');
    }
    if (path === '/me/joinedTeams') return json(200, { value: [] });
    if (path === '/me/chats') {
      const chats = u.chats
        .map((ch) => chatWithPreview(u, ch))
        .sort((a, b) =>
          (b.lastMessagePreview?.createdDateTime ?? '').localeCompare(
            a.lastMessagePreview?.createdDateTime ?? '',
          ),
        );
      return offsetPage(c, chats, size);
    }
    if ((m = /^\/chats\/([^/]+)\/messages$/.exec(path))) {
      const chatId = m[1]!;
      const filter = q.get('$filter');
      const gt = dateFilter(filter, 'lastModifiedDateTime', 'gt');
      const lt = dateFilter(filter, 'lastModifiedDateTime', 'lt');
      const list = u.chatMessages
        .filter((x) => x.chatId === chatId)
        .map((x) => x.message)
        .filter((x) => {
          const t = Date.parse(x.lastModifiedDateTime ?? '');
          return (gt === null || t > gt) && (lt === null || t < lt);
        })
        .sort((a, b) => (b.lastModifiedDateTime ?? '').localeCompare(a.lastModifiedDateTime ?? ''));
      return offsetPage(c, list, size);
    }

    // ---- onedrive
    if (path === '/me/drive/root/delta') {
      const token = q.get('token');
      if (token === 'latest' && !q.get('$skiptoken')) {
        return json(200, {
          value: [],
          '@odata.deltaLink': linkWith(c, { token: String(u.seq) }, ['$select']),
        });
      }
      return deltaPage(
        c,
        u,
        u.driveItems.map((x) => ({ seq: x.seq, value: x.item })),
        () => u.driveItems.map((x) => x.item),
        size,
        'token',
      );
    }

    return graphError(404, 'ResourceNotFound', 'fake Graph route not implemented');
  }

  return (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown = raw;
    if (raw && (headers.get('content-type') ?? '').includes('json')) {
      try {
        body = JSON.parse(raw);
      } catch {
        return graphError(400, 'BadRequest');
      }
    }
    const c: Ctx = { url, method, body, headers, now: nowFn() };
    if (
      url.hostname === 'login.microsoftonline.com' &&
      url.pathname.endsWith('/oauth2/v2.0/token')
    ) {
      return tokenEndpoint(c);
    }
    if (url.origin === GRAPH_ORIGIN && url.pathname.startsWith(V1)) return graph(c);
    return new Response('not found', { status: 404 });
  }) as FetchFn;
}

/** Fake consent screen: redirects straight back with `code=fake:<user>` (or `fake-write:`). */
export function fakeMsAuthUrl(
  store: FakeMicrosoftStore,
  o: { state: string; redirectUri: string; access: AccessKind; loginHint?: string },
): string {
  const key = store.pickForConnect(o.loginHint);
  const url = new URL(o.redirectUri);
  url.searchParams.set('code', `${o.access === 'write' ? 'fake-write' : 'fake'}:${key}`);
  url.searchParams.set('state', o.state);
  return url.toString();
}
