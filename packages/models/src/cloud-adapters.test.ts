import { createVerify, generateKeyPairSync } from 'node:crypto';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ModelConfigError, ModelProviderError, ModelRefusalError } from './errors';
import { costUsd } from './prices';
import type { AnthropicClientLike } from './providers/anthropic';
import { BedrockProvider, bedrockClientOptions, parseBedrockSecret } from './providers/bedrock';
import { GOOGLE_TOKEN_URL, ServiceAccountAuth, parseServiceAccount } from './providers/google-auth';
import { baseClaudeModel, bedrockModelId, vertexModelId } from './providers/model-ids';
import { VertexProvider, vertexClientOptions } from './providers/vertex';

const KEYS = JSON.stringify({
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG',
});

function message(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'anthropic.claude-sonnet-5',
    content: [{ type: 'text', text: '{"ok":true}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100 },
    ...over,
  } as Anthropic.Message;
}

const mockClient = (impl: () => Promise<Anthropic.Message>) => {
  const create = vi.fn(impl);
  return { create, client: { messages: { create } } as unknown as AnthropicClientLike };
};

const req = (model: string) => ({
  model,
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  temperature: 0,
  effort: 'low' as const,
  timeoutMs: 5000,
});

describe('model ids', () => {
  it('maps first-party ids per platform and keeps platform ids', () => {
    expect(bedrockModelId('claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
    expect(bedrockModelId('us.anthropic.claude-haiku-4-5')).toBe('us.anthropic.claude-haiku-4-5');
    expect(bedrockModelId('anthropic.claude-sonnet-5')).toBe('anthropic.claude-sonnet-5');
    expect(vertexModelId('anthropic.claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(vertexModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5@20251101');
    expect(baseClaudeModel('global.anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(baseClaudeModel('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
  });

  it('refuses ids that could change the request path', () => {
    expect(() => vertexModelId('../../projects/x/models/y')).toThrow(ModelConfigError);
    expect(() => vertexModelId('claude-sonnet-5/../x')).toThrow(ModelConfigError);
    expect(() => bedrockModelId('claude sonnet')).toThrow(ModelConfigError);
  });

  it('prices platform ids like the first-party model', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(costUsd('bedrock', 'us.anthropic.claude-haiku-4-5', usage)).toBe(1);
    expect(costUsd('vertex', 'claude-sonnet-5@20260101', usage)).toBe(2);
  });
});

describe('BedrockProvider', () => {
  it('sends the Bedrock model id and keeps the capability rules of the base model', async () => {
    const { create, client } = mockClient(async () => message());
    const p = new BedrockProvider({ region: 'us-east-1', secret: KEYS, client, production: true });
    const res = await p.generate(req('claude-sonnet-5'));
    const [params, opts] = create.mock.calls[0] as unknown as [
      Anthropic.MessageCreateParamsNonStreaming,
      unknown,
    ];
    expect(params.model).toBe('anthropic.claude-sonnet-5');
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params).not.toHaveProperty('temperature'); // Sonnet 5 rejects sampling params
    expect(opts).toEqual({ maxRetries: 0, timeout: 5000 });
    expect(res).toMatchObject({
      provider: 'bedrock',
      model: 'anthropic.claude-sonnet-5',
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
    expect(costUsd(res.provider, res.model, res.usage)).toBeCloseTo(0.003, 6);

    await p.generate(req('us.anthropic.claude-haiku-4-5'));
    const [haiku] = create.mock.calls[1] as unknown as [Anthropic.MessageCreateParamsNonStreaming];
    expect(haiku.model).toBe('us.anthropic.claude-haiku-4-5');
    expect(haiku.temperature).toBe(0);
    expect(haiku.output_config).toBeUndefined();
  });

  it('builds explicit SDK options from the secret (never the hub env)', () => {
    expect(bedrockClientOptions({ region: 'eu-west-1', secret: KEYS, production: true })).toEqual({
      awsRegion: 'eu-west-1',
      baseURL: 'https://bedrock-mantle.eu-west-1.api.aws/anthropic',
      maxRetries: 0,
      awsAccessKey: 'AKIDEXAMPLE',
      awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG',
      awsSessionToken: null,
    });
    const temp = JSON.stringify({ accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'C' });
    expect(
      bedrockClientOptions({ region: 'us-east-1', secret: temp, production: true }),
    ).toMatchObject({ awsSessionToken: 'C' });
    expect(
      bedrockClientOptions({
        region: 'us-east-1',
        secret: JSON.stringify({ apiKey: 'bedrock-api-key' }),
        production: true,
      }),
    ).toMatchObject({ apiKey: 'bedrock-api-key' });
  });

  it('sends ambient (server) credentials only to the AWS endpoint, never a user base URL', () => {
    const o = bedrockClientOptions({
      region: 'us-east-1',
      production: false,
      baseURL: 'https://attacker.example/anthropic',
    });
    expect(o.baseURL).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic');
    // With explicit user credentials, the user's own base URL is still honoured.
    const own = bedrockClientOptions({
      region: 'us-east-1',
      production: false,
      baseURL: 'https://gateway.example/anthropic',
      secret: JSON.stringify({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'x' }),
    });
    expect(own.baseURL).toBe('https://gateway.example/anthropic');
  });

  it('uses the default AWS chain only when ambient credentials are allowed', () => {
    expect(() => bedrockClientOptions({ region: 'us-east-1', production: true })).toThrow(
      /add AWS access keys/,
    );
    expect(() =>
      bedrockClientOptions({
        region: 'us-east-1',
        production: false,
        allowAmbientCredentials: false,
      }),
    ).toThrow(ModelConfigError);
    const ambient = bedrockClientOptions({ region: 'us-east-1', production: false });
    expect(ambient).not.toHaveProperty('awsAccessKey');
    expect(ambient).not.toHaveProperty('apiKey');
  });

  it('refuses bad config without echoing secrets', () => {
    expect(() => bedrockClientOptions({ secret: KEYS, production: true })).toThrow(
      /region is required/,
    );
    for (const region of ['us-east-1.evil.com', 'us-east-1/x', '169.254.169.254', 'US-EAST-1']) {
      expect(() => bedrockClientOptions({ region, secret: KEYS, production: true })).toThrow(
        /invalid region/,
      );
    }
    expect(() =>
      bedrockClientOptions({
        region: 'us-east-1',
        secret: KEYS,
        roleArn: 'arn:aws:iam::123456789012:role/hub',
        production: true,
      }),
    ).toThrow(/roleArn/);
    const bad = 'AKIA-not-json-super-secret';
    const err = (() => {
      try {
        parseBedrockSecret(bad);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ModelConfigError);
    expect(err!.message).not.toContain(bad);
    expect(() => parseBedrockSecret(JSON.stringify({ accessKeyId: 'only-half' }))).toThrow(
      ModelConfigError,
    );
    expect(() =>
      bedrockClientOptions({
        region: 'us-east-1',
        secret: KEYS,
        baseURL: 'http://169.254.169.254/latest',
        production: true,
      }),
    ).toThrow(/https/);
  });

  it('classifies errors and refusals', async () => {
    const rate = new Anthropic.RateLimitError(429, { error: {} }, 'rate', new Headers());
    const e = await new BedrockProvider({
      region: 'us-east-1',
      secret: KEYS,
      client: mockClient(async () => {
        throw rate;
      }).client,
    })
      .generate(req('claude-haiku-4-5'))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelProviderError);
    expect((e as ModelProviderError).message).toBe('bedrock: HTTP 429');
    expect((e as ModelProviderError).retryable).toBe(true);

    const conn = new Anthropic.APIConnectionError({ message: 'no creds' });
    const c = await new BedrockProvider({
      region: 'us-east-1',
      secret: KEYS,
      client: mockClient(async () => {
        throw conn;
      }).client,
    })
      .generate(req('claude-haiku-4-5'))
      .catch((x: unknown) => x);
    expect((c as ModelProviderError).retryable).toBe(true);

    await expect(
      new BedrockProvider({
        region: 'us-east-1',
        secret: KEYS,
        client: mockClient(async () => message({ stop_reason: 'refusal', content: [] })).client,
      }).generate(req('claude-sonnet-5')),
    ).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it('signs a Mantle request with the stored keys (real SDK, mocked fetch)', async () => {
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(JSON.stringify(message()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const sdk = new AnthropicBedrockMantle({
      ...bedrockClientOptions({ region: 'us-west-2', secret: KEYS, production: true }),
      fetch,
    });
    const p = new BedrockProvider({
      region: 'us-west-2',
      secret: KEYS,
      client: sdk as unknown as AnthropicClientLike,
      production: false,
    });
    const res = await p.generate(req('claude-opus-5-5'));
    expect(res.text).toBe('{"ok":true}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages');
    expect(calls[0]!.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock-mantle\/aws4_request/,
    );
    expect(calls[0]!.headers.get('x-api-key')).toBeNull();
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: 'anthropic.claude-opus-5-5' });
  });
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({
  type: 'service_account',
  project_id: 'acme-prod',
  client_email: 'hub@acme-prod.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://evil.example.com/token',
});

function tokenFetch(token = 'ya29.test', expiresIn = 3600) {
  const calls: { url: string; body: string }[] = [];
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: token, expires_in: expiresIn }),
    };
  });
  return { fn, calls };
}

describe('Google service account auth', () => {
  it('exchanges a signed RS256 assertion at the fixed Google endpoint and caches it', async () => {
    const { fn, calls } = tokenFetch();
    let now = 1_800_000_000_000;
    const auth = new ServiceAccountAuth(parseServiceAccount(SA), { fetch: fn, now: () => now });
    expect(auth.projectId).toBe('acme-prod');
    const h = await auth.getRequestHeaders();
    expect(h.get('authorization')).toBe('Bearer ya29.test');
    expect(calls[0]!.url).toBe(GOOGLE_TOKEN_URL); // token_uri in the key is ignored
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [head, claims, sig] = form.get('assertion')!.split('.') as [string, string, string];
    const v = createVerify('RSA-SHA256');
    v.update(`${head}.${claims}`);
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: 'hub@acme-prod.iam.gserviceaccount.com',
      aud: GOOGLE_TOKEN_URL,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });

    await auth.getRequestHeaders();
    expect(fn).toHaveBeenCalledTimes(1);
    now += 3_550_000; // within a minute of expiry: refresh
    await auth.getRequestHeaders();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reports the OAuth error code only', async () => {
    const auth = new ServiceAccountAuth(parseServiceAccount(SA), {
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'secret detail' }),
      }),
    });
    const e = (await auth.accessToken().catch((x: unknown) => x)) as ModelProviderError;
    expect(e).toBeInstanceOf(ModelProviderError);
    expect(e.message).toBe('vertex: token request refused (invalid_grant)');
    expect(e.retryable).toBe(false);
  });

  it('accepts only service account keys', () => {
    expect(() => parseServiceAccount('not json')).toThrow(ModelConfigError);
    expect(() =>
      parseServiceAccount(
        JSON.stringify({ type: 'external_account', credential_source: { url: 'http://x' } }),
      ),
    ).toThrow(/only service account/);
    expect(() =>
      parseServiceAccount(
        JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'nope' }),
      ),
    ).toThrow(/private_key/);
  });
});

