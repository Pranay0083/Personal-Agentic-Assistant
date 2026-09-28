import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentConfigs, modelUsage, providers, users, type Db } from '@hub/db';
import { createTestDb } from '@hub/db/testing';
import { LocalKeyProvider, SecretStore } from '@hub/server/secrets';
import Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { BudgetExceededError, ModelProviderError } from './errors';
import type { AnthropicClientLike } from './providers/anthropic';
import { BedrockProvider } from './providers/bedrock';
import type { ProviderSpec } from './providers/index';
import { OpenAICompatibleProvider, type OpenAIClientLike } from './providers/openai';
import { createRouter } from './router';
import type { GenerateRequest, GenerateResult, ModelProvider } from './types';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let secrets: SecretStore;
let userId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  secrets = new SecretStore(db, new LocalKeyProvider(randomBytes(32).toString('base64')));
});
afterAll(async () => t?.drop());

beforeEach(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: `u${randomBytes(4).toString('hex')}@test.dev` })
    .returning();
  userId = u!.id;
});

class StubProvider implements ModelProvider {
  calls: GenerateRequest[] = [];
  constructor(
    readonly kind: ModelProvider['kind'],
    private readonly behaviour: (n: number) => GenerateResult | Error,
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const r = this.behaviour(this.calls.length);
    if (r instanceof Error) throw r;
    return { ...r, model: req.model };
  }
}

const ok = (
  kind: ModelProvider['kind'],
  inputTokens = 1000,
  outputTokens = 100,
): GenerateResult => ({
  text: 'ok',
  toolCalls: [],
  usage: { inputTokens, outputTokens },
  model: '',
  provider: kind,
});

const req = (agent = 'triage') => ({
  userId,
  agent,
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
});

const noSleep = async () => {};

async function usageRows() {
  return db.select().from(modelUsage).where(eq(modelUsage.userId, userId));
}

