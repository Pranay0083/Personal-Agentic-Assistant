import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const bool = z
  .enum(['1', '0', 'true', 'false', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().default('postgres://hub:hub@localhost:5434/hub'),
  REDIS_URL: z.string().default('redis://localhost:6380'),

  API_PORT: z.coerce.number().default(4000),
  GATEWAY_PORT: z.coerce.number().default(4001),
  MCP_PORT: z.coerce.number().default(4002),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  PUBLIC_GATEWAY_URL: z.string().default('http://localhost:4001'),
  PUBLIC_MCP_URL: z.string().default('http://localhost:4002/mcp'),
  APP_SCHEME: z.string().default('hub'),

  SESSION_SECRET: z.string().min(32).default('dev-only-session-secret-change-me-0123456789'),
  DEV_AUTH: bool,

  SECRETS_PROVIDER: z.enum(['local', 'kms']).default('local'),
  LOCAL_MASTER_KEY: z.string().optional(),
  KMS_KEY_ID: z.string().optional(),
  AWS_REGION: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  GOOGLE_SIGNIN_CLIENT_IDS: z.string().optional(),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  GMAIL_PUBSUB_AUDIENCE: z.string().optional(),
  GMAIL_PUBSUB_SERVICE_ACCOUNT: z.string().optional(),
  GMAIL_FAKE: bool,

  MODEL_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),

  EXPO_ACCESS_TOKEN: z.string().optional(),
  PUSH_FAKE: bool,
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Loads the repo-root .env (if present) once and validates it. */
export function env(): Env {
  if (cached) return cached;
  for (let dir = process.cwd(), i = 0; i < 4; i++, dir = path.dirname(dir)) {
    const file = path.join(dir, '.env');
    if (existsSync(file) && existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      loadEnvFile(file);
      break;
    }
  }
  cached = EnvSchema.parse(process.env);
  return cached;
}

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const v = env()[key];
  if (v === undefined || v === null || v === '') throw new Error(`${String(key)} is not set`);
  return v as NonNullable<Env[K]>;
}

/** For tests. */
export function resetEnv() {
  cached = undefined;
}
