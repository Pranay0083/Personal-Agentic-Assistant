import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secrets, users } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import {
  KmsKeyProvider,
  LocalKeyProvider,
  SecretStore,
  open,
  seal,
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

  it('wraps data keys through KMS behind the same interface', async () => {
    // Fake KMS: XOR "encryption" so we can check the wiring without AWS.
    const calls: string[] = [];
    const fake = {
      send: async (cmd: {
        constructor: { name: string };
        input: { Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array };
      }) => {
        calls.push(cmd.constructor.name);
        const buf = Buffer.from((cmd.input.Plaintext ?? cmd.input.CiphertextBlob)!).map(
          (b) => b ^ 0xaa,
        );
        return cmd.constructor.name === 'EncryptCommand'
          ? { CiphertextBlob: buf }
          : { Plaintext: buf };
      },
    };
    const kp: KeyProvider = new KmsKeyProvider('arn:aws:kms:us-east-1:1:key/abc', fake as never);
    const env = await seal(kp, 'provider-api-key');
    expect(env.keyId).toBe('kms:arn:aws:kms:us-east-1:1:key/abc');
    expect((await open(kp, env)).toString()).toBe('provider-api-key');
    expect(calls).toEqual(['EncryptCommand', 'DecryptCommand']);
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
});
