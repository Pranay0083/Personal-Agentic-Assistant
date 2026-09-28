import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { ModelConfigError, ModelProviderError, ModelRefusalError } from './errors';
import { AnthropicProvider, type AnthropicClientLike } from './providers/anthropic';
import { BedrockProvider, VertexProvider, defaultProviderFactory } from './providers/index';
import { OpenAICompatibleProvider, type OpenAIClientLike } from './providers/openai';

const tool = {
  name: 'lookup',
  description: 'Look something up',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

function anthropicMessage(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [
      { type: 'text', text: 'Hello', citations: null },
      { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'deck' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 10,
    },
    ...over,
  } as Anthropic.Message;
}

describe('AnthropicProvider', () => {
  it('maps requests and responses', async () => {
    const create = vi.fn(async () => anthropicMessage());
    const p = new AnthropicProvider({ client: { messages: { create } } as AnthropicClientLike });
    const res = await p.generate({
      model: 'claude-sonnet-5',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      maxTokens: 1000,
      temperature: 0.2,
      effort: 'low',
      timeoutMs: 5000,
    });
    const [params, opts] = create.mock.calls[0] as unknown as [
      Anthropic.MessageCreateParamsNonStreaming,
      { timeout: number; maxRetries: number },
    ];
    expect(params).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: 'Look something up', input_schema: tool.inputSchema }],
      output_config: { effort: 'low' },
    });
    // Sonnet 5 rejects sampling params, so temperature is dropped.
    expect(params).not.toHaveProperty('temperature');
    expect(opts).toEqual({ maxRetries: 0, timeout: 5000 });
    expect(res).toEqual({
      text: 'Hello',
      toolCalls: [{ name: 'lookup', input: { q: 'deck' } }],
      usage: { inputTokens: 115, outputTokens: 20 },
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });
  });

  it('keeps temperature and omits effort on Haiku 4.5', async () => {
    const create = vi.fn(async () => anthropicMessage({ model: 'claude-haiku-4-5' }));
    const p = new AnthropicProvider({ client: { messages: { create } } as AnthropicClientLike });
    await p.generate({
      model: 'claude-haiku-4-5',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      effort: 'low',
    });
    const [params] = create.mock.calls[0] as unknown as [Anthropic.MessageCreateParamsNonStreaming];
    expect(params.temperature).toBe(0);
    expect(params.output_config).toBeUndefined();
    expect(params.max_tokens).toBe(16_000);
  });

  it('throws a refusal error on stop_reason refusal', async () => {
    const create = vi.fn(async () => anthropicMessage({ stop_reason: 'refusal', content: [] }));
    const p = new AnthropicProvider({ client: { messages: { create } } as AnthropicClientLike });
    await expect(
      p.generate({
        model: 'claude-sonnet-5',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it('classifies SDK errors as retryable or not', async () => {
    const rate = new Anthropic.RateLimitError(429, { error: {} }, 'rate', new Headers());
    const bad = new Anthropic.BadRequestError(400, { error: {} }, 'bad', new Headers());
    const conn = new Anthropic.APIConnectionError({ message: 'down' });
    for (const [err, retryable] of [
      [rate, true],
      [bad, false],
      [conn, true],
    ] as const) {
      const create = vi.fn(async () => {
        throw err;
      });
      const p = new AnthropicProvider({ client: { messages: { create } } as AnthropicClientLike });
      const e = await p
        .generate({
          model: 'claude-haiku-4-5',
          system: '',
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ModelProviderError);
      expect((e as ModelProviderError).retryable).toBe(retryable);
    }
  });
});

function completion(over: Partial<OpenAI.Chat.ChatCompletion> = {}): OpenAI.Chat.ChatCompletion {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'llama-3.3-70b',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: 'Hi',
          refusal: null,
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":"deck"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 },
    ...over,
  } as OpenAI.Chat.ChatCompletion;
}

describe('OpenAICompatibleProvider', () => {
  it('maps requests and responses (groq uses max_tokens)', async () => {
    const create = vi.fn(async () => completion());
    const p = new OpenAICompatibleProvider({
      kind: 'groq',
      client: { chat: { completions: { create } } } as OpenAIClientLike,
    });
    const res = await p.generate({
      model: 'llama-3.3-70b',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      maxTokens: 300,
      temperature: 0.1,
      timeoutMs: 1000,
    });
    const [body, opts] = create.mock.calls[0] as unknown as [
      OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      unknown,
    ];
    expect(body).toEqual({
      model: 'llama-3.3-70b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 300,
      temperature: 0.1,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look something up',
            parameters: tool.inputSchema,
          },
        },
      ],
    });
    expect(opts).toEqual({ maxRetries: 0, timeout: 1000 });
    expect(res).toEqual({
      text: 'Hi',
      toolCalls: [{ name: 'lookup', input: { q: 'deck' } }],
      usage: { inputTokens: 50, outputTokens: 7 },
      model: 'llama-3.3-70b',
      provider: 'groq',
    });
  });

  it('uses max_completion_tokens and json mode for openai', async () => {
    const create = vi.fn(async () => completion());
    const p = new OpenAICompatibleProvider({
      kind: 'openai',
      client: { chat: { completions: { create } } } as OpenAIClientLike,
    });
    await p.generate({
      model: 'gpt-4.1',
      system: 's',
      messages: [{ role: 'user', content: 'json' }],
      json: true,
    });
    const [body] = create.mock.calls[0] as unknown as [
      OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    ];
    expect(body.max_completion_tokens).toBe(16_000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('classifies SDK errors', async () => {
    const err = new OpenAI.InternalServerError(503, { error: {} }, 'down', new Headers());
    const create = vi.fn(async () => {
      throw err;
    });
    const p = new OpenAICompatibleProvider({
      kind: 'openrouter',
      client: { chat: { completions: { create } } } as OpenAIClientLike,
    });
    const e = await p
      .generate({ model: 'm', system: '', messages: [{ role: 'user', content: 'x' }] })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelProviderError);
    expect((e as ModelProviderError).retryable).toBe(true);
    expect((e as ModelProviderError).status).toBe(503);
  });

  it('requires a base URL for azure and custom gateways', () => {
    expect(() => new OpenAICompatibleProvider({ kind: 'openai_compatible', apiKey: 'k' })).toThrow(
      ModelConfigError,
    );
    expect(
      () =>
        new OpenAICompatibleProvider({
          kind: 'openai_compatible',
          apiKey: 'k',
          baseURL: 'https://gw/v1',
        }),
    ).not.toThrow();
  });
});

describe('Phase 5 placeholders', () => {
  it('bedrock and vertex fail clearly', async () => {
    const req = { model: 'x', system: '', messages: [] };
    await expect(new BedrockProvider().generate(req)).rejects.toThrow(
      /not configured yet \(Phase 5\)/,
    );
    await expect(new VertexProvider().generate(req)).rejects.toThrow(
      /not configured yet \(Phase 5\)/,
    );
  });

  it('factory builds the right adapter per kind', () => {
    expect(defaultProviderFactory({ kind: 'anthropic', apiKey: 'k', config: {} }).kind).toBe(
      'anthropic',
    );
    expect(defaultProviderFactory({ kind: 'groq', apiKey: 'k', config: {} }).kind).toBe('groq');
    expect(defaultProviderFactory({ kind: 'bedrock', config: {} }).kind).toBe('bedrock');
    expect(defaultProviderFactory({ kind: 'fake', config: {} }).kind).toBe('fake');
  });

  it('refuses dev-only provider kinds in production', () => {
    expect(() => defaultProviderFactory({ kind: 'fake', config: {}, production: true })).toThrow(
      /not allowed in production/,
    );
    expect(
      defaultProviderFactory({ kind: 'groq', apiKey: 'k', config: {}, production: true }).kind,
    ).toBe('groq');
  });
});
