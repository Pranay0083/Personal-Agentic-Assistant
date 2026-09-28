import type { Db } from '@hub/db';
import type { Logger } from '@hub/server';
import type { KeyProvider } from '@hub/server/secrets';
import type { LiveEvent, QueueName } from '@hub/shared/queues';

export type EnqueueFn = (
  name: QueueName,
  data: unknown,
  opts?: { jobId?: string },
) => Promise<unknown>;
export type PublishLiveFn = (userId: string, event: LiveEvent) => Promise<void>;

export type RateLimitConfig = {
  /** Consent submissions (email form) per IP per window. */
  consentPerIp: number;
  /** Consent submissions per email address per window. */
  consentPerEmail: number;
  /** Status polls per IP per window. */
  statusPerIp: number;
  windowMs: number;
};

export type McpDeps = {
  db: Db;
  /** Opens sealed item bodies (envelopes in item_bodies). */
  secrets: KeyProvider;
  enqueue: EnqueueFn;
  publishLive: PublishLiveFn;
  now?: () => Date;
  /** Public URL of the MCP endpoint, e.g. http://localhost:4002/mcp (PUBLIC_MCP_URL). */
  publicUrl: string;
  logger?: Logger;
  rateLimits?: Partial<RateLimitConfig>;
  /** Access token lifetime. Default one hour. */
  accessTokenTtlSeconds?: number;
  /** How long a connect request waits for the phone. Default ten minutes. */
  connectRequestTtlMs?: number;
};

export type Ctx = Required<Omit<McpDeps, 'logger' | 'rateLimits'>> & {
  logger: Logger | undefined;
  rateLimits: RateLimitConfig;
};

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  consentPerIp: 10,
  consentPerEmail: 5,
  statusPerIp: 600,
  windowMs: 15 * 60 * 1000,
};

export function resolveCtx(deps: McpDeps): Ctx {
  return {
    db: deps.db,
    secrets: deps.secrets,
    enqueue: deps.enqueue,
    publishLive: deps.publishLive,
    now: deps.now ?? (() => new Date()),
    publicUrl: deps.publicUrl,
    logger: deps.logger,
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits },
    accessTokenTtlSeconds: deps.accessTokenTtlSeconds ?? 3600,
    connectRequestTtlMs: deps.connectRequestTtlMs ?? 10 * 60 * 1000,
  };
}
