import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  abortableDelay,
  isCancellationError,
  linkAbortSignal,
  throwIfAborted,
} from "../utils/cancellation.js";
import { PROVIDER_TYPES } from "./registry.js";
import type { ClaudeProviderContinuationState, ProviderExecutionResult, ProviderRunInput } from "./execution-types.js";
import type { ResolvedProvider } from "./types.js";

type ClaudeQueryOptionsConfig = {
  workingDir?: string | null;
  systemPrompt?: string | null;
};

type ClaudeQueryOptionOverrides = {
  tools?: readonly string[];
  allowedTools?: readonly string[];
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  maxTurns?: number;
  canUseTool?: unknown;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  pathToClaudeCodeExecutable?: string;
  stderr?: (data: string) => void;
  persistSession?: boolean;
  resume?: string;
};

export async function runClaudeAgent(
  input: ProviderRunInput,
  mode: "direct" | "sdk"
): Promise<ProviderExecutionResult> {
  const { config, prompt, resolvedProvider, options } = input;
  throwIfAborted(options.signal);

  const workingDir = config.workingDir ?? process.cwd();
  const isSubscription = resolvedProvider.type === PROVIDER_TYPES.CLAUDE_SUBSCRIPTION;
  const tools = mode === "direct" ? [] : [...(input.tools ?? [])];
  const systemPrompt = mode === "direct"
    ? config.systemPrompt
    : `${config.systemPrompt}

## TOOLS AVAILABLE

You have access to these tools for investigating code:
- **Read**: View file contents.
- **Bash**: Classified read-only commands only: simple inspection, read-only-heavy evaluation such as nix-eval-jobs, and safe read-only pipelines. Mutation, execution, installs, builds, network fetch, and git writes are denied.

Use these tools when you need to:
- Understand context around changed code
- Verify patterns are followed consistently
- Check if documentation matches implementation

Git data (status/diff/log/show) is already provided in the prompt context -- do not invoke git from Bash.
Your final response should be your complete analysis in the required format.`;

  const subprocessEnv = sanitizeClaudeEnv(process.env, isSubscription);
  const continuable = config.continuable === true;
  let previousNativeSessionId = continuable &&
    input.continuationState?.kind === "claude"
    ? input.continuationState.nativeSessionId
    : null;

  const runOnce = async (): Promise<SdkAttemptOutcome> => {
    let stderrBuffer = "";
    let messageCount = 0;
    let lastMessageType: string | undefined;
    let lastResultSubtype: string | undefined;
    let lastResultIsError: boolean | undefined;
    let lastResultErrors: string[] | undefined;
    let lastResultTerminalReason: string | undefined;
    let lastAssistantError: string | undefined;
    let apiRetryCount = 0;
    let lastApiRetryStatus: string | undefined;
    let finalResult = "";
    let lastAssistantContent = "";
    let nativeSessionId: string | null = null;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;

    try {
      const abortController = new AbortController();
      const unlinkAbortSignal = linkAbortSignal(options.signal, abortController);
      try {
        const q = query({
          prompt,
          options: buildClaudeQueryOptions(
            { ...config, workingDir, systemPrompt },
            resolvedProvider,
            abortController,
            subprocessEnv,
            {
              tools,
              allowedTools: tools,
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              maxTurns: mode === "direct" ? 1 : (config.maxTurns ?? 10),
              persistSession: continuable,
              ...(previousNativeSessionId ? { resume: previousNativeSessionId } : {}),
              pathToClaudeCodeExecutable: `${homedir()}/.local/bin/claude`,
              stderr: (data: string) => {
                stderrBuffer = (stderrBuffer + data).slice(-2048);
              },
            }
          ),
        });

        for await (const message of q) {
          messageCount++;
          lastMessageType = message.type;
          const msgAny = message as Record<string, unknown>;
          if (message.type === "system" && msgAny.subtype === "api_retry") {
            apiRetryCount++;
            if (typeof msgAny.error === "string") lastApiRetryStatus = msgAny.error;
          }

          if (message.type === "result") {
            nativeSessionId = collectClaudeMessageResult(message, {
              text: finalResult || lastAssistantContent,
              nativeSessionId,
            }).nativeSessionId;
            lastResultSubtype = (message as { subtype?: string }).subtype;
            if ("is_error" in message && typeof message.is_error === "boolean") {
              lastResultIsError = message.is_error;
            }
            if ("terminal_reason" in message && typeof (message as { terminal_reason?: unknown }).terminal_reason === "string") {
              lastResultTerminalReason = (message as { terminal_reason: string }).terminal_reason;
            }
            if ("errors" in message && Array.isArray((message as { errors?: unknown }).errors)) {
              lastResultErrors = (message as { errors: string[] }).errors;
            }

            const resultUsage = msgAny.usage as Record<string, unknown> | undefined;
            if (resultUsage) {
              totalPromptTokens = (resultUsage.input_tokens ?? 0) as number;
              totalCompletionTokens = (resultUsage.output_tokens ?? 0) as number;
              totalCachedTokens = (resultUsage.cache_read_input_tokens ?? 0) as number;
            }
            const modelUsage = msgAny.modelUsage as Record<string, Record<string, unknown>> | undefined;
            if (modelUsage && totalCachedTokens === 0) {
              for (const modelData of Object.values(modelUsage)) {
                if (typeof modelData.cacheReadInputTokens === "number") {
                  totalCachedTokens += modelData.cacheReadInputTokens;
                }
              }
            }

          if (
            lastResultSubtype === "success" &&
            lastResultIsError !== true &&
            "result" in message &&
            typeof message.result === "string"
          ) {
              finalResult = collectClaudeMessageResult(message).text;
            }
            break;
          }

          if (message.type === "assistant") {
            const assistantError = (message as { error?: string }).error;
            if (typeof assistantError === "string" && assistantError.length > 0) {
              lastAssistantError = assistantError;
              continue;
            }
            const collected = collectClaudeMessageResult(message, {
              text: lastAssistantContent,
              nativeSessionId,
            });
            lastAssistantContent = collected.text;
            nativeSessionId = collected.nativeSessionId;
          }
        }
      } finally {
        unlinkAbortSignal();
      }
    } catch (error) {
      if (isCancellationError(error)) throw error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { kind: "thrown", text: `${errorPrefix(mode)} ${errorMessage}` };
    }

    const hasUsage = totalPromptTokens > 0 || totalCompletionTokens > 0 || totalCachedTokens > 0;
    const usage = hasUsage ? {
      promptTokens: totalPromptTokens || undefined,
      completionTokens: totalCompletionTokens || undefined,
      totalTokens: (totalPromptTokens + totalCompletionTokens) || undefined,
      cachedTokens: totalCachedTokens || undefined,
    } : undefined;

    if (finalResult || lastAssistantContent) {
      const continuationState: ClaudeProviderContinuationState | undefined = continuable
        ? { kind: "claude", nativeSessionId }
        : undefined;
      return { kind: "ok", text: finalResult || lastAssistantContent, usage, continuationState };
    }

    return {
      kind: "noOutput",
      text: composeNoOutputSentinel(mode, {
        messageCount,
        lastMessageType,
        lastResultSubtype,
        lastResultIsError,
        lastResultErrors,
        lastResultTerminalReason,
        lastAssistantError,
        apiRetryCount,
        lastApiRetryStatus,
        stderrBuffer,
      }),
      usage,
      continuationState: continuable ? { kind: "claude", nativeSessionId } : undefined,
      diagnostics: { lastResultSubtype, lastResultIsError },
    };
  };

  const first = await runOnce();
  if (first.kind === "ok") return toResult(first, resolvedProvider);
  if (continuable && first.kind === "noOutput" && first.continuationState?.nativeSessionId) {
    previousNativeSessionId = first.continuationState.nativeSessionId;
  }

  let shouldRetry = false;
  if (first.kind === "noOutput") {
    const d = first.diagnostics;
    shouldRetry = d.lastResultSubtype === undefined ||
      d.lastResultSubtype === "error_during_execution" ||
      (d.lastResultSubtype === "success" && d.lastResultIsError === true);
  }

  if (!shouldRetry) return toResult(first, resolvedProvider);

  await abortableDelay(250, options.signal);
  const second = await runOnce();
  return toResult(second, resolvedProvider);
}

