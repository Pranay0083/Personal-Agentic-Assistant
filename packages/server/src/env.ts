import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const bool = z
  .enum(['1', '0', 'true', 'false', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true');

/** Public default for local dev only. Production refuses to start with it. */
export const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me-0123456789';

const EnvSchema = z.object({
  /**
   * Required, no default: every production guard keys off it, so an unset NODE_ENV must
   * not silently mean "development". The repo-root .env sets it for `pnpm dev`; Vitest
   * sets `test`; production deployments must set `production`.
   */
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    error: 'NODE_ENV must be set to development, test or production',
  }),
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

  SESSION_SECRET: z.string().min(32).default(DEV_SESSION_SECRET),
  DEV_AUTH: bool,

  SECRETS_PROVIDER: z.enum(['local', 'kms']).default('local'),
  LOCAL_MASTER_KEY: z.string().optional(),
  KMS_KEY_ID: z.string().optional(),
  /** Separate master key for write-scope tokens (see secrets/providers.ts). */
  LOCAL_WRITE_MASTER_KEY: z.string().optional(),
  WRITE_KMS_KEY_ID: z.string().optional(),
  AWS_REGION: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  GOOGLE_SIGNIN_CLIENT_IDS: z.string().optional(),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  GMAIL_PUBSUB_AUDIENCE: z.string().optional(),
  GMAIL_PUBSUB_SERVICE_ACCOUNT: z.string().optional(),
  GMAIL_FAKE: bool,
  /** Google Workspace Events API → Pub/Sub topic for Google Chat message events. */
  GOOGLE_EVENTS_PUBSUB_TOPIC: z.string().optional(),
  GOOGLE_EVENTS_PUBSUB_AUDIENCE: z.string().optional(),

  /** 1 = every connector serves recorded fixtures (demo mode). Refused in production. */
  CONNECTORS_FAKE: bool,

  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  MS_TENANT: z.string().default('common'),

  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  ATLASSIAN_CLIENT_ID: z.string().optional(),
  ATLASSIAN_CLIENT_SECRET: z.string().optional(),

  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  NOTION_WEBHOOK_VERIFICATION_TOKEN: z.string().optional(),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  MODEL_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),

  EXPO_ACCESS_TOKEN: z.string().optional(),
  PUSH_FAKE: bool,
});

export type Env = z.infer<typeof EnvSchema>;

/** Settings that are fine locally but must never reach production. */
export function productionProblems(e: Env): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  if (e.SESSION_SECRET === DEV_SESSION_SECRET) out.push('SESSION_SECRET is the public default');
  if (e.DEV_AUTH) out.push('DEV_AUTH must be off');
  if (e.GMAIL_FAKE) out.push('GMAIL_FAKE must be off');
  if (e.CONNECTORS_FAKE) out.push('CONNECTORS_FAKE must be off');
  if (e.MODEL_PROVIDER === 'fake') out.push('MODEL_PROVIDER=fake is not allowed');
  if (e.PUSH_FAKE) out.push('PUSH_FAKE must be off');
  if (e.SECRETS_PROVIDER === 'local') out.push('SECRETS_PROVIDER=local is not allowed');
  return out;
}

/** Validates an environment. Throws on missing NODE_ENV or unsafe production settings. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const res = EnvSchema.safeParse(source);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid environment: ${issues.join('; ')}`);
  }
  const problems = productionProblems(res.data);
  if (problems.length) {
    throw new Error(`refusing to start in production: ${problems.join('; ')}`);
  }
  return res.data;
}

/** True only when NODE_ENV is explicitly `production` (env() refuses to run without NODE_ENV). */
export const isProduction = () => env().NODE_ENV === 'production';

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
  cached = parseEnv(process.env);
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
