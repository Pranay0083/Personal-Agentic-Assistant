import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { ModelConfigError } from './errors';
import { AnthropicProvider, type AnthropicClientLike } from './providers/anthropic';
import {
  assertPublicBaseUrl,
  isBlockedAddress,
  validateBaseUrl,
  type LookupFn,
} from './providers/base-url';
import { OpenAICompatibleProvider, type OpenAIClientLike } from './providers/openai';

const dev = { production: false };
const prod = { production: true };
const resolvesTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('validateBaseUrl', () => {
  it('accepts https everywhere', () => {
    expect(validateBaseUrl('https://api.groq.com/openai/v1', prod).hostname).toBe('api.groq.com');
    expect(validateBaseUrl('https://gw.example.com/v1', dev).hostname).toBe('gw.example.com');
  });

  it('allows http only for localhost, and only outside production', () => {
    expect(() => validateBaseUrl('http://localhost:11434/v1', dev)).not.toThrow();
    expect(() => validateBaseUrl('http://127.0.0.1:8080/v1', dev)).not.toThrow();
    expect(() => validateBaseUrl('http://[::1]:8080/v1', dev)).not.toThrow();
    expect(() => validateBaseUrl('http://gw.example.com/v1', dev)).toThrow(ModelConfigError);
    expect(() => validateBaseUrl('http://localhost:11434/v1', prod)).toThrow(/https/);
    expect(() => validateBaseUrl('http://api.example.com/v1', prod)).toThrow(/https/);
  });

  it.each(['file:///etc/passwd', 'ftp://x.example.com', 'gopher://x', 'not a url', ''])(
    'rejects %s',
    (url) => {
      expect(() => validateBaseUrl(url, dev)).toThrow(ModelConfigError);
    },
  );

  it('rejects credentials in the URL', () => {
    expect(() => validateBaseUrl('https://user:pw@gw.example.com/v1', dev)).toThrow(/credentials/);
  });

  it.each([
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.1.2.3/v1',
    'https://169.254.169.254/latest',
    'https://192.168.1.10/v1',
    'https://172.20.0.1/v1',
    'https://[::1]/v1',
    'https://[fd00::1]/v1',
    'https://[::ffff:10.0.0.1]/v1',
    'https://printer.local/v1',
  ])('in production rejects the private host %s', (url) => {
    expect(() => validateBaseUrl(url, prod)).toThrow(/public host/);
  });
});

describe('isBlockedAddress', () => {
  it.each([
    ['10.0.0.1', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['100.64.1.1', true],
    ['172.31.255.255', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['::ffff:127.0.0.1', true],
    ['8.8.8.8', false],
    ['172.32.0.1', false],
    ['2606:4700::1111', false],
    ['not-an-ip', true],
  ])('%s → %s', (addr, blocked) => {
    expect(isBlockedAddress(addr)).toBe(blocked);
  });
});

describe('assertPublicBaseUrl (call time)', () => {
  it('does not resolve outside production', async () => {
    const lookup = vi.fn(resolvesTo('10.0.0.1'));
    await expect(
      assertPublicBaseUrl('https://gw.example.com/v1', { ...dev, lookup }),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('in production refuses hosts that resolve to private, loopback or link-local ranges', async () => {
    for (const addr of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fe80::1']) {
      await expect(
        assertPublicBaseUrl('https://gw.example.com/v1', { ...prod, lookup: resolvesTo(addr) }),
      ).rejects.toThrow(/private or reserved/);
    }
    // One bad address among good ones is enough to refuse.
    await expect(
      assertPublicBaseUrl('https://gw.example.com/v1', {
        ...prod,
        lookup: resolvesTo('93.184.216.34', '10.0.0.5'),
      }),
    ).rejects.toThrow(/private or reserved/);
    await expect(
      assertPublicBaseUrl('https://gw.example.com/v1', {
        ...prod,
        lookup: resolvesTo('93.184.216.34'),
      }),
    ).resolves.toBeUndefined();
  });

  it('in production refuses hosts that do not resolve', async () => {
    const lookup: LookupFn = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    await expect(
      assertPublicBaseUrl('https://nope.example.com/v1', { ...prod, lookup }),
    ).rejects.toThrow(/does not resolve/);
  });
});

describe('adapters check the baseUrl', () => {
  const openaiClient = (): OpenAIClientLike & { calls: number } => {
    const c = {
      calls: 0,
      chat: {
        completions: {
          create: async () => {
            c.calls++;
            return {
              id: 'x',
              object: 'chat.completion',
              created: 0,
              model: 'm',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  logprobs: null,
                  message: { role: 'assistant', content: 'hi', refusal: null },
                },
              ],
            } as unknown as OpenAI.Chat.ChatCompletion;
          },
        },
      },
    };
    return c;
  };
  const req = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'x' }] };

  it('refuses an http baseUrl at construction', () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          kind: 'openai_compatible',
          baseURL: 'http://internal.example.com/v1',
          production: false,
        }),
    ).toThrow(ModelConfigError);
    expect(
      () => new AnthropicProvider({ baseURL: 'http://10.0.0.1/v1', production: true }),
    ).toThrow(ModelConfigError);
  });

  it('in production resolves before every call and never sends to a private address', async () => {
    const client = openaiClient();
    let answer = '93.184.216.34';
    const p = new OpenAICompatibleProvider({
      kind: 'openai_compatible',
      baseURL: 'https://gw.example.com/v1',
      client,
      production: true,
      lookup: async () => [{ address: answer, family: 4 }],
    });
    expect((await p.generate(req)).text).toBe('hi');
    // DNS rebinding after the provider was added: the next call is refused.
    answer = '169.254.169.254';
    await expect(p.generate(req)).rejects.toThrow(ModelConfigError);
    expect(client.calls).toBe(1);
  });

  it('the default ollama localhost URL is refused in production', () => {
    expect(() => new OpenAICompatibleProvider({ kind: 'ollama', production: true })).toThrow(
      /https/,
    );
    expect(() => new OpenAICompatibleProvider({ kind: 'ollama', production: false })).not.toThrow();
  });

  it('the Anthropic adapter checks too', async () => {
    const create = vi.fn();
    const p = new AnthropicProvider({
      baseURL: 'https://gw.example.com',
      client: { messages: { create } } as unknown as AnthropicClientLike,
      production: true,
      lookup: resolvesTo('192.168.0.10'),
    });
    await expect(p.generate(req)).rejects.toThrow(/private or reserved/);
    expect(create).not.toHaveBeenCalled();
  });
});
