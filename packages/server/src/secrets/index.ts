import { env } from '../env';
import type { KeyProvider } from './envelope';
import { KmsKeyProvider } from './kms';
import { LocalKeyProvider } from './local';

export * from './envelope';
export { LocalKeyProvider } from './local';
export { KmsKeyProvider } from './kms';
export { SecretStore } from './store';

let provider: KeyProvider | undefined;

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
