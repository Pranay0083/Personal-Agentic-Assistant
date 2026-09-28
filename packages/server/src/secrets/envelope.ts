import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption: each value gets a fresh 256-bit data key (DEK); the value is
 * sealed with AES-256-GCM under the DEK, and the DEK is wrapped by a KeyProvider
 * (a local master key in dev, KMS in production).
 */
export interface KeyProvider {
  /** Identifies the master key used, stored next to the ciphertext. */
  readonly keyId: string;
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, keyId: string): Promise<Buffer>;
}

export type Envelope = {
  keyId: string;
  wrappedDek: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export async function seal(provider: KeyProvider, plaintext: string | Buffer): Promise<Envelope> {
  const dek = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = await provider.wrap(dek);
    return {
      keyId: provider.keyId,
      wrappedDek: wrapped.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    dek.fill(0);
  }
}

export async function open(provider: KeyProvider, env: Envelope): Promise<Buffer> {
  const dek = await provider.unwrap(Buffer.from(env.wrappedDek, 'base64'), env.keyId);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } finally {
    dek.fill(0);
  }
}
