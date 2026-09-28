import { describe, expect, it } from 'vitest';
import { DEV_SESSION_SECRET, parseEnv, productionProblems } from './env';

const PROD = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'a-real-production-session-secret-0123456789abcdef',
  SECRETS_PROVIDER: 'kms',
  KMS_KEY_ID: 'arn:aws:kms:us-east-1:1:key/read',
  WRITE_KMS_KEY_ID: 'arn:aws:kms:us-east-1:1:key/write',
  MODEL_PROVIDER: 'anthropic',
};

describe('env', () => {
  it('requires NODE_ENV explicitly (no silent development default)', () => {
    expect(() => parseEnv({})).toThrow(/NODE_ENV must be set/);
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(parseEnv({ NODE_ENV: 'development' }).NODE_ENV).toBe('development');
    expect(parseEnv({ NODE_ENV: 'test' }).NODE_ENV).toBe('test');
  });

  it('accepts a safe production config', () => {
    expect(parseEnv(PROD).NODE_ENV).toBe('production');
  });

  it.each([
    ['the default SESSION_SECRET', { SESSION_SECRET: undefined }],
    ['the default SESSION_SECRET (explicit)', { SESSION_SECRET: DEV_SESSION_SECRET }],
    ['DEV_AUTH', { DEV_AUTH: '1' }],
    ['GMAIL_FAKE', { GMAIL_FAKE: 'true' }],
    ['MODEL_PROVIDER=fake', { MODEL_PROVIDER: 'fake' }],
    ['PUSH_FAKE', { PUSH_FAKE: '1' }],
    ['SECRETS_PROVIDER=local', { SECRETS_PROVIDER: 'local' }],
    ['SECRETS_PROVIDER unset (defaults to local)', { SECRETS_PROVIDER: undefined }],
  ])('refuses to start in production with %s', (_name, over) => {
    expect(() => parseEnv({ ...PROD, ...over })).toThrow(/refusing to start in production/);
  });

  it('allows the dev conveniences outside production', () => {
    const dev = parseEnv({
      NODE_ENV: 'development',
      DEV_AUTH: '1',
      GMAIL_FAKE: '1',
      MODEL_PROVIDER: 'fake',
      PUSH_FAKE: '1',
    });
    expect(productionProblems(dev)).toEqual([]);
  });
});
