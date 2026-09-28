/** Test harness for sync/backfill/scheduler: throwaway DB, fake Gmail, recorded side effects. */
import { randomBytes } from 'node:crypto';
import { createGmailConnector, FakeGmailStore, type GmailConfig } from '@hub/connectors/gmail';
import { NotImplementedError, type Connector } from '@hub/connectors';
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

  const deps: WorkerDeps = {
    db: t.db,
    keys,
    secrets,
    getConnector: (p) => {
      if (p === 'gmail') return gmail;
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
