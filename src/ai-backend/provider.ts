import { parseTierName } from "../types.js";
import { resolveProvider, resolveProviderForType, type ResolvedProvider } from "../utils/provider-config.js";
import { parseProviderTypeStrict } from "../providers/registry.js";
import { buildClaudeQueryOptions, collectClaudeQueryResult, sanitizeClaudeEnv } from "../providers/claude-agent-runtime.js";
import {
  normalizeCodexAiUsage,
  withCodexThread,
} from "../providers/codex-agent-runtime.js";
import { PROVIDER_TYPES } from "../providers/registry.js";
import { selectSdkRuntime } from "../providers/index.js";
import type { AiSessionConfig, TokenUsage } from "../ai-protocol/index.js";

export { buildClaudeQueryOptions } from "../providers/claude-agent-runtime.js";

export interface ProviderTurnResult {
  text: string;
  usage: TokenUsage | null;
  resume: {
    provider: string;
    nativeSessionId: string | null;
    nativeThreadId: string | null;
  };
}

export interface AiProviderRunner {
  readonly resolvedProvider: ResolvedProvider;
  runTurn(config: AiSessionConfig, prompt: string, signal: AbortSignal): Promise<ProviderTurnResult>;
}

export function createProviderRunner(config: AiSessionConfig): AiProviderRunner {
  const resolvedProvider = resolveSessionProvider(config);
  return selectSdkRuntime(resolvedProvider) === "claude"
    ? new ClaudeUiProvider(resolvedProvider)
    : new CodexUiProvider(resolvedProvider);
}

export function resolveSessionProvider(config: AiSessionConfig): ResolvedProvider {
  const tier = parseTierName(config.model ?? undefined);
  return config.provider
    ? resolveProviderForType(parseProviderTypeStrict(config.provider, "AiSessionConfig.provider"), tier, "sdk")
    : resolveProvider(tier, "sdk");
}

export function buildCodexTurnInput(config: AiSessionConfig, prompt: string): string {
  if (!config.systemPrompt) return prompt;
  return `System instructions:\n${config.systemPrompt}\n\nUser request:\n${prompt}`;
}

class ClaudeUiProvider implements AiProviderRunner {
  constructor(readonly resolvedProvider: ResolvedProvider) {}

  async runTurn(config: AiSessionConfig, prompt: string, signal: AbortSignal): Promise<ProviderTurnResult> {
    signal.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });
    const env = sanitizeClaudeEnv(
      process.env,
      this.resolvedProvider.type === PROVIDER_TYPES.CLAUDE_SUBSCRIPTION
    );
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const stream = query({
        prompt,
        options: buildClaudeQueryOptions(config, this.resolvedProvider, abortController, env, {
          canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
          includePartialMessages: true,
          includeHookEvents: true,
          permissionMode: "default",
          allowedTools: [],
          tools: [],
        }),
      });
      const { text, nativeSessionId } = await collectClaudeQueryResult(stream, signal);
      return {
        text,
        usage: null,
        resume: {
          provider: this.resolvedProvider.type,
          nativeSessionId,
          nativeThreadId: null,
        },
      };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

class CodexUiProvider implements AiProviderRunner {
  constructor(readonly resolvedProvider: ResolvedProvider) {}

  async runTurn(config: AiSessionConfig, prompt: string, signal: AbortSignal): Promise<ProviderTurnResult> {
    return withCodexThread(
      this.resolvedProvider,
      config,
      "agent-framework-ai-codex-",
      async (thread) => {
        const result = await thread.run(buildCodexTurnInput(config, prompt), { signal });
        return {
          text: result.finalResponse ?? "",
          usage: normalizeCodexAiUsage(result.usage, optionalBigInt),
          resume: {
            provider: this.resolvedProvider.type,
            nativeSessionId: null,
            nativeThreadId: thread.id ?? null,
          },
        };
      }
    );
  }
}

function optionalBigInt(value: number | undefined): bigint | null {
  return value === undefined ? null : BigInt(value);
}
