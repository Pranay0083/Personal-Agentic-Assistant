import pino, { type Logger } from 'pino';

/**
 * Fields that must never reach logs: tokens, keys, message bodies and text.
 * Redaction is a safety net; don't pass these to the logger in the first place.
 */
export const REDACT_PATHS = [
  'token',
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'idToken',
  'secret',
  'apiKey',
  'password',
  'authorization',
  'body',
  'text',
  'content',
  'snippet',
  'payload.body',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.body',
  '*.text',
  '*.content',
];

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name,
    level: process.env.NODE_ENV === 'test' ? 'silent' : level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}

export type { Logger };
