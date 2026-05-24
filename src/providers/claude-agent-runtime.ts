import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  abortableDelay,
  isCancellationError,
  linkAbortSignal,
  throwIfAborted,
} from "../utils/cancellation.js";
import { numberOrNull, outputBlocks, stringField, textFromOutput } from "../utils/output.js";
import { summarizeToolInputForUi } from "../utils/tool-input-summary.js";
import { PROVIDER_TYPES } from "./registry.js";
import type { ClaudeProviderContinuationState, ProviderExecutionResult, ProviderRunInput } from "./execution-types.js";
import type { ResolvedProvider } from "./types.js";
import type { AiRuntimeEvent } from "../ai-backend/runtime-events.js";
import type { TokenUsage } from "../ai-protocol/index.js";

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

export type ClaudeUiStreamState = {
  seenMessages: Set<string>;
  seenTools: Set<string>;
  seenProcesses: Set<string>;
  assistantText: string;
  assistantReasoning: Map<string, string>;
  planUpdates: Set<string>;
  sessionRef: string | null;
};

export function createClaudeUiStreamState(sessionRef: string | null = null): ClaudeUiStreamState {
  return {
    seenMessages: new Set(),
    seenTools: new Set(),
    seenProcesses: new Set(),
    assistantText: "",
    assistantReasoning: new Map(),
    planUpdates: new Set(),
    sessionRef,
  };
}

export function recordClaudePlanUpdate(state: ClaudeUiStreamState, plan: string): boolean {
  if (state.planUpdates.has(plan)) return false;
  state.planUpdates.add(plan);
  return true;
}

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

export function mapClaudeUiStreamMessage(message: unknown, state: ClaudeUiStreamState): {
  events: AiRuntimeEvent[];
  usage: TokenUsage | null;
  sessionRef: string | null;
  terminal: boolean;
} {
  const raw = message as Record<string, unknown>;
  if (!raw || typeof raw !== "object") {
    return { events: [], usage: null, sessionRef: state.sessionRef, terminal: false };
  }
  if (typeof raw.session_id === "string") state.sessionRef = raw.session_id;
  const events: AiRuntimeEvent[] = [];
  let usage: TokenUsage | null = null;
  let terminal = false;

  if (raw.type === "stream_event") {
    events.push(...mapClaudePartialStreamEvent(raw.event, state));
  } else if (raw.type === "assistant") {
    events.push(...mapClaudeAssistantMessage(raw, state));
  } else if (raw.type === "user") {
    events.push(...mapClaudeUserMessage(raw));
  } else if (raw.type === "tool_progress") {
    const ref = stringField(raw, "tool_use_id");
    if (ref) {
      ensureTool(events, state, ref, stringField(raw, "tool_name") ?? "tool", {});
      const seconds = typeof raw.elapsed_time_seconds === "number" ? `${raw.elapsed_time_seconds}s elapsed` : null;
      events.push({ type: "tool.progress", ref, progress: seconds });
    }
  } else if (raw.type === "system") {
    events.push(...mapClaudeSystemMessage(raw, state));
  } else if (raw.type === "result") {
    terminal = true;
    usage = normalizeClaudeUiUsage(raw.usage);
    const resultText = typeof raw.result === "string" ? raw.result : state.assistantText;
    if (!state.seenMessages.has("assistant")) {
      state.seenMessages.add("assistant");
      events.push({ type: "message.created", ref: "assistant", content: "" });
    }
    events.push({ type: "message.completed", ref: "assistant", content: resultText, usage });
  }

  return { events, usage, sessionRef: state.sessionRef, terminal };
}

function mapClaudePartialStreamEvent(event: unknown, state: ClaudeUiStreamState): AiRuntimeEvent[] {
  if (!event || typeof event !== "object") return [];
  const raw = event as Record<string, unknown>;
  const events: AiRuntimeEvent[] = [];
  if (!state.seenMessages.has("assistant")) {
    state.seenMessages.add("assistant");
    events.push({ type: "message.created", ref: "assistant", content: "" });
  }
  if (raw.type === "content_block_delta") {
    const delta = raw.delta;
    if (delta && typeof delta === "object" && "text" in delta && typeof delta.text === "string") {
      state.assistantText += delta.text;
      events.push({ type: "message.delta", ref: "assistant", delta: delta.text });
    }
    const thinking = reasoningText(delta);
    if (thinking) {
      const key = reasoningKey(raw.index, stringField(delta as Record<string, unknown>, "type"));
      const previous = state.assistantReasoning.get(key) ?? "";
      state.assistantReasoning.set(key, previous + thinking);
      events.push({ type: "message.reasoning_delta", ref: "assistant", delta: thinking });
    }
  }
  return events;
}