describe('createRouter', () => {
  it('uses the recommended model when no agent_config exists and logs usage', async () => {
    const rec = new StubProvider('anthropic', () => ok('anthropic'));
    const router = createRouter({ db, secrets, recommendedProvider: () => rec, sleep: noSleep });
    const res = await router.generate(req('triage'));
    expect(rec.calls[0]!.model).toBe('claude-haiku-4-5');
    expect(rec.calls[0]!.agent).toBe('triage');
    expect(res.fallbackUsed).toBe(false);
    // Haiku 4.5: $1/M in, $5/M out → 1000 in + 100 out = 0.0015
    expect(res.costUsd).toBeCloseTo(0.0015, 6);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: 'triage',
      providerKind: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: '0.001500',
      ok: true,
      fallbackUsed: false,
    });
    expect(rows[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('routes to a user-configured provider and decrypts its key only at call time', async () => {
    const ref = await secrets.put(userId, 'model_provider', 'gsk-secret');
    const [p] = await db
      .insert(providers)
      .values({
        userId,
        kind: 'groq',
        label: 'Groq',
        config: { baseUrl: 'https://g/v1' },
        secretRef: ref,
      })
      .returning();
    await db.insert(agentConfigs).values({
      userId,
      agent: 'triage',
      providerId: p!.id,
      model: 'llama-3.3-70b',
      fallback: true,
    });

    const groq = new StubProvider('groq', () => ok('groq'));
    const factory = vi.fn((spec: ProviderSpec) => {
      expect(spec).toEqual({
        kind: 'groq',
        apiKey: 'gsk-secret',
        config: { baseUrl: 'https://g/v1' },
      });
      return groq;
    });
    const getSpy = vi.spyOn(secrets, 'get');
    const router = createRouter({
      db,
      secrets,
      providerFactory: factory,
      recommendedProvider: () => new StubProvider('anthropic', () => ok('anthropic')),
      sleep: noSleep,
    });
    expect(getSpy).not.toHaveBeenCalled();
    const res = await router.generate(req('triage'));
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(res.provider).toBe('groq');
    expect(groq.calls[0]!.model).toBe('llama-3.3-70b');
    expect(res.costUsd).toBe(0); // unknown price
    getSpy.mockRestore();
  });

  it('retries 429/5xx with backoff, then succeeds', async () => {
    const rec = new StubProvider('anthropic', (n) =>
      n < 3
        ? new ModelProviderError('HTTP 429', { status: 429, retryable: true })
        : ok('anthropic'),
    );
    const sleeps: number[] = [];
    const router = createRouter({
      db,
      secrets,
      recommendedProvider: () => rec,
      backoffMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await router.generate(req('brief'));
    expect(rec.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(res.model).toBe('claude-sonnet-5');
  });

  it('does not retry permanent errors', async () => {
    const rec = new StubProvider(
      'anthropic',
      () => new ModelProviderError('HTTP 400', { status: 400 }),
    );
    const router = createRouter({ db, secrets, recommendedProvider: () => rec, sleep: noSleep });
    await expect(router.generate(req())).rejects.toThrow('HTTP 400');
    expect(rec.calls).toHaveLength(1);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(false);
  });

  it('falls back to the recommended provider and model when fallback is on', async () => {
    const [p] = await db
      .insert(providers)
      .values({ userId, kind: 'openrouter', label: 'OR' })
      .returning();
    await db
      .insert(agentConfigs)
      .values({ userId, agent: 'reply', providerId: p!.id, model: 'some/model', fallback: true });
    const broken = new StubProvider(
      'openrouter',
      () => new ModelProviderError('HTTP 503', { status: 503, retryable: true }),
    );
    const rec = new StubProvider('anthropic', () => ok('anthropic'));
    const router = createRouter({
      db,
      secrets,
      providerFactory: () => broken,
      recommendedProvider: () => rec,
      sleep: noSleep,
    });
    const res = await router.generate(req('reply'));
    expect(broken.calls).toHaveLength(3);
    expect(res.fallbackUsed).toBe(true);
    expect(res.model).toBe('claude-sonnet-5');
    const rows = await usageRows();
    expect(rows.map((r) => [r.providerKind, r.ok, r.fallbackUsed]).sort()).toEqual(
      [
        ['anthropic', true, true],
        ['openrouter', false, false],
      ].sort(),
    );
  });

  it('does not fall back when fallback is off', async () => {
    const [p] = await db
      .insert(providers)
      .values({ userId, kind: 'openrouter', label: 'OR' })
      .returning();
    await db
      .insert(agentConfigs)
      .values({ userId, agent: 'reply', providerId: p!.id, model: 'm', fallback: false });
    const rec = new StubProvider('anthropic', () => ok('anthropic'));
    const router = createRouter({
      db,
      secrets,
      providerFactory: () =>
        new StubProvider('openrouter', () => new ModelProviderError('HTTP 400', { status: 400 })),
      recommendedProvider: () => rec,
      sleep: noSleep,
    });
    await expect(router.generate(req('reply'))).rejects.toThrow('HTTP 400');
    expect(rec.calls).toHaveLength(0);
  });

  it('enforces the monthly cap with BudgetExceededError', async () => {
    await db
      .update(users)
      .set({ settings: { monthlyCapUsd: 1 } })
      .where(eq(users.id, userId));
    const now = new Date('2026-09-28T10:00:00Z');
    await db.insert(modelUsage).values([
      {
        userId,
        agent: 'triage',
        providerKind: 'anthropic',
        model: 'x',
        costUsd: '0.6',
        at: new Date('2026-09-02T00:00:00Z'),
      },
      // Last month does not count.
      {
        userId,
        agent: 'triage',
        providerKind: 'anthropic',
        model: 'x',
        costUsd: '5',
        at: new Date('2026-08-30T00:00:00Z'),
      },
    ]);
    const rec = new StubProvider('anthropic', () => ok('anthropic', 400_000, 0));
    const router = createRouter({
      db,
      secrets,
      recommendedProvider: () => rec,
      sleep: noSleep,
      now: () => now,
    });
    await router.generate(req('triage')); // spent 0.6 < 1 → allowed; costs 0.4
    const err = await router.generate(req('triage')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).spentUsd).toBeCloseTo(1.0, 6);
    expect(rec.calls).toHaveLength(1);
  });

  it('applies a timeout per call', async () => {
    const slow: ModelProvider = {
      kind: 'anthropic',
      generate: () => new Promise(() => {}),
    };
    const router = createRouter({
      db,
      secrets,
      recommendedProvider: () => slow,
      sleep: noSleep,
      attempts: 1,
    });
    await expect(router.generate({ ...req(), timeoutMs: 10 })).rejects.toThrow(/timed out/);
  });
});

describe('Phase 5 acceptance: triage on Groq, planner on Bedrock, clean fallback', () => {
  const AWS = JSON.stringify({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'aws-secret' });

  /** Real adapters with mocked SDK clients, built the way the router builds them. */
  function setup(opts: { groqDown?: boolean; bedrockDown?: boolean } = {}) {
    const groqCreate = vi.fn(async (body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) => {
      if (opts.groqDown) {
        throw new ModelProviderError('groq: HTTP 503', { status: 503, retryable: true });
      }
      return {
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            logprobs: null,
            message: { role: 'assistant', content: '{"bucket":"fyi"}', refusal: null },
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      } as OpenAI.Chat.ChatCompletion;
    });
    const bedrockCreate = vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      if (opts.bedrockDown) throw new Anthropic.APIConnectionError({ message: 'unreachable' });
      return {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: 'plan', citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 100 },
      } as Anthropic.Message;
    });
    const specs: ProviderSpec[] = [];
    const factory = (spec: ProviderSpec) => {
      specs.push(spec);
      if (spec.kind === 'groq') {
        return new OpenAICompatibleProvider({
          kind: 'groq',
          ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
          client: { chat: { completions: { create: groqCreate } } } as unknown as OpenAIClientLike,
        });
      }
      if (spec.kind === 'bedrock') {
        return new BedrockProvider({
          ...(spec.config.region ? { region: spec.config.region } : {}),
          ...(spec.apiKey ? { secret: spec.apiKey } : {}),
          client: { messages: { create: bedrockCreate } } as unknown as AnthropicClientLike,
          production: false,
        });
      }
      throw new Error(`unexpected kind ${spec.kind}`);
    };
    const rec = new StubProvider('anthropic', () => ok('anthropic'));
    const router = createRouter({
      db,
      secrets,
      providerFactory: factory,
      recommendedProvider: () => rec,
      sleep: noSleep,
    });
    return { router, rec, specs, groqCreate, bedrockCreate };
  }

  async function configure() {
    const groqKey = await secrets.put(userId, 'provider:groq', 'gsk-live');
    const awsKey = await secrets.put(userId, 'provider:bedrock', AWS);
    const [groq, aws] = await db
      .insert(providers)
      .values([
        { userId, kind: 'groq', label: 'Groq', config: {}, secretRef: groqKey },
        {
          userId,
          kind: 'bedrock',
          label: 'AWS',
          config: { region: 'us-east-1' },
          secretRef: awsKey,
        },
      ])
      .returning();
    await db.insert(agentConfigs).values([
      {
        userId,
        agent: 'triage',
        providerId: groq!.id,
        model: 'llama-3.3-70b-versatile',
        fallback: true,
      },
      { userId, agent: 'planner', providerId: aws!.id, model: 'claude-opus-5-5', fallback: true },
    ]);
  }

  it('routes triage to Groq and planning to Bedrock', async () => {
    await configure();
    const { router, rec, specs, groqCreate, bedrockCreate } = setup();

    const t1 = await router.generate(req('triage'));
    expect(t1).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(t1.fallbackUsed).toBe(false);
    expect(groqCreate).toHaveBeenCalledTimes(1);
    expect(groqCreate.mock.calls[0]![0].model).toBe('llama-3.3-70b-versatile');

    const p1 = await router.generate(req('planner'));
    expect(p1).toMatchObject({ provider: 'bedrock', model: 'anthropic.claude-opus-5-5' });
    expect(p1.fallbackUsed).toBe(false);
    expect(bedrockCreate.mock.calls[0]![0].model).toBe('anthropic.claude-opus-5-5');
    expect(p1.costUsd).toBeCloseTo(0.006, 6); // Opus 5.5 list price: $4/M in, $20/M out

    expect(rec.calls).toHaveLength(0);
    expect(specs.map((s) => [s.kind, s.apiKey, s.config])).toEqual([
      ['groq', 'gsk-live', {}],
      ['bedrock', AWS, { region: 'us-east-1' }],
    ]);
    const rows = await usageRows();
    expect(
      rows.map((r) => [r.agent, r.providerKind, r.model, r.ok, r.fallbackUsed]).sort(),
    ).toEqual(
      [
        ['planner', 'bedrock', 'anthropic.claude-opus-5-5', true, false],
        ['triage', 'groq', 'llama-3.3-70b-versatile', true, false],
      ].sort(),
    );
  });

  it('falls back to the recommended model when Bedrock is down, and logs both legs', async () => {
    await configure();
    const { router, rec, bedrockCreate } = setup({ bedrockDown: true });
    const res = await router.generate(req('planner'));
    expect(bedrockCreate).toHaveBeenCalledTimes(3); // connection errors are retried first
    expect(res).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(res.fallbackUsed).toBe(true);
    expect(rec.calls[0]!.model).toBe('claude-opus-5-5');
    const rows = await usageRows();
    expect(rows.map((r) => [r.providerKind, r.model, r.ok, r.fallbackUsed]).sort()).toEqual(
      [
        ['anthropic', 'claude-opus-5-5', true, true],
        ['bedrock', 'claude-opus-5-5', false, false],
      ].sort(),
    );
  });

  it('falls back when Groq is down, and when the Bedrock config is broken', async () => {
    await configure();
    const down = setup({ groqDown: true });
    const t1 = await down.router.generate(req('triage'));
    expect(t1).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      fallbackUsed: true,
    });

    // A config error (bad region) fails before any request and falls back the same way.
    await db
      .update(providers)
      .set({ config: { region: 'not a region' } })
      .where(eq(providers.kind, 'bedrock'));
    const broken = setup();
    const p1 = await broken.router.generate(req('planner'));
    expect(broken.bedrockCreate).not.toHaveBeenCalled();
    expect(p1).toMatchObject({ provider: 'anthropic', fallbackUsed: true });
    const rows = await usageRows();
    expect(rows.filter((r) => r.fallbackUsed && r.ok)).toHaveLength(2);
    expect(
      rows
        .filter((r) => !r.ok)
        .map((r) => r.providerKind)
        .sort(),
    ).toEqual(['bedrock', 'groq']);
  });
});
