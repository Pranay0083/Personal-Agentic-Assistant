import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RetryableError, type Connector, type OAuthTokens } from '@hub/connectors';
import { accounts, auditLog, secrets as secretsTable, users, type Db } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import { requestWriteTokenRevocation } from '@hub/server';
import { LocalKeyProvider, SecretStore, WriteSecretAccessError } from '@hub/server/secrets';
import { QUEUES, RevokeWriteTokenJob } from '@hub/shared/queues';
import { revokeWriteToken, type RevokeDeps } from './revoke';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const readKeys = new LocalKeyProvider(randomBytes(32).toString('base64'));
const writeKeys = new LocalKeyProvider(randomBytes(32).toString('base64'));
let apiStore: SecretStore;
let executorStore: SecretStore;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  apiStore = new SecretStore(db, readKeys, { writeKeys });
  executorStore = new SecretStore(db, readKeys, { writeKeys, allowWriteDecrypt: true });
});
afterAll(async () => t?.drop());

let userId: string;
let revoked: OAuthTokens[];
let revokeError: Error | null;

const connector = () =>
  ({
    provider: 'gmail',
    connect: {
      revoke: async (tokens: OAuthTokens) => {
        if (revokeError) throw revokeError;
        revoked.push(tokens);
      },
    },
  }) as unknown as Connector;

const deps = (secrets: RevokeDeps['secrets'] = executorStore): RevokeDeps => ({
  db,
  secrets,
  getConnector: () => connector(),
});

const ACCOUNT = '00000000-0000-4000-8000-00000000abcd';

beforeEach(async () => {
  revoked = [];
  revokeError = null;
  const [u] = await db
    .insert(users)
    .values({ email: `r${randomBytes(4).toString('hex')}@test.dev` })
    .returning();
  userId = u!.id;
});

const writeSecret = () =>
  apiStore.put(userId, 'oauth:gmail:write', JSON.stringify({ accessToken: 'write-token' }));
const secretExists = async (ref: string) =>
  (await db.select().from(secretsTable).where(eq(secretsTable.id, ref))).length === 1;
const job = (secretRef: string, over: Partial<RevokeWriteTokenJob> = {}): RevokeWriteTokenJob => ({
  task: 'revoke-write-token',
  userId,
  accountId: ACCOUNT,
  provider: 'gmail',
  secretRef,
  ...over,
});

describe('revoke-write-token (executor)', () => {
  it('the API cannot decrypt the write token it stored', async () => {
    const ref = await writeSecret();
    await expect(apiStore.get(ref)).rejects.toBeInstanceOf(WriteSecretAccessError);
  });

  it('revokes at the provider with the decrypted write token, then deletes it', async () => {
    const ref = await writeSecret();
    expect(await revokeWriteToken(deps(), job(ref))).toEqual({ status: 'revoked', revoked: true });
    expect(revoked).toEqual([{ accessToken: 'write-token' }]);
    expect(await secretExists(ref)).toBe(false);
    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    expect(rows.map((r) => r.action)).toEqual(['executor.write_token_revoked']);
    expect(JSON.stringify(rows)).not.toContain('write-token');
    // Idempotent.
    expect(await revokeWriteToken(deps(), job(ref))).toEqual({ status: 'missing' });
  });

  it('clears write access on an account that still points at the token', async () => {
    const ref = await writeSecret();
    const [a] = await db
      .insert(accounts)
      .values({
        userId,
        provider: 'gmail',
        nickname: 'W',
        color: '#1F6F6B',
        externalId: 'me@w.dev',
        writeTokenRef: ref,
      })
      .returning();
    await revokeWriteToken(deps(), job(ref, { accountId: a!.id }));
    const [after] = await db.select().from(accounts).where(eq(accounts.id, a!.id));
    expect(after!.writeTokenRef).toBeNull();
  });

  it("refuses a job for another user's secret or a non-write secret", async () => {
    const ref = await writeSecret();
    const [other] = await db.insert(users).values({ email: 'other@test.dev' }).returning();
    expect(await revokeWriteToken(deps(), job(ref, { userId: other!.id }))).toMatchObject({
      status: 'refused',
    });
    const readRef = await apiStore.put(userId, 'oauth:gmail', '{"accessToken":"read"}');
    expect(await revokeWriteToken(deps(), job(readRef))).toMatchObject({ status: 'refused' });
    expect(await secretExists(ref)).toBe(true);
    expect(await secretExists(readRef)).toBe(true);
    expect(revoked).toEqual([]);
  });

  it('retries provider hiccups, and deletes the token on the final attempt anyway', async () => {
    const ref = await writeSecret();
    revokeError = new RetryableError('gmail', 'gmail responded 503', { status: 503 });
    await expect(revokeWriteToken(deps(), job(ref))).rejects.toBeInstanceOf(RetryableError);
    expect(await secretExists(ref)).toBe(true);
    expect(await revokeWriteToken(deps(), job(ref), { finalAttempt: true })).toEqual({
      status: 'deleted',
      revoked: false,
    });
    expect(await secretExists(ref)).toBe(false);
  });

  it('requestWriteTokenRevocation enqueues an executor job keyed by the secret', async () => {
    const calls: { name: string; data: unknown; opts?: { jobId?: string } }[] = [];
    const ref = '00000000-0000-4000-8000-0000000000ff';
    await requestWriteTokenRevocation(
      async (name, data, opts) => void calls.push({ name, data, ...(opts ? { opts } : {}) }),
      { userId, accountId: ACCOUNT, provider: 'gmail', secretRef: ref },
    );
    expect(calls).toEqual([
      {
        name: QUEUES.executor,
        data: job(ref),
        opts: { jobId: `revoke-write-${ref}` },
      },
    ]);
    expect(RevokeWriteTokenJob.parse(calls[0]!.data)).toEqual(job(ref));
  });
});
