import type { ModelProviderKind } from '@hub/shared';
import { baseClaudeModel } from './providers/model-ids';
import type { Usage } from './types';

/** USD per 1M tokens. First-party list prices; unknown models cost 0 (logged as such). */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/**
 * Strip provider prefixes and versions (`anthropic/claude-sonnet-5`, `us.anthropic.claude-…`,
 * `claude-…@20251101`, `openai/gpt-4.1`). Bedrock and Vertex bill at partner rates; the
 * first-party list price is used as the estimate.
 */
function baseModel(model: string): string {
  return baseClaudeModel(model).replace(/^openai\//, '');
}

export function priceFor(model: string): { input: number; output: number } | undefined {
  return PRICES[baseModel(model)];
}

/** Cost of one call. The offline fake provider is free. */
export function costUsd(provider: ModelProviderKind, model: string, usage: Usage): number {
  if (provider === 'fake' || provider === 'ollama') return 0;
  const p = priceFor(model);
  if (!p) return 0;
  const cost = (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
