import { and, eq, gte, sql } from 'drizzle-orm';
import { agentConfigs, modelUsage, providers, users, type Db } from '@hub/db';
import { createLogger, env, type Logger } from '@hub/server';
import { RECOMMENDED_MODELS, UserSettings, type ModelProviderKind } from '@hub/shared';
import { BudgetExceededError, ModelConfigError, ModelTimeoutError, isRetryable } from './errors';
import { costUsd } from './prices';
import { AnthropicProvider } from './providers/anthropic';
import { FakeProvider } from './providers/fake';
import { defaultProviderFactory, type ProviderFactory } from './providers/index';
import type {
  GenerateResult,
  ModelProvider,
  ModelRouter,
  RouteRequest,
  RouteResult,
} from './types';

/** Model for agents with no recommended default (e.g. `ask`). */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export function recommendedModel(agent: string): string {
  return (RECOMMENDED_MODELS as Record<string, string>)[agent] ?? DEFAULT_MODEL;
}

export type RouterOptions = {
  db: Db;
  /** Decrypts user provider keys at call time. */
  secrets: { get(ref: string): Promise<string> };
  /** Builds adapters for user-configured providers. Tests inject fakes. */
  providerFactory?: ProviderFactory;
  /** The hub-managed recommended provider. Default: fake if MODEL_PROVIDER=fake, else Anthropic. */
  recommendedProvider?: () => ModelProvider;
  /** Attempts per provider (first try + retries). Default 3. */
  attempts?: number;
  /** Base backoff in ms, doubled per retry, with jitter. Default 500. */
  backoffMs?: number;
  /** Default per-call timeout. Default 60s. */
  timeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
};

type Leg = {
  provider: ModelProvider;
  model: string;
  /** True for the hub's recommended provider + model. */
  recommended: boolean;
};

function defaultRecommendedProvider(): ModelProvider {
  const e = env();
  if (e.MODEL_PROVIDER === 'fake') return new FakeProvider();
  if (!e.ANTHROPIC_API_KEY) {
    throw new ModelConfigError('ANTHROPIC_API_KEY is not set (or set MODEL_PROVIDER=fake)');
  }
  return new AnthropicProvider({ apiKey: e.ANTHROPIC_API_KEY });
}

