import type { ModelProviderKind } from '@hub/shared';
import { ModelConfigError } from '../errors';
import type { GenerateRequest, GenerateResult, ModelProvider } from '../types';

/** Placeholder for adapters that ship in Phase 5. Fails clearly; the router can fall back. */
class NotConfiguredProvider implements ModelProvider {
  constructor(
    readonly kind: ModelProviderKind,
    private readonly label: string,
  ) {}

  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    throw new ModelConfigError(`${this.label} adapter is not configured yet (Phase 5)`);
  }
}

export class BedrockProvider extends NotConfiguredProvider {
  constructor(_opts: { region?: string } = {}) {
    super('bedrock', 'AWS Bedrock');
  }
}

export class VertexProvider extends NotConfiguredProvider {
  constructor(_opts: { projectId?: string; region?: string } = {}) {
    super('vertex', 'Google Vertex AI');
  }
}
