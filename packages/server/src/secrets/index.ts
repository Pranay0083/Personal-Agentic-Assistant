import type { Db } from '@hub/db';
import { keyProvider, writeKeyProvider } from './providers';
import { SecretStore } from './store';

export * from './envelope';
export { LocalKeyProvider } from './local';
export { KmsKeyProvider } from './kms';
export { keyProvider, writeKeyProvider } from './providers';
export {
  SecretStore,
  WriteSecretAccessError,
  isWriteKind,
  type SecretExpectation,
  type SecretStoreOptions,
} from './store';

/**
 * A SecretStore on the configured keys. Pass `allowWriteDecrypt: true` only in the
 * executor process: it is the one place write-scope tokens are decrypted.
 */
export function createSecretStore(db: Db, opts: { allowWriteDecrypt?: boolean } = {}) {
  return new SecretStore(db, keyProvider(), {
    writeKeys: writeKeyProvider(),
    allowWriteDecrypt: opts.allowWriteDecrypt === true,
  });
}
