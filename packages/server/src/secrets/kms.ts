import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { EnvelopeContext, KeyProvider } from './envelope';

/**
 * Production key provider: DEKs are wrapped by an AWS KMS key and never leave memory
 * unwrapped. The envelope context is sent as the KMS EncryptionContext, so Decrypt only
 * succeeds for the same `{ userId, kind }` (and CloudTrail records it).
 */
export class KmsKeyProvider implements KeyProvider {
  readonly keyId: string;
  private readonly client: Pick<KMSClient, 'send'>;

  constructor(kmsKeyId: string, client: Pick<KMSClient, 'send'> = new KMSClient({})) {
    this.keyId = `kms:${kmsKeyId}`;
    this.client = client;
  }

  private get arn() {
    return this.keyId.slice('kms:'.length);
  }

  async wrap(dek: Buffer, context?: EnvelopeContext): Promise<Buffer> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.arn,
        Plaintext: dek,
        ...(context ? { EncryptionContext: { ...context } } : {}),
      }),
    );
    if (!out.CiphertextBlob) throw new Error('KMS Encrypt returned no ciphertext');
    return Buffer.from(out.CiphertextBlob);
  }

  async unwrap(wrapped: Buffer, keyId: string, context?: EnvelopeContext): Promise<Buffer> {
    if (!keyId.startsWith('kms:')) throw new Error(`cannot unwrap ${keyId} with KMS`);
    const out = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: wrapped,
        KeyId: keyId.slice('kms:'.length),
        ...(context ? { EncryptionContext: { ...context } } : {}),
      }),
    );
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(out.Plaintext);
  }
}
