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
import { BedrockProvider, VertexProvider } from './unconfigured';
import { productionDefault } from './env';

export {
  AnthropicProvider,
  acceptsEffort,
  acceptsSampling,
  type AnthropicClientLike,
} from './anthropic';
export { OpenAICompatibleProvider, OPENAI_COMPATIBLE_KINDS, type OpenAIClientLike } from './openai';
export { FakeProvider } from './fake';
export { BedrockProvider, VertexProvider } from './unconfigured';
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
  /** Decrypted API key. Lives only for the duration of one call; never log it. */
  apiKey?: string;
  /** Non-secret config from `providers.config` (baseUrl, region, apiVersion, projectId). */
  config: Record<string, string>;
  /** Production rules (no fake kinds, https public baseUrl only). Default: NODE_ENV. */
  production?: boolean;
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
  if (kind === 'bedrock')
    return new BedrockProvider({ ...(config.region ? { region: config.region } : {}) });
  if (kind === 'vertex') return new VertexProvider();
  if (kind === 'fake') return new FakeProvider();
  throw new ModelConfigError(`unknown model provider ${String(kind)}`);
};
