import { z } from 'zod';

export const ModelProviderKind = z.enum([
  'anthropic',
  'openai',
  'bedrock',
  'vertex',
  'groq',
  'openrouter',
  'azure',
  'openai_compatible',
  'ollama',
  'fake',
]);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

/** Recommended defaults from ARCHITECTURE.md. */
export const RECOMMENDED_MODELS = {
  triage: 'claude-haiku-4-5',
  extractor: 'claude-haiku-4-5',
  brief: 'claude-sonnet-5',
  reply: 'claude-sonnet-5',
  planner: 'claude-opus-5-5',
} as const;

export const ModelProviderConfig = z.object({
  id: z.uuid(),
  kind: ModelProviderKind,
  label: z.string(),
  /** Non-secret config only (region, baseUrl, project id). Secrets never leave the server. */
  config: z.record(z.string(), z.string()),
  hasSecret: z.boolean(),
  status: z.enum(['connected', 'error', 'unverified']),
  createdAt: z.string(),
});
export type ModelProviderConfig = z.infer<typeof ModelProviderConfig>;

export const AgentConfig = z.object({
  agent: z.string(),
  /** null = the hub's recommended provider. */
  providerId: z.uuid().nullable(),
  model: z.string(),
  fallback: z.boolean(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;
