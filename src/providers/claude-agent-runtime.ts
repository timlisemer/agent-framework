import { homedir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  abortableDelay,
  isCancellationError,
  linkAbortSignal,
  throwIfAborted,
} from "../utils/cancellation.js";
import { stringField } from "../utils/output.js";
import { PROVIDER_TYPES } from "./registry.js";
import type {
  ClaudeProviderContinuationState,
  ProviderExecutionResult,
  ProviderRunInput,
  SdkRuntimeEnvironment,
  SdkRuntimeHome,
} from "./execution-types.js";
import type { ResolvedProvider } from "./types.js";
import { assertManagedRuntimeHomeConfig, prepareManagedRuntimeHome, resolveNativeProviderRoot } from "./managed-runtime-home.js";
import { materializeRuntimeHome, resolveRuntimeHomeProfile, type MaterializedRuntimeHome } from "../runtime-home/runtime-profiles.js";
import { writePolicyRuntimeAccessSentence } from "./sdk-tool-policy-prompts.js";
import { readJsonlTail } from "../utils/file-io.js";
import { resolveTranscriptBinding } from "./transcript-binding.js";
import { normalizeClaudeAiUsage } from "../../adapters/claude/usage.js";

type ClaudeQueryOptionsConfig = {
  workingDir?: string | null;
  systemPrompt?: string | null;
  sdkRuntimeEnvironment?: SdkRuntimeEnvironment;
  sdkRuntimeHome?: SdkRuntimeHome;
  runtimeHomeProfile?: ProviderRunInput["config"]["runtimeHomeProfile"];
  sdkToolPolicy?: ProviderRunInput["config"]["sdkToolPolicy"];
  runtimeRunId?: string;
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

export type ClaudeRuntimeHome = MaterializedRuntimeHome | ReturnType<typeof prepareManagedRuntimeHome>;

export type ClaudeRuntimeHomeLease = {
  readonly retainedRuntimeHome: ClaudeRuntimeHome | null;
  get(): ClaudeRuntimeHome;
  releaseAttempt(runtimeHome: ClaudeRuntimeHome): void;
  markRetainedHomeStable(): void;
  disposeCreatedRetainedHome(): void;
  dispose(): void;
};

export async function runClaudeAgent(
  input: ProviderRunInput,
  mode: "direct" | "sdk"
): Promise<ProviderExecutionResult> {
  const { config, prompt, resolvedProvider, options } = input;
  throwIfAborted(options.signal);

  const workingDir = config.workingDir ?? process.cwd();
  const isSubscription = resolvedProvider.type === PROVIDER_TYPES.CLAUDE_SUBSCRIPTION;
  const sdkToolPolicy = config.sdkToolPolicy ?? "read-only";
  const tools = mode === "direct" ? [] : [...(input.tools ?? [])];
  const systemPrompt = mode === "direct"
    ? config.systemPrompt
    : `${config.systemPrompt}

## TOOLS AVAILABLE

${claudeSdkToolDescription(sdkToolPolicy)}

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
  const runtimeHomeLease = createClaudeRuntimeHomeLease({
    config: { ...config, workingDir, systemPrompt },
    env: subprocessEnv,
    continuable,
    retainedRuntimeHome: continuable && input.continuationState?.kind === "claude"
      ? (input.continuationState.runtimeHome as ClaudeRuntimeHome | undefined) ?? null
      : null,
  });

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
        const runtimeHome = runtimeHomeLease.get();
        try {
          const q = query({
            prompt,
            options: buildClaudeQueryOptions(
              { ...config, workingDir, systemPrompt },
              resolvedProvider,
              abortController,
              subprocessEnv,
              {
                ...claudeToolSelectionOptions(mode, sdkToolPolicy, tools),
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                maxTurns: mode === "direct" ? 1 : (config.maxTurns ?? 10),
                persistSession: continuable,
                ...(previousNativeSessionId ? { resume: previousNativeSessionId } : {}),
                pathToClaudeCodeExecutable: `${homedir()}/.local/bin/claude`,
                stderr: (data: string) => {
                  stderrBuffer = (stderrBuffer + data).slice(-2048);
                },
              },
              runtimeHome,
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

              const resultUsage = normalizeClaudeAiUsage(msgAny.usage, msgAny.modelUsage);
              if (resultUsage) {
                totalPromptTokens = resultUsage.promptTokens ?? 0;
                totalCompletionTokens = resultUsage.completionTokens ?? 0;
                totalCachedTokens = resultUsage.cachedTokens ?? 0;
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
          runtimeHomeLease.releaseAttempt(runtimeHome);
        }
      } finally {
        unlinkAbortSignal();
      }
    } catch (error) {
      if (isCancellationError(error)) {
        runtimeHomeLease.disposeCreatedRetainedHome();
        throw error;
      }
      runtimeHomeLease.disposeCreatedRetainedHome();
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
        ? {
            kind: "claude",
            nativeSessionId,
            runtimeHome: runtimeHomeLease.retainedRuntimeHome ?? undefined,
            dispose: runtimeHomeLease.dispose,
          }
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
      continuationState: continuable
        ? {
            kind: "claude",
            nativeSessionId,
            runtimeHome: runtimeHomeLease.retainedRuntimeHome ?? undefined,
            dispose: runtimeHomeLease.dispose,
          }
        : undefined,
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
  overrides: ClaudeQueryOptionOverrides = {},
  runtimeHome?: ClaudeRuntimeHome,
): Record<string, unknown> {
  return {
    model: resolvedProvider.modelId,
    cwd: config.workingDir ?? process.cwd(),
    systemPrompt: config.systemPrompt ?? undefined,
    env: runtimeHome?.env ?? env,
    persistSession: false,
    abortController,
    ...overrides,
  };
}

export function prepareClaudeRuntimeHome<T extends ClaudeQueryOptionsConfig>(
  config: T,
  env: NodeJS.ProcessEnv,
): ClaudeRuntimeHome {
  assertManagedRuntimeHomeConfig(config);
  const runtimeProfile = resolveRuntimeHomeProfile({
    runtimeHomeProfile: config.runtimeHomeProfile,
    sdkRuntimeHome: config.sdkRuntimeHome,
    sdkRuntimeEnvironment: config.sdkRuntimeEnvironment,
    sdkToolPolicy: config.sdkToolPolicy,
  });
  return runtimeProfile === "managed"
    ? prepareManagedRuntimeHome("claude", env)
    : materializeRuntimeHome({
      provider: "claude",
      profile: runtimeProfile,
      toolPolicy: config.sdkToolPolicy,
      env,
      runId: config.runtimeRunId,
    });
}

export function cleanupClaudeRuntimeHome(runtimeHome: ClaudeRuntimeHome): void {
  if ("cleanup" in runtimeHome) runtimeHome.cleanup();
}

export function createClaudeRuntimeHomeLease<T extends ClaudeQueryOptionsConfig>(input: {
  config: T;
  env: NodeJS.ProcessEnv;
  continuable: boolean;
  retainedRuntimeHome?: ClaudeRuntimeHome | null;
}): ClaudeRuntimeHomeLease {
  let retainedRuntimeHome = input.retainedRuntimeHome ?? null;
  let createdRetainedRuntimeHome: ClaudeRuntimeHome | null = null;

  const dispose = (): void => {
    if (!retainedRuntimeHome) return;
    cleanupClaudeRuntimeHome(retainedRuntimeHome);
    retainedRuntimeHome = null;
    createdRetainedRuntimeHome = null;
  };

  return {
    get retainedRuntimeHome() {
      return retainedRuntimeHome;
    },
    get(): ClaudeRuntimeHome {
      if (!input.continuable) {
        return prepareClaudeRuntimeHome(input.config, input.env);
      }
      if (!retainedRuntimeHome) {
        retainedRuntimeHome = prepareClaudeRuntimeHome(input.config, input.env);
        createdRetainedRuntimeHome = retainedRuntimeHome;
      }
      return retainedRuntimeHome;
    },
    releaseAttempt(runtimeHome: ClaudeRuntimeHome): void {
      if (!input.continuable) cleanupClaudeRuntimeHome(runtimeHome);
    },
    markRetainedHomeStable(): void {
      createdRetainedRuntimeHome = null;
    },
    disposeCreatedRetainedHome(): void {
      if (createdRetainedRuntimeHome) dispose();
    },
    dispose,
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

export function resolveClaudeTranscriptBinding(input: {
  runtimeHomeRoot?: string | null;
  sessionId: string | null;
  workingDir?: string | null;
  resumeTranscriptPath?: string | null;
}): string | null {
  const root = input.runtimeHomeRoot ?? resolveNativeProviderRoot("claude", process.env);
  const projectsRoot = root ? path.join(root, "projects") : null;
  return resolveTranscriptBinding({
    explicitPath: input.resumeTranscriptPath,
    sessionId: input.sessionId,
    transcriptsRoot: projectsRoot,
    workingDir: input.workingDir,
    missingMtimeMs: 0,
    matches: (filePath, candidate) =>
      claudeTranscriptMatches(filePath, candidate.sessionId, candidate.workingDir),
  });
}

function claudeTranscriptMatches(filePath: string, sessionId: string, workingDir: string | null | undefined): boolean {
  const entries = readJsonlTail<Record<string, unknown>>(filePath, 512 * 1024);
  let sessionMatched = false;
  let cwdMatched = !workingDir;
  const expectedCwd = workingDir ? path.resolve(workingDir) : null;

  for (const entry of entries) {
    const nativeId = stringField(entry, "sessionId") ?? stringField(entry, "session_id");
    if (nativeId === sessionId) sessionMatched = true;
    const cwd = stringField(entry, "cwd") ?? stringField(entry, "projectDir");
    if (expectedCwd && cwd && path.resolve(cwd) === expectedCwd) cwdMatched = true;
    if (sessionMatched && cwdMatched) return true;
  }

  if (!sessionMatched) {
    const basename = path.basename(filePath, ".jsonl");
    sessionMatched = basename === sessionId || basename.endsWith(sessionId);
  }
  return sessionMatched && cwdMatched;
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

function claudeToolSelectionOptions(
  mode: "direct" | "sdk",
  policy: ClaudeQueryOptionsConfig["sdkToolPolicy"],
  tools: readonly string[],
): Pick<ClaudeQueryOptionOverrides, "tools" | "allowedTools"> {
  if (mode === "sdk" && policy === "write") return {};
  return { tools, allowedTools: tools };
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

function claudeSdkToolDescription(policy: ClaudeQueryOptionsConfig["sdkToolPolicy"]): string {
  if (policy === "write") {
    return writePolicyRuntimeAccessSentence();
  }
  return `You have access to read-only tools for investigating code:
- **Read**: View file contents.
- **Bash**: Classified read-only commands only: simple inspection, read-only-heavy evaluation such as nix-eval-jobs, and safe read-only pipelines. Mutation, execution, installs, builds, network fetch, and git writes are denied.

MCP tools are unavailable in this runtime.`;
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
