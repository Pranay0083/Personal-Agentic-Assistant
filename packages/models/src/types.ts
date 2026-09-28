import type { ModelProviderKind } from '@hub/shared';

export type Message = { role: 'user' | 'assistant'; content: string };

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
};

export type GenerateRequest = {
  model: string;
  system: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
  /** Abort after this many ms. */
  timeoutMs?: number;
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

export type RouteRequest = Omit<GenerateRequest, 'model'> & {
  userId: string;
  /** Agent name (triage, extractor, brief, reply, planner, ask). Resolves agent_configs. */
  agent: string;
};

export type RouteResult = GenerateResult & { fallbackUsed: boolean; costUsd: number };

export interface ModelRouter {
  generate(req: RouteRequest): Promise<RouteResult>;
}
