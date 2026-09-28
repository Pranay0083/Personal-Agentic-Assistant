import { randomBytes } from 'node:crypto';
import { env } from '../env';
import type { KeyProvider } from './envelope';
import { KmsKeyProvider } from './kms';
import { LocalKeyProvider } from './local';

let provider: KeyProvider | undefined;
let writeProvider: KeyProvider | undefined;

/** The configured key provider: local master key in dev, KMS in production. */
export function keyProvider(): KeyProvider {
  if (provider) return provider;
  const e = env();
  if (e.SECRETS_PROVIDER === 'kms') {
    if (!e.KMS_KEY_ID) throw new Error('KMS_KEY_ID is required when SECRETS_PROVIDER=kms');
    provider = new KmsKeyProvider(e.KMS_KEY_ID);
  } else {
    if (e.NODE_ENV === 'production')
      throw new Error('SECRETS_PROVIDER=local is not allowed in production');
    if (!e.LOCAL_MASTER_KEY) throw new Error('LOCAL_MASTER_KEY is not set (see .env.example)');
    provider = new LocalKeyProvider(e.LOCAL_MASTER_KEY);
  }
  return provider;
}

/**
 * The key provider for write-scope secrets (kinds ending in `:write`): a separate master
 * key, so a process that can decrypt read tokens cannot decrypt write tokens.
 * - kms: WRITE_KMS_KEY_ID. IAM grants Encrypt to the API (it stores tokens after consent)
 *   and Decrypt only to the executor role.
 * - local (dev): LOCAL_WRITE_MASTER_KEY. Tests without one get an ephemeral key.
 */
export function writeKeyProvider(): KeyProvider {
  if (writeProvider) return writeProvider;
  const e = env();
  if (e.SECRETS_PROVIDER === 'kms') {
    if (!e.WRITE_KMS_KEY_ID)
      throw new Error('WRITE_KMS_KEY_ID is required when SECRETS_PROVIDER=kms');
    if (e.WRITE_KMS_KEY_ID === e.KMS_KEY_ID)
      throw new Error('WRITE_KMS_KEY_ID must be a different key from KMS_KEY_ID');
    writeProvider = new KmsKeyProvider(e.WRITE_KMS_KEY_ID);
  } else {
    if (e.NODE_ENV === 'production')
      throw new Error('SECRETS_PROVIDER=local is not allowed in production');
    if (e.LOCAL_WRITE_MASTER_KEY) {
      if (e.LOCAL_WRITE_MASTER_KEY === e.LOCAL_MASTER_KEY)
        throw new Error('LOCAL_WRITE_MASTER_KEY must differ from LOCAL_MASTER_KEY');
      writeProvider = new LocalKeyProvider(e.LOCAL_WRITE_MASTER_KEY, 'LOCAL_WRITE_MASTER_KEY');
    } else if (e.NODE_ENV === 'test') {
      writeProvider = new LocalKeyProvider(randomBytes(32).toString('base64'));
    } else {
      throw new Error('LOCAL_WRITE_MASTER_KEY is not set (see .env.example)');
    }
  }
  return writeProvider;
}