/** Start of the current calendar month, UTC. The monthly cap resets at 00:00 UTC on the 1st. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function createRouter(opts: RouterOptions): ModelRouter {
  const { db, secrets } = opts;
  const factory = opts.providerFactory ?? defaultProviderFactory;
  const recommended = opts.recommendedProvider ?? defaultRecommendedProvider;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 500;
  const defaultTimeout = opts.timeoutMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.logger ?? createLogger('models');

  async function checkBudget(userId: string) {
    const [user] = await db
      .select({ settings: users.settings })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new ModelConfigError('user not found');
    const parsed = UserSettings.safeParse(user.settings ?? {});
    const cap = parsed.success ? parsed.data.monthlyCapUsd : null;
    if (cap === null || cap === undefined) return;
    const [row] = await db
      .select({ spent: sql<string>`coalesce(sum(${modelUsage.costUsd}), 0)` })
      .from(modelUsage)
      .where(and(eq(modelUsage.userId, userId), gte(modelUsage.at, monthStart(now()))));
    const spent = Number(row?.spent ?? 0);
    if (spent >= cap) throw new BudgetExceededError(userId, cap, spent);
  }

  async function resolvePrimary(
    userId: string,
    agent: string,
  ): Promise<{ leg: () => Promise<Leg>; fallback: boolean; recommendedLeg: boolean }> {
    const [cfg] = await db
      .select()
      .from(agentConfigs)
      .where(and(eq(agentConfigs.userId, userId), eq(agentConfigs.agent, agent)));
    if (!cfg) {
      return {
        leg: async () => ({
          provider: recommended(),
          model: recommendedModel(agent),
          recommended: true,
        }),
        fallback: true,
        recommendedLeg: true,
      };
    }
    if (!cfg.providerId) {
      const isRec = cfg.model === recommendedModel(agent);
      return {
        leg: async () => ({ provider: recommended(), model: cfg.model, recommended: isRec }),
        fallback: cfg.fallback,
        recommendedLeg: isRec,
      };
    }
    const providerId = cfg.providerId;
    return {
      // Built lazily so the key is decrypted only right before the call.
      leg: async () => {
        const [p] = await db
          .select()
          .from(providers)
          .where(and(eq(providers.id, providerId), eq(providers.userId, userId)));
        if (!p) throw new ModelConfigError('configured model provider not found');
        const apiKey = p.secretRef ? await secrets.get(p.secretRef) : undefined;
        const provider = factory({
          kind: p.kind as ModelProviderKind,
          ...(apiKey ? { apiKey } : {}),
          config: (p.config ?? {}) as Record<string, string>,
        });
        return { provider, model: cfg.model, recommended: false };
      },
      fallback: cfg.fallback,
      recommendedLeg: false,
    };
  }

  async function callWithRetry(leg: Leg, req: RouteRequest): Promise<GenerateResult> {
    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        const delay = backoffMs * 2 ** (i - 1);
        await sleep(delay + Math.floor(Math.random() * (delay / 2)));
      }
      try {
        return await withTimeout(
          leg.provider.generate({
            model: leg.model,
            system: req.system,
            messages: req.messages,
            ...(req.tools ? { tools: req.tools } : {}),
            ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.effort ? { effort: req.effort } : {}),
            ...(req.json ? { json: true } : {}),
            timeoutMs,
            agent: req.agent,
          }),
          timeoutMs,
        );
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) break;
      }
    }
    throw lastErr;
  }

  async function logUsage(
    req: RouteRequest,
    kind: string,
    model: string,
    res: GenerateResult | null,
    latencyMs: number,
    fallbackUsed: boolean,
  ): Promise<number> {
    const cost = res ? costUsd(res.provider, res.model, res.usage) : 0;
    await db.insert(modelUsage).values({
      userId: req.userId,
      agent: req.agent,
      providerKind: kind,
      model,
      inputTokens: res?.usage.inputTokens ?? 0,
      outputTokens: res?.usage.outputTokens ?? 0,
      costUsd: cost.toFixed(6),
      latencyMs,
      ok: res !== null,
      fallbackUsed,
    });
    log.info(
      { agent: req.agent, provider: kind, model, latencyMs, ok: res !== null, fallbackUsed },
      'model call',
    );
    return cost;
  }

  async function runLeg(
    getLeg: () => Promise<Leg>,
    req: RouteRequest,
    fallbackUsed: boolean,
  ): Promise<RouteResult> {
    const started = Date.now();
    let leg: Leg | undefined;
    try {
      leg = await getLeg();
      const res = await callWithRetry(leg, req);
      const cost = await logUsage(
        req,
        res.provider,
        res.model,
        res,
        Date.now() - started,
        fallbackUsed,
      );
      return { ...res, fallbackUsed, costUsd: cost };
    } catch (err) {
      await logUsage(
        req,
        leg?.provider.kind ?? 'unknown',
        leg?.model ?? 'unknown',
        null,
        Date.now() - started,
        fallbackUsed,
      );
      throw err;
    }
  }

  return {
    async generate(req) {
      await checkBudget(req.userId);
      const primary = await resolvePrimary(req.userId, req.agent);
      try {
        return await runLeg(primary.leg, req, false);
      } catch (err) {
        if (!primary.fallback || primary.recommendedLeg || err instanceof BudgetExceededError) {
          throw err;
        }
        log.warn(
          { agent: req.agent, error: err instanceof Error ? err.name : 'error' },
          'model call failed; falling back to recommended model',
        );
        return runLeg(
          async () => ({
            provider: recommended(),
            model: recommendedModel(req.agent),
            recommended: true,
          }),
          req,
          true,
        );
      }
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ModelTimeoutError(ms)), ms + 1_000);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
