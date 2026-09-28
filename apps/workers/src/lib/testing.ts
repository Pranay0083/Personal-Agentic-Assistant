/** Test harness for sync/backfill/scheduler: throwaway DB, fake Gmail, recorded side effects. */
import { randomBytes } from 'node:crypto';
import { createGmailConnector, FakeGmailStore, type GmailConfig } from '@hub/connectors/gmail';
import {
  NotImplementedError,
  type Connector,
  type ConnectorContext,
  type NormalizedItem,
} from '@hub/connectors';
import { accounts, users } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import { createLogger } from '@hub/server';
import { LocalKeyProvider, SecretStore } from '@hub/server/secrets';
import type { LiveEvent, QueueName } from '@hub/shared/queues';
import type { WorkerDeps } from './deps';
import { MemoryAccountLock } from './lock';

export const WORK = 'alex@company.example';
export const PERSONAL = 'alex.personal@gmail.example';

export type RecordedJob = {
  name: QueueName;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
};

export async function createHarness(config: Partial<GmailConfig> = {}) {
  const t = await createTestDb();
  const keys = new LocalKeyProvider(randomBytes(32).toString('base64'));
  const secrets = new SecretStore(t.db, keys);
  const store = FakeGmailStore.memory();
  let gmail: Connector = createGmailConnector({
    config: { fake: true, ...config },
    fakeStore: store,
  }) as Connector;
  const jobs: RecordedJob[] = [];
  const live: { userId: string; event: LiveEvent }[] = [];
  const lock = new MemoryAccountLock();
  let clock: Date | null = null;
  const others = new Map<string, Connector>();

  const deps: WorkerDeps = {
    db: t.db,
    keys,
    secrets,
    getConnector: (p) => {
      if (p === 'gmail') return gmail;
      const c = others.get(p);
      if (c) return c;
      throw new NotImplementedError(p);
    },
    enqueue: async (name, data, opts = {}) => {
      jobs.push({
        name,
        data: data as Record<string, unknown>,
        opts: opts as Record<string, unknown>,
      });
    },
    publishLive: async (userId, event) => {
      live.push({ userId, event });
    },
    lock,
    log: createLogger('test'),
    now: () => clock ?? new Date(),
  };

  async function createUser(
    email = `u${randomBytes(4).toString('hex')}@example.com`,
    extra: Partial<typeof users.$inferInsert> = {},
  ) {
    const [u] = await t.db
      .insert(users)
      .values({ email, ...extra })
      .returning();
    return u!;
  }

  /** Connects a fake mailbox the way the API does: fake consent → tokens → encrypted secret. */
  async function connectAccount(
    userId: string,
    mailbox: string,
    extra: Partial<typeof accounts.$inferInsert> = {},
  ) {
    const ex = await gmail.connect.exchange({
      code: `fake:${mailbox}`,
      redirectUri: '',
      access: 'read',
    });
    const tokenRef = await secrets.put(userId, 'oauth:gmail', JSON.stringify(ex.tokens));
    const [a] = await t.db
      .insert(accounts)
      .values({
        userId,
        provider: 'gmail',
        nickname: mailbox === WORK ? 'Work' : 'Personal',
        color: '#1F6F6B',
        externalId: ex.externalId,
        status: 'live',
        tokenRef,
        ...extra,
        // Pin these tests to the mail source even as the Google connector gains sources.
        filters: { sources: onlyMail(gmail), ...((extra.filters as object) ?? {}) },
      })
      .returning();
    return a!;
  }

  return {
    t,
    db: t.db,
    keys,
    secrets,
    store,
    deps,
    jobs,
    live,
    lock,
    createUser,
    connectAccount,
    setConnector(c: Connector) {
      gmail = c;
    },
    /** Registers a connector for another provider (e.g. the fake two-source one). */
    addConnector(c: Connector) {
      others.set(c.provider, c);
    },
    /** Inserts an account for a non-Gmail provider with an encrypted fake token. */
    async addAccount(
      userId: string,
      provider: string,
      externalId: string,
      extra: Partial<typeof accounts.$inferInsert> = {},
    ) {
      const tokenRef = await secrets.put(
        userId,
        `oauth:${provider}`,
        JSON.stringify({ accessToken: `fake-${externalId}` }),
      );
      const [a] = await t.db
        .insert(accounts)
        .values({
          userId,
          provider,
          nickname: 'Work',
          color: '#1F6F6B',
          externalId,
          status: 'live',
          tokenRef,
          ...extra,
        })
        .returning();
      return a!;
    },
    get gmail() {
      return gmail;
    },
    setNow(d: Date | null) {
      clock = d;
    },
    jobsFor: (name: QueueName) => jobs.filter((j) => j.name === name),
    drop: () => t.drop(),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** `filters.sources` that turns every source but `mail` off. */
export function onlyMail(c: Connector): Record<string, boolean> {
  return Object.fromEntries(c.info.sources.map((s) => [s.id, s.id === 'mail']));
}

type FakeRecord = { seq: number; id: string; title: string; status?: string; read?: boolean };

/**
 * A fake connector with two sources: `mail` (push subscriptions that expire after 3 days and
 * carry a secret hash) and `files` (no push, cursor only). Deltas page two records at a time
 * with `hasMore`. Every call is recorded with its source.
 */
export function fakeTwoSourceConnector(opts: { now?: () => Date; pageSize?: number } = {}) {
  const now = opts.now ?? (() => new Date());
  const pageSize = opts.pageSize ?? 2;
  const data = new Map<string, FakeRecord[]>();
  const calls: { op: string; accountId: string; source: string | undefined }[] = [];
  let seq = 0;
  let subs = 0;
  const key = (externalId: string, source: string) => `${externalId}|${source}`;
  const log = (op: string, ctx: ConnectorContext) =>
    calls.push({ op, accountId: ctx.accountId, source: ctx.source });
  const failing = new Set<string>();

  const subscribe = async (ctx: ConnectorContext) => {
    log(ctx.subscription?.externalSubId ? 'renew' : 'subscribe', ctx);
    if (ctx.source === 'files') return { externalSubId: null, expiresAt: null, cursor: '0' };
    subs++;
    return {
      externalSubId: `sub-${subs}`,
      expiresAt: new Date(now().getTime() + 3 * 86400_000),
      cursor: String(seq),
      meta: { secretHash: 'a'.repeat(64) },
    };
  };

  const connector: Connector<FakeRecord> = {
    provider: 'microsoft',
    info: {
      name: 'Fake',
      covers: 'Mail, Files',
      multiAccountNote: null,
      sources: [
        { id: 'mail', label: 'Mail', hint: null, kind: 'email', defaultOn: true },
        { id: 'files', label: 'Files', hint: null, kind: 'file', defaultOn: true },
        { id: 'extra', label: 'Extra', hint: null, kind: 'note', defaultOn: false },
      ],
      options: [],
      writeActions: [],
    },
    configured: () => true,
    connect: {
      authUrl: () => 'https://fake.example/auth',
      exchange: async () => ({ tokens: { accessToken: 'x' }, externalId: 'x', displayName: null }),
      revoke: async () => {},
    },
    subscribe,
    renew: subscribe,
    unsubscribe: async (ctx) => {
      log('unsubscribe', ctx);
    },
    verifyWebhook: async () => ({ ok: true, events: [] }),
    fetchDelta: async (ctx) => {
      log('fetchDelta', ctx);
      if (failing.has(ctx.source ?? '')) throw new Error('fake source down');
      const all = data.get(key(ctx.externalId, ctx.source ?? 'mail')) ?? [];
      const after = Number(ctx.cursor ?? '0');
      const pending = all.filter((r) => r.seq > after);
      const records = pending.slice(0, pageSize);
      const last = records.at(-1);
      return {
        records,
        cursor: last ? String(last.seq) : (ctx.cursor ?? String(seq)),
        hasMore: pending.length > records.length,
      };
    },
    backfill: async (ctx, { pageToken }) => {
      log('backfill', ctx);
      const all = data.get(key(ctx.externalId, ctx.source ?? 'mail')) ?? [];
      const from = Number(pageToken ?? '0');
      const records = all.slice(from, from + pageSize);
      const next = from + pageSize < all.length ? String(from + pageSize) : null;
      return { records, nextPageToken: next };
    },
    normalize: (raw, source): NormalizedItem => ({
      kind: source === 'files' ? 'file' : 'email',
      externalId: `${source}:${raw.id}`,
      threadId: null,
      author: null,
      authorAddress: null,
      title: raw.title,
      summary: null,
      body: `${raw.title} (body)`,
      url: null,
      labels: [
        `fake:source:${source}`,
        ...(raw.status ? [`fake:status:${raw.status}`] : []),
        ...(raw.read ? ['READ'] : []),
      ],
      receivedAt: now(),
      fromMe: false,
    }),
  };

  return {
    connector: connector as Connector,
    calls,
    add(externalId: string, source: string, title: string) {
      seq++;
      const list = data.get(key(externalId, source)) ?? [];
      list.push({ seq, id: `r${seq}`, title });
      data.set(key(externalId, source), list);
      return `r${seq}`;
    },
    /** A new version of record `id` (same external id) appears in the delta. */
    edit(
      externalId: string,
      source: string,
      id: string,
      change: Partial<Pick<FakeRecord, 'title' | 'status' | 'read'>>,
    ) {
      // Like a provider delta: the record's current state moves to the end of the change log.
      const list = data.get(key(externalId, source)) ?? [];
      const prev = list.find((r) => r.id === id)!;
      seq++;
      data.set(key(externalId, source), [
        ...list.filter((r) => r.id !== id),
        { ...prev, ...change, seq },
      ]);
    },
    fail(source: string, on = true) {
      if (on) failing.add(source);
      else failing.delete(source);
    },
    callsFor: (accountId: string, op?: string) =>
      calls.filter((c) => c.accountId === accountId && (!op || c.op === op)),
  };
}
