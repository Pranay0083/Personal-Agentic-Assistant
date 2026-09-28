import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { secrets, users } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import {
  KmsKeyProvider,
  LocalKeyProvider,
  SecretStore,
  WriteSecretAccessError,
  itemBodyContext,
  open,
  seal,
  secretContext,
  type KeyProvider,
} from './index';

const key = () => randomBytes(32).toString('base64');

describe('envelope encryption', () => {
  it('round-trips with the local key provider', async () => {
    const kp = new LocalKeyProvider(key());
    const env = await seal(kp, 'ya29.secret-token');
    expect(env.ciphertext).not.toContain('secret');
    expect((await open(kp, env)).toString()).toBe('ya29.secret-token');
  });

  it('uses a fresh data key and IV per value', async () => {
    const kp = new LocalKeyProvider(key());
    const a = await seal(kp, 'same');
    const b = await seal(kp, 'same');
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails with a different master key', async () => {
    const env = await seal(new LocalKeyProvider(key()), 'x');
    await expect(open(new LocalKeyProvider(key()), env)).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const kp = new LocalKeyProvider(key());
    const env = await seal(kp, 'hello world');
    const ct = Buffer.from(env.ciphertext, 'base64');
    ct[0]! ^= 1;
    await expect(open(kp, { ...env, ciphertext: ct.toString('base64') })).rejects.toThrow();
  });

  it('rejects master keys that are not 32 bytes', () => {
    expect(() => new LocalKeyProvider(randomBytes(16).toString('base64'))).toThrow();
  });

  it('wraps data keys through KMS behind the same interface, with the EncryptionContext', async () => {
    // Fake KMS: XOR "encryption" so we can check the wiring without AWS. Like real KMS it
    // refuses to decrypt unless the EncryptionContext matches the one used to encrypt.
    const calls: { name: string; context: unknown }[] = [];
    const bound = new Map<string, string>();
    const fake = {
      send: async (cmd: {
        constructor: { name: string };
        input: {
          Plaintext?: Uint8Array;
          CiphertextBlob?: Uint8Array;
          EncryptionContext?: Record<string, string>;
        };
      }) => {
        const context = cmd.input.EncryptionContext;
        calls.push({ name: cmd.constructor.name, context });
        const buf = Buffer.from((cmd.input.Plaintext ?? cmd.input.CiphertextBlob)!).map(
          (b) => b ^ 0xaa,
        );
        if (cmd.constructor.name === 'EncryptCommand') {
          bound.set(Buffer.from(buf).toString('hex'), JSON.stringify(context ?? null));
          return { CiphertextBlob: buf };
        }
        const blob = Buffer.from(cmd.input.CiphertextBlob!).toString('hex');
        if (bound.get(blob) !== JSON.stringify(context ?? null)) {
          throw Object.assign(new Error('InvalidCiphertextException'), {
            name: 'InvalidCiphertextException',
          });
        }
        return { Plaintext: buf };
      },
    };
    const kp: KeyProvider = new KmsKeyProvider('arn:aws:kms:us-east-1:1:key/abc', fake as never);
    const ctx = secretContext('u-1', 'provider:groq');
    const env = await seal(kp, 'provider-api-key', ctx);
    expect(env.keyId).toBe('kms:arn:aws:kms:us-east-1:1:key/abc');
    expect((await open(kp, env, ctx)).toString()).toBe('provider-api-key');
    expect(calls).toEqual([
      { name: 'EncryptCommand', context: { userId: 'u-1', kind: 'provider:groq' } },
      { name: 'DecryptCommand', context: { userId: 'u-1', kind: 'provider:groq' } },
    ]);
    await expect(open(kp, env, secretContext('u-2', 'provider:groq'))).rejects.toThrow();
  });

  it('binds the context: an envelope opened as another row, user or kind fails', async () => {
    const kp = new LocalKeyProvider(key());
    const env = await seal(kp, 'body text', itemBodyContext('acct-a'));
    expect((await open(kp, env, itemBodyContext('acct-a'))).toString()).toBe('body text');
    await expect(open(kp, env, itemBodyContext('acct-b'))).rejects.toThrow();
    await expect(open(kp, env, secretContext('acct-a', 'item_body'))).rejects.toThrow();
    await expect(open(kp, env)).rejects.toThrow();
    // The data key and the value are both bound: keeping the wrapped key but swapping the
    // value from another context fails too.
    const other = await seal(kp, 'other', itemBodyContext('acct-b'));
    await expect(
      open(
        kp,
        { ...env, iv: other.iv, tag: other.tag, ciphertext: other.ciphertext },
        itemBodyContext('acct-a'),
      ),
    ).rejects.toThrow();
  });
});