function mapClaudeAssistantMessage(raw: Record<string, unknown>, state: ClaudeUiStreamState): AiRuntimeEvent[] {
  const events: AiRuntimeEvent[] = [];
  if (!state.seenMessages.has("assistant")) {
    state.seenMessages.add("assistant");
    events.push({ type: "message.created", ref: "assistant", content: "" });
  }
  const text = extractClaudeAssistantText(raw);
  if (text && text !== state.assistantText) {
    const delta = text.startsWith(state.assistantText) ? text.slice(state.assistantText.length) : text;
    state.assistantText = text;
    if (delta) events.push({ type: "message.delta", ref: "assistant", delta });
  }

  const content = messageContent(raw);
  for (const [index, block] of content.entries()) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const thinking = reasoningText(item);
    if (thinking) {
      const key = reasoningKey(index, stringField(item, "type"));
      const previous = state.assistantReasoning.get(key) ?? "";
      const delta = thinking.startsWith(previous) ? thinking.slice(previous.length) : thinking;
      state.assistantReasoning.set(key, thinking);
      if (delta) events.push({ type: "message.reasoning_delta", ref: "assistant", delta });
    }
    if (item.type !== "tool_use") continue;
    const ref = stringField(item, "id");
    const name = stringField(item, "name") ?? "tool";
    const input = item.input;
    if (name === "ExitPlanMode" && input && typeof input === "object") {
      const plan = stringField(input as Record<string, unknown>, "plan");
      if (plan && recordClaudePlanUpdate(state, plan)) {
        events.push({ type: "plan.updated", state: { mode: "awaitingApproval", planText: plan, approved: false } });
      }
    }
    if (ref) ensureTool(events, state, ref, name, input);
  }
  return events;
}

function mapClaudeUserMessage(raw: Record<string, unknown>): AiRuntimeEvent[] {
  const events: AiRuntimeEvent[] = [];
  for (const block of messageContent(raw)) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type !== "tool_result") continue;
    const ref = stringField(item, "tool_use_id");
    if (!ref) continue;
    const isError = item.is_error === true;
    const output = outputBlocks(item.content);
    if (output.length > 0) events.push({ type: "tool.output", ref, output });
    events.push(isError
      ? { type: "tool.failed", ref, error: textFromOutput(output) || "Tool failed" }
      : { type: "tool.completed", ref, output });
  }
  return events;
}

function mapClaudeSystemMessage(raw: Record<string, unknown>, state: ClaudeUiStreamState): AiRuntimeEvent[] {
  const subtype = stringField(raw, "subtype");
  const events: AiRuntimeEvent[] = [];
  if (subtype === "permission_denied") {
    const ref = stringField(raw, "tool_use_id");
    const name = stringField(raw, "tool_name") ?? "tool";
    if (ref) {
      ensureTool(events, state, ref, name, {});
      events.push({ type: "tool.updated", ref, status: "denied", waitReason: stringField(raw, "decision_reason") });
    }
  } else if (subtype === "task_started") {
    const ref = stringField(raw, "task_id");
    if (ref) {
      const title = stringField(raw, "description") ?? "Background task";
      ensureProcess(events, state, ref, title);
      events.push({ type: "backend_process.updated", ref, status: "running" });
    }
  } else if (subtype === "task_progress") {
    const ref = stringField(raw, "task_id");
    if (ref) {
      ensureProcess(events, state, ref, stringField(raw, "description") ?? "Background task");
      events.push({ type: "backend_process.progress", ref, progress: stringField(raw, "summary") ?? stringField(raw, "description") });
    }
  } else if (subtype === "task_notification") {
    const ref = stringField(raw, "task_id");
    if (ref) {
      ensureProcess(events, state, ref, stringField(raw, "summary") ?? "Background task");
      const status = stringField(raw, "status");
      if (status === "completed") events.push({ type: "backend_process.completed", ref, output: outputBlocks(raw.summary) });
      if (status === "failed") events.push({ type: "backend_process.failed", ref, error: stringField(raw, "summary") ?? "Background task failed" });
      if (status === "stopped") events.push({ type: "backend_process.cancelled", ref });
    }
  }
  return events;
}

function ensureTool(
  events: AiRuntimeEvent[],
  state: ClaudeUiStreamState,
  ref: string,
  name: string,
  input: unknown
): void {
  if (state.seenTools.has(ref)) return;
  state.seenTools.add(ref);
  events.push({ type: "tool.created", ref, name, input: summarizeToolInputForUi(name, input) });
}

function ensureProcess(events: AiRuntimeEvent[], state: ClaudeUiStreamState, ref: string, title: string): void {
  if (state.seenProcesses.has(ref)) return;
  state.seenProcesses.add(ref);
  events.push({ type: "backend_process.created", ref, title, cancellable: true });
}

function messageContent(raw: Record<string, unknown>): unknown[] {
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}

function reasoningText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const type = stringField(raw, "type");
  if (type !== "thinking" && type !== "reasoning" && type !== "thinking_delta" && type !== "redacted_thinking") {
    return null;
  }
  return stringField(raw, "thinking") ?? stringField(raw, "text") ?? stringField(raw, "summary");
}

function reasoningKey(index: unknown, type: string | null): string {
  const normalizedType = type === "thinking_delta" ? "thinking" : (type ?? "thinking");
  return `reasoning:${String(index ?? "unknown")}:${normalizedType}`;
}

function normalizeClaudeUiUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const data = usage as Record<string, unknown>;
  const promptTokens = numberOrNull(data.input_tokens);
  const completionTokens = numberOrNull(data.output_tokens);
  const cachedTokens = numberOrNull(data.cache_read_input_tokens);
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    reasoningTokens: null,
    totalTokens: promptTokens === null && completionTokens === null
      ? null
      : (promptTokens ?? 0) + (completionTokens ?? 0),
  };
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
