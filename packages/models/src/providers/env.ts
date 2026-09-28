import { env } from '@hub/server';

/**
 * Whether production-only safety rules apply. Read from the validated env (which refuses
 * to run without an explicit NODE_ENV); if the env cannot be read, assume production so
 * the guards fail closed.
 */
export function productionDefault(): boolean {
  try {
    return env().NODE_ENV === 'production';
  } catch {
    return true;
  }
}
