import { eq } from 'drizzle-orm';
import { secrets, type Db } from '@hub/db';
import { open, seal, secretContext, type KeyProvider } from './envelope';
import { writeKeyProvider } from './providers';

/** Write-scope secrets (e.g. `oauth:gmail:write`) are sealed with the separate write key. */
export const isWriteKind = (kind: string) => kind.endsWith(':write');

/** Thrown by `get()` on a write-kind secret in a process that is not the executor. */
export class WriteSecretAccessError extends Error {
  constructor() {
    super('write secrets can only be decrypted by the executor');
    this.name = 'WriteSecretAccessError';
  }
}

export type SecretStoreOptions = {
  /** Key provider for write kinds. Default: `writeKeyProvider()` from env, resolved lazily. */
  writeKeys?: KeyProvider;
  /** Only the executor sets this. Everyone else can seal write secrets but never open them. */
  allowWriteDecrypt?: boolean;
};

/** What a caller expects the secret behind a ref to be; a mismatch throws. */
export type SecretExpectation = { userId?: string; kind?: string };

/**
 * Stores secrets (OAuth tokens, provider API keys) encrypted at rest.
 * Callers keep only the returned `secret_ref` id. Each envelope is bound to its row's
 * `{ userId, kind }`, so a ciphertext copied to another row or kind fails to open.
 */
export class SecretStore {
  private readonly writeKeysOpt: KeyProvider | undefined;
  private readonly allowWriteDecrypt: boolean;

  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    opts: SecretStoreOptions = {},
  ) {
    this.writeKeysOpt = opts.writeKeys;
    this.allowWriteDecrypt = opts.allowWriteDecrypt === true;
  }

  private providerFor(kind: string): KeyProvider {
    if (!isWriteKind(kind)) return this.keys;
    return this.writeKeysOpt ?? writeKeyProvider();
  }

  async put(userId: string, kind: string, value: string): Promise<string> {
    const env = await seal(this.providerFor(kind), value, secretContext(userId, kind));
    const [row] = await this.db
      .insert(secrets)
      .values({ userId, kind, ...env })
      .returning({ id: secrets.id });
    return row!.id;
  }

  async replace(ref: string, value: string): Promise<void> {
    const [row] = await this.db
      .select({ userId: secrets.userId, kind: secrets.kind })
      .from(secrets)
      .where(eq(secrets.id, ref));
    if (!row) throw new Error('secret not found');
    const env = await seal(this.providerFor(row.kind), value, secretContext(row.userId, row.kind));
    await this.db.update(secrets).set(env).where(eq(secrets.id, ref));
  }

  async get(ref: string, expected: SecretExpectation = {}): Promise<string> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.id, ref));
    if (!row) throw new Error('secret not found');
    if (expected.userId !== undefined && row.userId !== expected.userId) {
      throw new Error('secret belongs to another user');
    }
    if (expected.kind !== undefined && row.kind !== expected.kind) {
      throw new Error('secret has an unexpected kind');
    }
    if (isWriteKind(row.kind) && !this.allowWriteDecrypt) throw new WriteSecretAccessError();
    const plain = await open(this.providerFor(row.kind), row, secretContext(row.userId, row.kind));
    return plain.toString('utf8');
  }

  async getJson<T>(ref: string, expected?: SecretExpectation): Promise<T> {
    return JSON.parse(await this.get(ref, expected)) as T;
  }

  async delete(ref: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.id, ref));
  }
}
