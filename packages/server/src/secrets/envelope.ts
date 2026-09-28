import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Where a ciphertext belongs, e.g. `{ userId, kind }` for a secret row or
 * `{ accountId, kind: 'item_body' }` for a message body. It is bound as AES-GCM additional
 * authenticated data (and as the KMS EncryptionContext when wrapping the data key), so a
 * ciphertext copied to another row, user, account or kind fails to open.
 */
export type EnvelopeContext = Readonly<Record<string, string>>;

/**
 * Envelope encryption: each value gets a fresh 256-bit data key (DEK); the value is
 * sealed with AES-256-GCM under the DEK, and the DEK is wrapped by a KeyProvider
 * (a local master key in dev, KMS in production).
 */
export interface KeyProvider {
  /** Identifies the master key used, stored next to the ciphertext. */
  readonly keyId: string;
  /** `context` must be bound to the wrapped key (GCM AAD locally, EncryptionContext in KMS). */
  wrap(dek: Buffer, context?: EnvelopeContext): Promise<Buffer>;
  unwrap(wrapped: Buffer, keyId: string, context?: EnvelopeContext): Promise<Buffer>;
}

export type Envelope = {
  keyId: string;
  wrappedDek: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

/** Context of a `secrets` row: bound to its owner and kind. */
export const secretContext = (userId: string, kind: string): EnvelopeContext => ({ userId, kind });

/** Context of an `item_bodies` row: bound to the account it was synced from. */
export const itemBodyContext = (accountId: string): EnvelopeContext => ({
  accountId,
  kind: 'item_body',
});

/**
 * Canonical AAD bytes for a context: keys sorted, so `{ userId, kind }` always encodes the
 * same way. An absent or empty context means "no AAD" (legacy callers only).
 */
export function contextAad(context: EnvelopeContext | undefined): Buffer | null {
  if (!context) return null;
  const keys = Object.keys(context).sort();
  if (keys.length === 0) return null;
  return Buffer.from(JSON.stringify(keys.map((k) => [k, context[k]])), 'utf8');
}

export async function seal(
  provider: KeyProvider,
  plaintext: string | Buffer,
  context?: EnvelopeContext,
): Promise<Envelope> {
  const dek = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const aad = contextAad(context);
    if (aad) cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = await provider.wrap(dek, context);
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

/** Opens an envelope. `context` must equal the one it was sealed with, or this throws. */
export async function open(
  provider: KeyProvider,
  env: Envelope,
  context?: EnvelopeContext,
): Promise<Buffer> {
  const dek = await provider.unwrap(Buffer.from(env.wrappedDek, 'base64'), env.keyId, context);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(env.iv, 'base64'));
    const aad = contextAad(context);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } finally {
    dek.fill(0);
  }
}