export function sanitizeClaudeEnv(env: NodeJS.ProcessEnv, subscription: boolean): NodeJS.ProcessEnv {
  const next = { ...env };
  if (subscription) {
    delete next.ANTHROPIC_API_KEY;
    delete next.ANTHROPIC_BASE_URL;
    delete next.ANTHROPIC_AUTH_TOKEN;
    delete next.OPENROUTER_API_KEY;
  } else if (next.OPENROUTER_API_KEY) {
    next.ANTHROPIC_BASE_URL = next.ANTHROPIC_BASE_URL || "https://openrouter.ai/api";
    next.ANTHROPIC_AUTH_TOKEN = next.ANTHROPIC_AUTH_TOKEN || next.OPENROUTER_API_KEY;
    next.ANTHROPIC_API_KEY = "";
  }
  return next;
}

export function buildClaudeQueryOptions<T extends ClaudeQueryOptionsConfig>(
  config: T,
  resolvedProvider: ResolvedProvider,
  abortController: AbortController,
  env: NodeJS.ProcessEnv,
  overrides: ClaudeQueryOptionOverrides = {}
): Record<string, unknown> {
  return {
    model: resolvedProvider.modelId,
    cwd: config.workingDir ?? process.cwd(),
    systemPrompt: config.systemPrompt ?? undefined,
    env,
    persistSession: false,
    abortController,
    ...overrides,
  };
}

