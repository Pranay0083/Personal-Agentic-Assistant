import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { agentConfigs, providers } from '@hub/db';
import {
  AgentName,
  RECOMMENDED_MODELS,
  type AgentConfig,
  type ModelProviderConfig,
  type ModelProviderKind,
} from '@hub/shared';
import { AddProviderReq, SetAgentModelReq } from '@hub/shared/api';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest, idParam, notFound, parse } from '../http';
import { toModelProvider } from '../serialize';

const AGENTS = AgentName.options;
const AgentParam = z.object({ agent: AgentName });

/** Config keys that look like secrets are refused: secrets go in `secret`, encrypted. */
const SECRET_KEY = /secret|token|password|passwd|api[-_]?key|credential|private/i;

const KIND_LABEL: Record<ModelProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  azure: 'Azure OpenAI',
  openai_compatible: 'OpenAI-compatible',
  ollama: 'Ollama',
  fake: 'Fake (offline)',
};

const HUB_OPTIONS: { providerKind: ModelProviderKind; model: string; label: string }[] = [
  { providerKind: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { providerKind: 'anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { providerKind: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
];

function modelsFromConfig(config: Record<string, string>): string[] {
  const list = [config.model, ...(config.models ?? '').split(',')];
  return [...new Set(list.map((m) => m?.trim()).filter((m): m is string => !!m))];
}

export function modelRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, secrets } = ctx;

  app.get('/models', async (req) => {
    const userId = req.auth.userId;
    const configs = await db.select().from(agentConfigs).where(eq(agentConfigs.userId, userId));
    const provs = await db
      .select()
      .from(providers)
      .where(eq(providers.userId, userId))
      .orderBy(asc(providers.createdAt));

    const agents: AgentConfig[] = AGENTS.map((agent) => {
      const c = configs.find((x) => x.agent === agent);
      return c
        ? { agent, providerId: c.providerId, model: c.model, fallback: c.fallback }
        : { agent, providerId: null, model: RECOMMENDED_MODELS[agent], fallback: true };
    });
    const providerList: ModelProviderConfig[] = provs.map(toModelProvider);

    const options = [...HUB_OPTIONS];
    for (const p of providerList) {
      for (const model of modelsFromConfig(p.config)) {
        if (!options.some((o) => o.providerKind === p.kind && o.model === model)) {
          options.push({ providerKind: p.kind, model, label: `${model} (${p.label})` });
        }
      }
    }
    return { agents, providers: providerList, options };
  });

  app.put('/models/agents/:agent', async (req): Promise<AgentConfig> => {
    const userId = req.auth.userId;
    const p = AgentParam.safeParse(req.params);
    if (!p.success) throw notFound('agent');
    const agent = p.data.agent;
    const body = parse(SetAgentModelReq, req.body);
    if (body.providerId) {
      const [prov] = await db
        .select({ id: providers.id })
        .from(providers)
        .where(and(eq(providers.id, body.providerId), eq(providers.userId, userId)));
      if (!prov) throw badRequest('providerId: unknown provider');
    }
    await db
      .insert(agentConfigs)
      .values({
        userId,
        agent,
        providerId: body.providerId,
        model: body.model,
        fallback: body.fallback,
      })
      .onConflictDoUpdate({
        target: [agentConfigs.userId, agentConfigs.agent],
        set: { providerId: body.providerId, model: body.model, fallback: body.fallback },
      });
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'model.agent_set',
      target: `agent:${agent}`,
      details: { providerId: body.providerId, model: body.model, fallback: body.fallback },
    });
    return { agent, providerId: body.providerId, model: body.model, fallback: body.fallback };
  });

  app.post('/models/providers', async (req): Promise<ModelProviderConfig> => {
    const userId = req.auth.userId;
    const body = parse(AddProviderReq, req.body);
    const badKey = Object.keys(body.config).find((k) => SECRET_KEY.test(k));
    if (badKey) throw badRequest(`config.${badKey}: put secrets in "secret", not config`);

    // Encrypted at rest; only secret_ref is stored and the value is never echoed or logged.
    const secretRef = body.secret
      ? await secrets.put(userId, `provider:${body.kind}`, body.secret)
      : null;
    const [row] = await db
      .insert(providers)
      .values({
        userId,
        kind: body.kind,
        label: body.label?.trim() || KIND_LABEL[body.kind],
        config: body.config,
        secretRef,
        status: 'unverified',
        createdAt: ctx.now(),
      })
      .returning();
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'model.provider_added',
      target: `provider:${row!.id}`,
      details: { kind: body.kind, hasSecret: secretRef !== null },
    });
    return toModelProvider(row!);
  });

  app.delete('/models/providers/:id', async (req, reply) => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const [row] = await db
      .delete(providers)
      .where(and(eq(providers.id, id), eq(providers.userId, userId)))
      .returning();
    if (!row) throw notFound('provider');
    if (row.secretRef) await secrets.delete(row.secretRef);
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'model.provider_deleted',
      target: `provider:${id}`,
      details: { kind: row.kind },
    });
    return reply.code(204).send();
  });
}
