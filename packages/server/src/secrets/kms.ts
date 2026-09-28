import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { KeyProvider } from './envelope';

/** Production key provider: DEKs are wrapped by an AWS KMS key and never leave memory unwrapped. */
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

  async wrap(dek: Buffer): Promise<Buffer> {
    const out = await this.client.send(new EncryptCommand({ KeyId: this.arn, Plaintext: dek }));
    if (!out.CiphertextBlob) throw new Error('KMS Encrypt returned no ciphertext');
    return Buffer.from(out.CiphertextBlob);
  }

  async unwrap(wrapped: Buffer, keyId: string): Promise<Buffer> {
    if (!keyId.startsWith('kms:')) throw new Error(`cannot unwrap ${keyId} with KMS`);
    const out = await this.client.send(
      new DecryptCommand({ CiphertextBlob: wrapped, KeyId: keyId.slice('kms:'.length) }),
    );
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(out.Plaintext);
  }
}
