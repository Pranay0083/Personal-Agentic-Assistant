import OpenAI from 'openai';
import type { ModelProviderKind } from '@hub/shared';
import { ModelConfigError, ModelProviderError, isRetryableStatus } from '../errors';
import type { GenerateRequest, GenerateResult, ModelProvider } from '../types';
import { DEFAULT_MAX_TOKENS } from './anthropic';

type RequestOpts = { timeout?: number; maxRetries?: number };

export type OpenAIClientLike = {
  chat: {
    completions: {
      create(
        body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?: RequestOpts,
      ): Promise<OpenAI.Chat.ChatCompletion>;
    };
  };
};

export type OpenAICompatibleKind = Extract<
  ModelProviderKind,
  'openai' | 'groq' | 'openrouter' | 'azure' | 'openai_compatible' | 'ollama'
>;

export const OPENAI_COMPATIBLE_KINDS: OpenAICompatibleKind[] = [
  'openai',
  'groq',
  'openrouter',
  'azure',
  'openai_compatible',
  'ollama',
];

const DEFAULT_BASE_URLS: Partial<Record<OpenAICompatibleKind, string>> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};

export type OpenAICompatibleOptions = {
  kind: OpenAICompatibleKind;
  apiKey?: string;
  /** Required for azure (…/openai/v1) and openai_compatible. */
  baseURL?: string;
  /** Azure: optional api-version query parameter. */
  apiVersion?: string;
  client?: OpenAIClientLike;
};

/**
 * One adapter over the `openai` SDK for every Chat Completions-compatible endpoint:
 * OpenAI, Groq, OpenRouter, Azure OpenAI, and custom gateways via base URL.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind: OpenAICompatibleKind;
  private readonly client: OpenAIClientLike;

  constructor(opts: OpenAICompatibleOptions) {
    this.kind = opts.kind;
    if (opts.client) {
      this.client = opts.client;
      return;
    }
    const baseURL = opts.baseURL || DEFAULT_BASE_URLS[opts.kind];
    if ((opts.kind === 'azure' || opts.kind === 'openai_compatible') && !baseURL) {
      throw new ModelConfigError(`${opts.kind} provider needs a baseUrl`);
    }
    this.client = new OpenAI({
      apiKey: opts.apiKey || (opts.kind === 'ollama' ? 'ollama' : null),
      ...(baseURL ? { baseURL } : {}),
      ...(opts.kind === 'azure' && opts.apiKey
        ? { defaultHeaders: { 'api-key': opts.apiKey } }
        : {}),
      ...(opts.apiVersion ? { defaultQuery: { 'api-version': opts.apiVersion } } : {}),
      maxRetries: 0,
    });
  }

  toParams(req: GenerateRequest): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    // OpenAI's own API (and Azure) want max_completion_tokens; most gateways still read max_tokens.
    if (this.kind === 'openai' || this.kind === 'azure') params.max_completion_tokens = maxTokens;
    else params.max_tokens = maxTokens;
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    if (req.json && !req.tools?.length) params.response_format = { type: 'json_object' };
    return params;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let res: OpenAI.Chat.ChatCompletion;
    try {
      res = await this.client.chat.completions.create(this.toParams(req), {
        maxRetries: 0,
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      });
    } catch (err) {
      throw wrapOpenAIError(this.kind, err);
    }
    const choice = res.choices[0];
    if (!choice) throw new ModelProviderError(`${this.kind}: empty response`, { retryable: true });
    const toolCalls: GenerateResult['toolCalls'] = [];
    for (const call of choice.message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      let input: unknown = call.function.arguments;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        // keep the raw string; callers validate tool input anyway
      }
      toolCalls.push({ name: call.function.name, input });
    }
    return {
      text: choice.message.content ?? '',
      toolCalls,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
      model: res.model || req.model,
      provider: this.kind,
    };
  }
}

export function wrapOpenAIError(kind: string, err: unknown): ModelProviderError {
  if (err instanceof OpenAI.APIConnectionError) {
    return new ModelProviderError(`${kind}: connection error`, { retryable: true, cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    return new ModelProviderError(`${kind}: HTTP ${err.status ?? '?'}`, {
      status: err.status,
      retryable: isRetryableStatus(err.status),
      cause: err,
    });
  }
  if (err instanceof ModelProviderError) return err;
  return new ModelProviderError(`${kind}: request failed`, { retryable: false, cause: err });
}
