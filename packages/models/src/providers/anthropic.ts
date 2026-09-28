import Anthropic from '@anthropic-ai/sdk';
import { ModelProviderError, ModelRefusalError, isRetryableStatus } from '../errors';
import type { GenerateRequest, GenerateResult, ModelProvider } from '../types';
import type { ModelProviderKind } from '@hub/shared';
import { assertPublicBaseUrl, validateBaseUrl, type LookupFn } from './base-url';
import { productionDefault } from './env';
import { baseClaudeModel } from './model-ids';

type RequestOpts = { timeout?: number; maxRetries?: number };

/** The slice of the SDK client we use; tests pass a mock. */
export type AnthropicClientLike = {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: RequestOpts,
    ): Promise<Anthropic.Message>;
  };
};

export const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Sampling parameters (`temperature`) were removed on Opus 4.7+, Opus 5.x, Sonnet 5 and
 * Fable; sending them returns a 400. Older models (Haiku 4.5, 4.6 family) accept them.
 */
export function acceptsSampling(model: string): boolean {
  return !/^claude-(opus-(4-[7-9]|5)|sonnet-5|fable|mythos)/.test(baseClaudeModel(model));
}

/** `output_config.effort` is supported on Opus 4.5+, Sonnet 4.6+, Fable; errors on Haiku 4.5. */
export function acceptsEffort(model: string): boolean {
  return /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(baseClaudeModel(model));
}

/**
 * Messages API request for `req`, sent as `wireModel` (the platform's id for the model).
 * Shared by the first-party, Bedrock and Vertex adapters: capability checks use the
 * first-party id behind any platform prefix.
 */
export function anthropicParams(
  req: GenerateRequest,
  wireModel: string = req.model,
): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: wireModel,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }
  if (req.temperature !== undefined && acceptsSampling(req.model)) {
    params.temperature = req.temperature;
  }
  if (req.effort && acceptsEffort(req.model)) {
    params.output_config = { effort: req.effort };
  }
  return params;
}

/** Maps a Messages API response; throws ModelRefusalError on `stop_reason: "refusal"`. */
export function anthropicResult(
  res: Anthropic.Message,
  req: GenerateRequest,
  provider: ModelProviderKind,
): GenerateResult {
  if (res.stop_reason === 'refusal') throw new ModelRefusalError();
  let text = '';
  const toolCalls: GenerateResult['toolCalls'] = [];
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ name: block.name, input: block.input });
  }
  const u = res.usage;
  return {
    text,
    toolCalls,
    usage: {
      inputTokens:
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
    },
    model: res.model || req.model,
    provider,
  };
}

export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
  private readonly client: AnthropicClientLike;
  private readonly baseURL: string | undefined;
  private readonly production: boolean;
  private readonly lookup: LookupFn | undefined;

  constructor(opts: {
    apiKey?: string;
    /** User-configured endpoint; validated here and before every call (see base-url.ts). */
    baseURL?: string;
    client?: AnthropicClientLike;
    production?: boolean;
    lookup?: LookupFn;
  }) {
    this.production = opts.production ?? productionDefault();
    this.lookup = opts.lookup;
    this.baseURL = opts.baseURL || undefined;
    if (this.baseURL) validateBaseUrl(this.baseURL, { production: this.production });
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey ?? null,
        // Never fall back to ANTHROPIC_AUTH_TOKEN from the server env: it could be sent to a
        // user-chosen base URL.
        authToken: null,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        // The router owns retries and backoff.
        maxRetries: 0,
      });
  }

  toParams(req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
    return anthropicParams(req);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (this.baseURL) {
      await assertPublicBaseUrl(this.baseURL, {
        production: this.production,
        ...(this.lookup ? { lookup: this.lookup } : {}),
      });
    }
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(this.toParams(req), {
        maxRetries: 0,
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      });
    } catch (err) {
      throw wrapAnthropicError(err);
    }
    return anthropicResult(res, req, 'anthropic');
  }
}

/**
 * Classifies SDK errors. Also used by the Bedrock and Vertex clients, which share the
 * `@anthropic-ai/sdk` error classes. Messages carry the label and status only.
 */
export function wrapAnthropicError(err: unknown, label = 'anthropic'): ModelProviderError {
  if (err instanceof ModelProviderError) return err;
  if (err instanceof Anthropic.APIConnectionError) {
    // Includes APIConnectionTimeoutError, and credential lookups (AWS chain, Google OAuth).
    return new ModelProviderError(`${label}: connection error`, { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new ModelProviderError(`${label}: HTTP ${err.status ?? '?'}`, {
      status: err.status,
      retryable: isRetryableStatus(err.status),
      cause: err,
    });
  }
  return new ModelProviderError(`${label}: request failed`, { retryable: false, cause: err });
}