export function extractClaudeAssistantText(message: unknown): string {
  if (!message || typeof message !== "object" || !("message" in message)) return "";
  const msg = (message as { message?: unknown }).message;
  if (!msg || typeof msg !== "object" || !("content" in msg)) return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const textBlocks: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      textBlocks.push(block.text);
    }
  }
  return textBlocks.join("\n");
}

export function collectClaudeMessageResult(
  message: unknown,
  current: { text: string; nativeSessionId: string | null } = { text: "", nativeSessionId: null }
): { text: string; nativeSessionId: string | null } {
  const raw = message as Record<string, unknown>;
  const nativeSessionId = typeof raw.session_id === "string" ? raw.session_id : current.nativeSessionId;
  if (raw.type === "assistant") {
    return { text: extractClaudeAssistantText(message) || current.text, nativeSessionId };
  }
  if (raw.type === "result" && typeof raw.result === "string") {
    return { text: raw.result, nativeSessionId };
  }
  return { text: current.text, nativeSessionId };
}

export async function collectClaudeQueryResult(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal
): Promise<{ text: string; nativeSessionId: string | null }> {
  let collected = { text: "", nativeSessionId: null as string | null };
  for await (const message of stream) {
    signal.throwIfAborted();
    collected = collectClaudeMessageResult(message, collected);
  }
  return collected;
}

function toResult(outcome: SdkAttemptOutcome, resolvedProvider: ProviderRunInput["resolvedProvider"]): ProviderExecutionResult {
  return {
    text: outcome.text,
    usage: outcome.kind === "thrown" ? undefined : outcome.usage,
    generationId: undefined,
    provider: resolvedProvider.type,
    modelName: resolvedProvider.modelId,
    continuationState: outcome.kind === "thrown" ? undefined : outcome.continuationState,
  };
}

type SdkAttemptOutcome =
  | {
      kind: "ok";
      text: string;
      usage?: ProviderExecutionResult["usage"];
      continuationState?: ClaudeProviderContinuationState;
    }
  | {
      kind: "noOutput";
      text: string;
      usage?: ProviderExecutionResult["usage"];
      continuationState?: ClaudeProviderContinuationState;
      diagnostics: {
        lastResultSubtype: string | undefined;
        lastResultIsError: boolean | undefined;
      };
    }
  | { kind: "thrown"; text: string };

function errorPrefix(mode: "direct" | "sdk"): "[DIRECT ERROR]" | "[SDK ERROR]" {
  return mode === "direct" ? "[DIRECT ERROR]" : "[SDK ERROR]";
}

function composeNoOutputSentinel(mode: "direct" | "sdk", diag: {
  messageCount: number;
  lastMessageType: string | undefined;
  lastResultSubtype: string | undefined;
  lastResultIsError: boolean | undefined;
  lastResultErrors: string[] | undefined;
  lastResultTerminalReason: string | undefined;
  lastAssistantError: string | undefined;
  apiRetryCount: number;
  lastApiRetryStatus: string | undefined;
  stderrBuffer: string;
}): string {
  const parts: string[] = [];
  parts.push(`messages=${diag.messageCount}`);
  parts.push(`lastType=${diag.lastMessageType ?? "none"}`);
  if (diag.lastResultSubtype !== undefined) parts.push(`subtype=${diag.lastResultSubtype}`);
  if (diag.lastResultIsError !== undefined) parts.push(`isError=${diag.lastResultIsError}`);
  if (diag.lastResultErrors && diag.lastResultErrors.length > 0) {
    parts.push(`errors="${diag.lastResultErrors.slice(0, 3).join(" | ").slice(0, 300)}"`);
  }
  if (diag.lastResultTerminalReason !== undefined) parts.push(`terminalReason=${diag.lastResultTerminalReason}`);
  if (diag.apiRetryCount > 0) parts.push(`apiRetries=${diag.apiRetryCount}/last=${diag.lastApiRetryStatus ?? "unknown"}`);
  if (diag.lastAssistantError !== undefined) parts.push(`assistantError=${diag.lastAssistantError}`);
  if (diag.stderrBuffer.length > 0) {
    const tail = diag.stderrBuffer.slice(-200).replace(/\s+/g, " ").trim();
    if (tail.length > 0) parts.push(`stderrTail=${tail}`);
  }
  return `${errorPrefix(mode)} No output received (${parts.join(", ")})`;
}
