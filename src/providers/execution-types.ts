import type { CancellationOptions } from "../utils/cancellation.js";
import type { AgentConfig } from "../utils/agent-runner.js";
import type { ProviderType, ResolvedProvider } from "./types.js";

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cost?: number;
}

export interface ProviderExecutionResult {
  text: string;
  usage?: ProviderUsage;
  generationId?: string;
  provider?: ProviderType;
  modelName?: string;
}

export interface ProviderRunInput {
  config: AgentConfig;
  prompt: string;
  resolvedProvider: ResolvedProvider;
  options: CancellationOptions;
  tools?: readonly string[];
}

