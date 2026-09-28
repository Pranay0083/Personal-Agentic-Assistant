import { AnthropicBedrockMantle, type BedrockMantleClientOptions } from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { ModelConfigError } from '../errors';
import type { GenerateRequest, GenerateResult, ModelProvider } from '../types';
import {
  anthropicParams,
  anthropicResult,
  wrapAnthropicError,
  type AnthropicClientLike,
} from './anthropic';
import { assertPublicBaseUrl, validateBaseUrl, type LookupFn } from './base-url';
import { productionDefault } from './env';
import { bedrockModelId } from './model-ids';

/**
 * Claude in Amazon Bedrock, through the Mantle (Messages API) endpoint:
 * `https://bedrock-mantle.<region>.api.aws/anthropic`, model ids `anthropic.claude-…`.
 *
 * Credentials, from the provider secret (a JSON string):
 * - `{ "accessKeyId", "secretAccessKey", "sessionToken"? }` → SigV4 with those keys
 * - `{ "apiKey" }` → a Bedrock API key (bearer token)
 * - no secret → the default AWS credential chain of the hub's own process (env, profile,
 *   instance or task role). That is the operator's identity, so it is only used when
 *   `allowAmbientCredentials` is set (default: outside production).
 */

export type BedrockCredentials =
  { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | { apiKey: string };

// Region names end up in the endpoint host: allow only the AWS shape (us-east-1, us-gov-west-1).
const REGION = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;

export function assertBedrockRegion(region: string | undefined): string {
  const r = region?.trim() ?? '';
  if (!r) throw new ModelConfigError('bedrock: region is required');
  if (!REGION.test(r)) throw new ModelConfigError('bedrock: invalid region');
  return r;
}

/** Parses the provider secret. Errors never echo the value. */
export function parseBedrockSecret(raw: string): BedrockCredentials {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ModelConfigError(
      'bedrock: secret must be JSON {"accessKeyId","secretAccessKey","sessionToken"?} or {"apiKey"}',
    );
  }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : undefined);
  const accessKeyId = str('accessKeyId');
  const secretAccessKey = str('secretAccessKey');
  const sessionToken = str('sessionToken');
  const apiKey = str('apiKey');
  if (accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }
  if (apiKey) return { apiKey };
  throw new ModelConfigError(
    'bedrock: secret needs accessKeyId and secretAccessKey (or a Bedrock apiKey)',
  );
}

export type BedrockOptions = {
  region?: string;
  /** Decrypted provider secret (JSON); see parseBedrockSecret. */
  secret?: string;
  /** Not supported yet; refused rather than silently ignored. */
  roleArn?: string;
  /** Override for the Mantle endpoint (e.g. a VPC endpoint). Validated like other base URLs. */
  baseURL?: string;
  /** Use the hub's own AWS credential chain when there is no secret. Default: !production. */
  allowAmbientCredentials?: boolean;
  client?: AnthropicClientLike;
  production?: boolean;
  lookup?: LookupFn;
};

/**
 * Options for the SDK client. Explicit region, base URL and credentials, so the hub's own
 * env (`AWS_REGION`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`)
 * never leaks into a user's provider when the user supplied credentials.
 */
export function bedrockClientOptions(
  opts: Pick<
    BedrockOptions,
    'region' | 'secret' | 'roleArn' | 'baseURL' | 'allowAmbientCredentials'
  > & {
    production: boolean;
  },
): BedrockMantleClientOptions {
  const region = assertBedrockRegion(opts.region);
  if (opts.roleArn?.trim()) {
    throw new ModelConfigError(
      'bedrock: assuming an IAM role (roleArn) is not supported yet; add access keys as the secret',
    );
  }
  const baseURL = opts.baseURL || `https://bedrock-mantle.${region}.api.aws/anthropic`;
  validateBaseUrl(baseURL, { production: opts.production });
  const base: BedrockMantleClientOptions = {
    awsRegion: region,
    baseURL,
    // The router owns retries and backoff.
    maxRetries: 0,
  };
  if (!opts.secret) {
    if (!(opts.allowAmbientCredentials ?? !opts.production)) {
      throw new ModelConfigError('bedrock: add AWS access keys as the provider secret');
    }
    // Ambient credentials are the server's own (AWS chain, AWS_BEARER_TOKEN_BEDROCK): they
    // may only ever go to AWS itself, never to a base URL the user chose.
    return { ...base, baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic` };
  }
  const creds = parseBedrockSecret(opts.secret);
  if ('apiKey' in creds) return { ...base, apiKey: creds.apiKey };
  return {
    ...base,
    awsAccessKey: creds.accessKeyId,
    awsSecretAccessKey: creds.secretAccessKey,
    awsSessionToken: creds.sessionToken ?? null,
  };
}

export class BedrockProvider implements ModelProvider {
  readonly kind = 'bedrock' as const;
  private readonly client: AnthropicClientLike;
  private readonly baseURL: string;
  private readonly production: boolean;
  private readonly lookup: LookupFn | undefined;

  constructor(opts: BedrockOptions = {}) {
    this.production = opts.production ?? productionDefault();
    this.lookup = opts.lookup;
    const clientOpts = bedrockClientOptions({ ...opts, production: this.production });
    this.baseURL = clientOpts.baseURL!;
    this.client =
      opts.client ?? (new AnthropicBedrockMantle(clientOpts) as unknown as AnthropicClientLike);
  }

  toParams(req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
    return anthropicParams(req, bedrockModelId(req.model));
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    await assertPublicBaseUrl(this.baseURL, {
      production: this.production,
      ...(this.lookup ? { lookup: this.lookup } : {}),
    });
    const params = this.toParams(req);
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(params, {
        maxRetries: 0,
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      });
    } catch (err) {
      throw wrapAnthropicError(err, 'bedrock');
    }
    return anthropicResult(res, { ...req, model: params.model }, 'bedrock');
  }
}
