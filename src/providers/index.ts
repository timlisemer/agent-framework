import { PROVIDER_TYPES } from "./registry.js";
import { runAnthropicApiSkinDirect } from "./anthropic-api-skin.js";
import { runClaudeAgent } from "./claude-agent-runtime.js";
import { runCodexAgent } from "./codex-agent-runtime.js";
import type { ProviderExecutionResult, ProviderRunInput } from "./execution-types.js";
import type { ResolvedProvider, SdkRuntime } from "./types.js";

export type SdkRuntimeSelection = SdkRuntime;

export async function runProviderDirect(input: ProviderRunInput): Promise<ProviderExecutionResult> {
  switch (input.resolvedProvider.type) {
    case PROVIDER_TYPES.OPENROUTER:
      return runAnthropicApiSkinDirect(input);
    case PROVIDER_TYPES.CLAUDE_SUBSCRIPTION:
      return runClaudeAgent(input, "direct");
    case PROVIDER_TYPES.OPENAI_SUBSCRIPTION:
      return runCodexAgent(input, "direct");
    default:
      throw new Error(`Unsupported provider: ${String(input.resolvedProvider.type)}`);
  }
}

export async function runProviderSdk(input: ProviderRunInput): Promise<ProviderExecutionResult> {
  const runtime = selectSdkRuntime(input.resolvedProvider);
  return runtime === "codex"
    ? runCodexAgent(input, "sdk")
    : runClaudeAgent(input, "sdk");
}

export function selectSdkRuntime(resolvedProvider: ResolvedProvider): SdkRuntimeSelection {
  switch (resolvedProvider.type) {
    case PROVIDER_TYPES.OPENROUTER:
      return resolvedProvider.sdkRuntime === "codex" ? "codex" : "claude";
    case PROVIDER_TYPES.CLAUDE_SUBSCRIPTION:
      return "claude";
    case PROVIDER_TYPES.OPENAI_SUBSCRIPTION:
      return "codex";
    default:
      throw new Error(`Unsupported provider: ${String(resolvedProvider.type)}`);
  }
}
