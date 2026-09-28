import type { ModelProviderKind } from '@hub/shared';

export type Message = { role: 'user' | 'assistant'; content: string };

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
};

/** Reasoning effort hint. Mapped to `output_config.effort` on models that support it. */
export type Effort = 'low' | 'medium' | 'high';

export type GenerateRequest = {
  model: string;
  system: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
  /** Ignored on models that reject sampling parameters (Sonnet 5, Opus 4.7+). */
  temperature?: number;
  /** Abort after this many ms. */
  timeoutMs?: number;
  /** Optional effort hint; ignored where unsupported. */
  effort?: Effort;
  /** The caller wants a single JSON object back (prompt must say so too). */
  json?: boolean;
  /**
   * Agent name, passed through by the router. Real adapters ignore it; the fake
   * provider uses it to pick which deterministic output to produce.
   */
  agent?: string;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type GenerateResult = {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  usage: Usage;
  model: string;
  provider: ModelProviderKind;
};

/** ARCHITECTURE.md "Model router". One adapter per provider family. */
export interface ModelProvider {
  kind: ModelProviderKind;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export type RouteRequest = Omit<GenerateRequest, 'model' | 'agent'> & {
  userId: string;
  /** Agent name (triage, extractor, brief, reply, planner, ask). Resolves agent_configs. */
  agent: string;
};

export type RouteResult = GenerateResult & { fallbackUsed: boolean; costUsd: number };

export interface ModelRouter {
  generate(req: RouteRequest): Promise<RouteResult>;
}