describe('SecretStore', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let userId: string;
  beforeAll(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ email: 's@example.com' }).returning();
    userId = u!.id;
  });
  afterAll(() => t.drop());

  it('stores only ciphertext and returns a ref', async () => {
    const store = new SecretStore(t.db, new LocalKeyProvider(key()));
    const ref = await store.put(
      userId,
      'oauth:gmail',
      JSON.stringify({ refresh_token: '1//very-secret' }),
    );
    const [row] = await t.db.select().from(secrets);
    expect(JSON.stringify(row)).not.toContain('very-secret');
    expect(await store.getJson(ref)).toEqual({ refresh_token: '1//very-secret' });
    await store.replace(ref, 'rotated');
    expect(await store.get(ref)).toBe('rotated');
    await store.delete(ref);
    await expect(store.get(ref)).rejects.toThrow('secret not found');
  });

  it('a ciphertext copied to another row or kind fails to open', async () => {
    const store = new SecretStore(t.db, new LocalKeyProvider(key()));
    const [u2] = await t.db.insert(users).values({ email: 's2@example.com' }).returning();
    const a = await store.put(userId, 'oauth:gmail', 'token-of-user-1');
    const b = await store.put(u2!.id, 'oauth:gmail', 'token-of-user-2');
    const c = await store.put(userId, 'provider:groq', 'groq-key');
    const [rowA] = await t.db.select().from(secrets).where(eq(secrets.id, a));
    const copy = {
      keyId: rowA!.keyId,
      wrappedDek: rowA!.wrappedDek,
      iv: rowA!.iv,
      tag: rowA!.tag,
      ciphertext: rowA!.ciphertext,
    };
    // Another user's row.
    await t.db.update(secrets).set(copy).where(eq(secrets.id, b));
    await expect(store.get(b)).rejects.toThrow();
    // Same user, another kind.
    await t.db.update(secrets).set(copy).where(eq(secrets.id, c));
    await expect(store.get(c)).rejects.toThrow();
    // Re-labelling the row's kind in place fails too.
    await t.db.update(secrets).set({ kind: 'oauth:slack' }).where(eq(secrets.id, a));
    await expect(store.get(a)).rejects.toThrow();
  });

  it('checks the expected owner and kind', async () => {
    const store = new SecretStore(t.db, new LocalKeyProvider(key()));
    const ref = await store.put(userId, 'provider:groq', 'k');
    expect(await store.get(ref, { userId, kind: 'provider:groq' })).toBe('k');
    await expect(
      store.get(ref, { userId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow('another user');
    await expect(store.get(ref, { kind: 'oauth:gmail' })).rejects.toThrow('unexpected kind');
  });

  it('seals write secrets with the separate write key; only the executor can open them', async () => {
    const readKeys = new LocalKeyProvider(key());
    const writeKeys = new LocalKeyProvider(key());
    const api = new SecretStore(t.db, readKeys, { writeKeys });
    const executor = new SecretStore(t.db, readKeys, { writeKeys, allowWriteDecrypt: true });

    // The API stores the write token after consent, and can rotate it, but never read it.
    const ref = await api.put(userId, 'oauth:gmail:write', 'write-token');
    const [row] = await t.db.select().from(secrets).where(eq(secrets.id, ref));
    expect(row!.keyId).toBe(writeKeys.keyId);
    expect(row!.keyId).not.toBe(readKeys.keyId);
    await expect(api.get(ref)).rejects.toBeInstanceOf(WriteSecretAccessError);
    await expect(api.getJson(ref)).rejects.toBeInstanceOf(WriteSecretAccessError);

    expect(await executor.get(ref)).toBe('write-token');
    await api.replace(ref, 'rotated-write-token');
    expect(await executor.get(ref)).toBe('rotated-write-token');

    // Read secrets are unaffected, and never sealed with the write key.
    const readRef = await api.put(userId, 'oauth:gmail', 'read-token');
    expect(await api.get(readRef)).toBe('read-token');

    // Even with the decrypt flag, the read key cannot open a write secret.
    const wrongKeys = new SecretStore(t.db, readKeys, {
      writeKeys: readKeys,
      allowWriteDecrypt: true,
    });
    await expect(wrongKeys.get(ref)).rejects.toThrow();
  });
});
