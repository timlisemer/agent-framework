import type { CancellationOptions } from "../utils/cancellation.js";
import type { AgentConfig } from "../utils/agent-runner.js";
import type { SdkRuntimeEnvironment } from "../ai-protocol/index.js";
import type { ProviderType, ResolvedProvider } from "./types.js";

export type { SdkRuntimeEnvironment, SdkRuntimeHome } from "../ai-protocol/index.js";

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
  continuationState?: ProviderContinuationState;
}

export type ProviderContinuationState =
  | ClaudeProviderContinuationState
  | CodexProviderContinuationState;

export interface ClaudeProviderContinuationState {
  kind: "claude";
  nativeSessionId: string | null;
}

export interface CodexProviderContinuationState {
  kind: "codex";
  nativeThreadId: string | null;
  liveSession: unknown;
  dispose?: () => void | Promise<void>;
}

export interface ProviderRunInput {
  config: AgentConfig & { sdkRuntimeEnvironment?: SdkRuntimeEnvironment };
  prompt: string;
  resolvedProvider: ResolvedProvider;
  options: CancellationOptions;
  tools?: readonly string[];
  continuationState?: ProviderContinuationState;
}