describe('VertexProvider', () => {
  it('sends the bare model id', async () => {
    const { create, client } = mockClient(async () => message({ model: 'claude-sonnet-5' }));
    const p = new VertexProvider({
      projectId: 'acme-prod',
      region: 'us-east5',
      secret: SA,
      client,
      production: true,
    });
    const res = await p.generate(req('anthropic.claude-sonnet-5'));
    const [params] = create.mock.calls[0] as unknown as [Anthropic.MessageCreateParamsNonStreaming];
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(res).toMatchObject({ provider: 'vertex', model: 'claude-sonnet-5' });
  });

  it('validates region and project, and takes the project from the key', () => {
    expect(vertexClientOptions({ region: 'global', secret: SA, production: true })).toMatchObject({
      region: 'global',
      projectId: 'acme-prod',
      baseURL: 'https://aiplatform.googleapis.com/v1',
    });
    expect(
      vertexClientOptions({ region: 'eu', projectId: 'other-proj', secret: SA, production: true }),
    ).toMatchObject({
      projectId: 'other-proj',
      baseURL: 'https://aiplatform.eu.rep.googleapis.com/v1',
    });
    expect(() => vertexClientOptions({ secret: SA, production: true })).toThrow(/region/);
    for (const region of ['us-east5.evil.com', 'us-east5/x', 'x']) {
      expect(() => vertexClientOptions({ region, secret: SA, production: true })).toThrow(
        /invalid region/,
      );
    }
    expect(() =>
      vertexClientOptions({
        region: 'us-east5',
        projectId: 'acme/../../x',
        secret: SA,
        production: true,
      }),
    ).toThrow(/invalid projectId/);
    expect(() =>
      vertexClientOptions({ region: 'us-east5', projectId: 'acme-prod', production: true }),
    ).toThrow(/service account key/);
    expect(
      vertexClientOptions({ region: 'us-east5', projectId: 'acme-prod', production: false }),
    ).not.toHaveProperty('authClient');
  });

  it('calls rawPredict with a service-account token (real SDK, mocked fetch)', async () => {
    const tokens = tokenFetch('ya29.vertex');
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(JSON.stringify(message({ model: 'claude-opus-5-5' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const sdk = new AnthropicVertex({
      ...vertexClientOptions({
        region: 'us-east5',
        secret: SA,
        production: true,
        fetch: tokens.fn,
      }),
      fetch,
    });
    const p = new VertexProvider({
      projectId: 'acme-prod',
      region: 'us-east5',
      secret: SA,
      client: sdk as unknown as AnthropicClientLike,
    });
    const res = await p.generate(req('claude-opus-5-5'));
    expect(res.provider).toBe('vertex');
    expect(calls[0]!.url).toBe(
      'https://us-east5-aiplatform.googleapis.com/v1/projects/acme-prod/locations/us-east5/publishers/anthropic/models/claude-opus-5-5:rawPredict',
    );
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer ya29.vertex');
    expect(calls[0]!.headers.get('x-api-key')).toBeNull();
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ anthropic_version: 'vertex-2023-10-16' });
  });
});
