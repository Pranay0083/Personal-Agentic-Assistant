import type Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicVertex,
  type ClientOptions as VertexClientOptions,
} from '@anthropic-ai/vertex-sdk';
import { ModelConfigError } from '../errors';
import type { GenerateRequest, GenerateResult, ModelProvider } from '../types';
import {
  anthropicParams,
  anthropicResult,
  wrapAnthropicError,
  type AnthropicClientLike,
} from './anthropic';
import { productionDefault } from './env';
import { parseServiceAccount, ServiceAccountAuth, type FetchLike } from './google-auth';
import { vertexModelId } from './model-ids';

/**
 * Claude on Google Vertex AI. `projectId` and `region` come from the provider config; the
 * provider secret is a service account JSON key. Without a secret the hub's own
 * Application Default Credentials are used, only when `allowAmbientCredentials` is set
 * (default: outside production), since that is the operator's identity.
 */

// Both end up in the endpoint host or path: allow only the Google Cloud shapes.
const REGION = /^(?:global|us|eu|[a-z]+-[a-z]+\d{1,2})$/;
const PROJECT = /^(?:[a-z][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function vertexBaseUrl(region: string): string {
  if (region === 'global') return 'https://aiplatform.googleapis.com/v1';
  if (region === 'us' || region === 'eu')
    return `https://aiplatform.${region}.rep.googleapis.com/v1`;
  return `https://${region}-aiplatform.googleapis.com/v1`;
}

export type VertexOptions = {
  projectId?: string;
  region?: string;
  /** Decrypted provider secret: a service account JSON key. */
  secret?: string;
  allowAmbientCredentials?: boolean;
  client?: AnthropicClientLike;
  production?: boolean;
  /** For the service-account token request; tests inject one. */
  fetch?: FetchLike;
};

/** Options for the SDK client, with explicit region, project, base URL and credentials. */
export function vertexClientOptions(
  opts: Pick<
    VertexOptions,
    'projectId' | 'region' | 'secret' | 'allowAmbientCredentials' | 'fetch'
  > & {
    production: boolean;
  },
): VertexClientOptions & { region: string; projectId: string } {
  const region = opts.region?.trim() ?? '';
  if (!region) throw new ModelConfigError('vertex: region is required');
  if (!REGION.test(region)) throw new ModelConfigError('vertex: invalid region');
  const key = opts.secret ? parseServiceAccount(opts.secret) : null;
  if (!key && !(opts.allowAmbientCredentials ?? !opts.production)) {
    throw new ModelConfigError('vertex: add a service account key as the provider secret');
  }
  const projectId = opts.projectId?.trim() || key?.projectId || '';
  if (!projectId) throw new ModelConfigError('vertex: projectId is required');
  if (!PROJECT.test(projectId)) throw new ModelConfigError('vertex: invalid projectId');
  return {
    region,
    projectId,
    baseURL: vertexBaseUrl(region),
    // The router owns retries and backoff.
    maxRetries: 0,
    ...(key
      ? {
          authClient: new ServiceAccountAuth(
            key,
            opts.fetch ? { fetch: opts.fetch } : {},
          ) as unknown as NonNullable<VertexClientOptions['authClient']>,
        }
      : {}),
  };
}

export class VertexProvider implements ModelProvider {
  readonly kind = 'vertex' as const;
  private client: AnthropicClientLike | undefined;
  private readonly clientOpts: VertexClientOptions;

  constructor(opts: VertexOptions = {}) {
    const production = opts.production ?? productionDefault();
    // Validated now, so misconfiguration fails before any request.
    this.clientOpts = vertexClientOptions({ ...opts, production });
    this.client = opts.client;
  }

  /**
   * Built on first use: with ambient credentials the SDK starts resolving them in its
   * constructor, and that promise must be awaited by a request right away.
   */
  private sdk(): AnthropicClientLike {
    this.client ??= new AnthropicVertex(this.clientOpts) as unknown as AnthropicClientLike;
    return this.client;
  }

  toParams(req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
    return anthropicParams(req, vertexModelId(req.model));
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const params = this.toParams(req);
    let res: Anthropic.Message;
    try {
      res = await this.sdk().messages.create(params, {
        maxRetries: 0,
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      });
    } catch (err) {
      throw wrapAnthropicError(err, 'vertex');
    }
    return anthropicResult(res, { ...req, model: params.model }, 'vertex');
  }
}
