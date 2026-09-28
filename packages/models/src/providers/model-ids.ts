import { ModelConfigError } from '../errors';

/**
 * Claude model ids across platforms. The hub stores first-party ids (`claude-sonnet-5`);
 * users may also type a platform id. Adapters map to what their platform expects.
 *
 * - First party: `claude-opus-5-5`
 * - Amazon Bedrock (Mantle, Messages API): `anthropic.claude-opus-5-5`. Cross-region
 *   inference profiles (`us.anthropic.…`, `global.anthropic.…`) and ARNs pass through.
 * - Google Vertex AI: the bare first-party id; dated snapshots use `@` (`claude-x@20251101`).
 */

const PLATFORM_PREFIX = /^(?:(?:us|eu|apac|jp|au|us-gov|global)\.)?anthropic[./]/;

/** First-party id behind a platform id: `us.anthropic.claude-haiku-4-5` → `claude-haiku-4-5`. */
export function baseClaudeModel(model: string): string {
  return model.replace(PLATFORM_PREFIX, '').replace(/@[\w.-]+$/, '');
}

// Model ids end up in request bodies (Mantle) or URL paths (Vertex): keep them plain.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

function assertSafeModel(model: string, platform: string): void {
  if (!SAFE_MODEL.test(model) || model.includes('..')) {
    throw new ModelConfigError(`${platform}: invalid model id`);
  }
}

/** `claude-sonnet-5` → `anthropic.claude-sonnet-5`; platform ids and ARNs are kept. */
export function bedrockModelId(model: string): string {
  assertSafeModel(model, 'bedrock');
  if (/^claude-/.test(model)) return `anthropic.${model}`;
  return model;
}

/** Vertex takes bare ids (`anthropic.claude-sonnet-5` → `claude-sonnet-5`), `@version` kept. */
export function vertexModelId(model: string): string {
  assertSafeModel(model, 'vertex');
  const bare = model.replace(PLATFORM_PREFIX, '');
  if (!/^[a-z0-9][a-z0-9.-]*(@[a-z0-9.-]+)?$/i.test(bare)) {
    throw new ModelConfigError('vertex: invalid model id');
  }
  return bare;
}
