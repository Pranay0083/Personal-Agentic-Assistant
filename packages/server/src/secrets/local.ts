import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { contextAad, type EnvelopeContext, type KeyProvider } from './envelope';

/**
 * Dev-only key provider: wraps DEKs with AES-256-GCM under a local 32-byte master key,
 * with the envelope context as AAD. Wrapped format: iv(12) | tag(16) | ciphertext(32).
 */
export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(masterKeyBase64: string, name = 'LOCAL_MASTER_KEY') {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
    this.key = key;
    this.keyId = `local:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  }

  async wrap(dek: Buffer, context?: EnvelopeContext): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const aad = contextAad(context);
    if (aad) cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  async unwrap(wrapped: Buffer, keyId: string, context?: EnvelopeContext): Promise<Buffer> {
    if (keyId !== this.keyId) throw new Error(`secret was sealed with ${keyId}, not ${this.keyId}`);
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    const aad = contextAad(context);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}
