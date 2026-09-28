import type { ModelProviderKind } from '@hub/shared';
import { ModelConfigError } from '../errors';
import type { ModelProvider } from '../types';
import { AnthropicProvider } from './anthropic';
import { FakeProvider } from './fake';
import {
  OPENAI_COMPATIBLE_KINDS,
  OpenAICompatibleProvider,
  type OpenAICompatibleKind,
} from './openai';
import { BedrockProvider } from './bedrock';
import { productionDefault } from './env';
import { VertexProvider } from './vertex';

export {
  AnthropicProvider,
  acceptsEffort,
  acceptsSampling,
  type AnthropicClientLike,
} from './anthropic';
export { OpenAICompatibleProvider, OPENAI_COMPATIBLE_KINDS, type OpenAIClientLike } from './openai';
export { FakeProvider } from './fake';
export {
  BedrockProvider,
  assertBedrockRegion,
  bedrockClientOptions,
  parseBedrockSecret,
  type BedrockCredentials,
  type BedrockOptions,
} from './bedrock';
export { VertexProvider, vertexBaseUrl, vertexClientOptions, type VertexOptions } from './vertex';
export { ServiceAccountAuth, parseServiceAccount, GOOGLE_TOKEN_URL } from './google-auth';
export { baseClaudeModel, bedrockModelId, vertexModelId } from './model-ids';
export {
  assertPublicBaseUrl,
  isBlockedAddress,
  validateBaseUrl,
  type BaseUrlPolicy,
  type LookupFn,
} from './base-url';
export { productionDefault } from './env';

/** Provider kinds that exist only for local demos and tests; refused in production. */
export const DEV_ONLY_PROVIDER_KINDS: readonly ModelProviderKind[] = ['fake'];

export type ProviderSpec = {
  kind: ModelProviderKind;
  /**
   * Decrypted provider secret: an API key, or for Bedrock/Vertex a JSON credential (AWS
   * keys / service account key). Lives only for the duration of one call; never log it.
   */
  apiKey?: string;
  /** Non-secret config from `providers.config` (baseUrl, region, apiVersion, projectId). */
  config: Record<string, string>;
  /** Production rules (no fake kinds, https public baseUrl only). Default: NODE_ENV. */
  production?: boolean;
  /**
   * Bedrock/Vertex without a secret: use the hub process's own cloud credentials (AWS
   * chain, Google ADC). That is the operator's identity, so default: outside production.
   */
  allowAmbientCredentials?: boolean;
};

/**
 * Model ids offered for providers of each kind, in addition to the ones a user types into
 * `config.models`. Claude on Bedrock uses `anthropic.`-prefixed ids; Vertex uses bare ids.
 */
export const PROVIDER_MODEL_SUGGESTIONS: Partial<
  Record<ModelProviderKind, { model: string; label: string }[]>
> = {
  bedrock: [
    { model: 'anthropic.claude-haiku-4-5', label: 'Claude Haiku 4.5 (Bedrock)' },
    { model: 'anthropic.claude-sonnet-5', label: 'Claude Sonnet 5 (Bedrock)' },
    { model: 'anthropic.claude-opus-5-5', label: 'Claude Opus 5.5 (Bedrock)' },
  ],
  vertex: [
    { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Vertex AI)' },
    { model: 'claude-sonnet-5', label: 'Claude Sonnet 5 (Vertex AI)' },
    { model: 'claude-opus-5-5', label: 'Claude Opus 5.5 (Vertex AI)' },
  ],
};

export type ProviderFactory = (spec: ProviderSpec) => ModelProvider;

/** Builds an adapter for a user-configured provider row. */
export const defaultProviderFactory: ProviderFactory = (spec) => {
  const { kind, apiKey, config } = spec;
  const production = spec.production ?? productionDefault();
  if (production && DEV_ONLY_PROVIDER_KINDS.includes(kind)) {
    throw new ModelConfigError(`model provider ${kind} is not allowed in production`);
  }
  if (kind === 'anthropic') {
    return new AnthropicProvider({
      ...(apiKey ? { apiKey } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      production,
    });
  }
  if ((OPENAI_COMPATIBLE_KINDS as string[]).includes(kind)) {
    return new OpenAICompatibleProvider({
      kind: kind as OpenAICompatibleKind,
      ...(apiKey ? { apiKey } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
      production,
    });
  }
  const allowAmbientCredentials = spec.allowAmbientCredentials ?? !production;
  if (kind === 'bedrock') {
    return new BedrockProvider({
      ...(config.region ? { region: config.region } : {}),
      ...(config.roleArn ? { roleArn: config.roleArn } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(apiKey ? { secret: apiKey } : {}),
      allowAmbientCredentials,
      production,
    });
  }
  if (kind === 'vertex') {
    return new VertexProvider({
      ...(config.region ? { region: config.region } : {}),
      ...(config.projectId ? { projectId: config.projectId } : {}),
      ...(apiKey ? { secret: apiKey } : {}),
      allowAmbientCredentials,
      production,
    });
  }
  if (kind === 'fake') return new FakeProvider();
  throw new ModelConfigError(`unknown model provider ${String(kind)}`);
};
