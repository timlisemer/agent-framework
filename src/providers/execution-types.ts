import type { CancellationOptions } from "../utils/cancellation.js";
import type { AgentConfig } from "../utils/agent-runner.js";
import type { SdkRuntimeEnvironment } from "./provider-contract.js";
import type { ProviderType, ResolvedProvider } from "./types.js";
import type { RuntimeHomeProfile, SdkToolPolicy } from "../runtime-home/runtime-profiles.js";

export type { SdkRuntimeEnvironment, SdkRuntimeHome } from "./provider-contract.js";
export type { RuntimeHomeProfile, SdkToolPolicy } from "../runtime-home/runtime-profiles.js";

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
  runtimeHome?: unknown;
  dispose?: () => void | Promise<void>;
}

export interface CodexProviderContinuationState {
  kind: "codex";
  nativeThreadId: string | null;
  liveSession: unknown;
  dispose?: () => void | Promise<void>;
}

export interface ProviderRunInput {
  config: AgentConfig & {
    sdkRuntimeEnvironment?: SdkRuntimeEnvironment;
    runtimeHomeProfile?: RuntimeHomeProfile;
    sdkToolPolicy?: SdkToolPolicy;
    runtimeRunId?: string;
  };
  prompt: string;
  resolvedProvider: ResolvedProvider;
  options: CancellationOptions;
  tools?: readonly string[];
  continuationState?: ProviderContinuationState;
}
