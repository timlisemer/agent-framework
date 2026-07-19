import path from "node:path";
import { isCancellationError } from "../utils/cancellation.js";
import { PROVIDER_TYPES } from "./registry.js";
import type { ProviderExecutionResult, ProviderRunInput, SdkRuntimeEnvironment, SdkRuntimeHome } from "./execution-types.js";
import type { ProviderUsage } from "./execution-types.js";
import type { ResolvedProvider } from "./types.js";
import { assertManagedRuntimeHomeConfig, copyCodexAuthToHome } from "./managed-runtime-home.js";
import {
  makeRuntimeRunId,
  materializeRuntimeHome,
  resolveRuntimeHomeProfile,
  type ScenarioBinding,
} from "../runtime-home/runtime-profiles.js";
import type { RuntimeToolPolicy } from "../runtime-home/profiles.js";
import { codexSessionsRoot, codexTranscriptCwd, codexTranscriptSessionId } from "../../adapters/codex/paths.js";
import { sandboxModeForToolPolicy } from "../../adapters/codex/runtime-home.js";
import { mapCodexTokenUsage, normalizeCodexProviderUsage } from "../../adapters/codex/usage.js";
import { resolveTranscriptBinding } from "./transcript-binding.js";
import { writePolicyRuntimeAccessSentence } from "./sdk-tool-policy-prompts.js";

export type CodexThreadOptionsConfig = {
  workingDir?: string | null;
  sdkRuntimeEnvironment?: SdkRuntimeEnvironment;
  sdkRuntimeHome?: SdkRuntimeHome;
  runtimeHomeProfile?: ProviderRunInput["config"]["runtimeHomeProfile"];
  sdkToolPolicy?: ProviderRunInput["config"]["sdkToolPolicy"];
  runtimeRunId?: string;
  runtimeExecutionMode?: CodexRuntimeExecutionMode;
  scenarioBinding?: ScenarioBinding;
};

export type CodexRuntimeExecutionMode = "direct" | "sdk";

export type CodexThread = {
  id?: string;
  run(input: string, options?: Record<string, unknown>): Promise<CodexTurn>;
  runStreamed?: (input: string, options?: Record<string, unknown>) => Promise<{ events: AsyncIterable<unknown> }>;
};

export type CodexTurn = {
  finalResponse?: string;
  items?: CodexItemForPolicyCheck[];
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  } | null;
};

export type CodexItemForPolicyCheck = {
  type?: string;
};

export type CodexConstructor = new (options?: Record<string, unknown>) => {
  startThread(options?: Record<string, unknown>): {
    id?: string;
    run(input: string, options?: Record<string, unknown>): Promise<CodexTurn>;
    runStreamed?: (input: string, options?: Record<string, unknown>) => Promise<{ events: AsyncIterable<unknown> }>;
  };
  resumeThread?: (threadId: string, options?: Record<string, unknown>) => CodexThread;
};

type CodexLiveSession = {
  runtimeHome: ReturnType<typeof materializeRuntimeHome>;
  thread: CodexThread;
  dispose(): void;
};

export function resolveCodexTranscriptBinding(input: {
  runtimeHomeRoot: string | null;
  threadId?: string | null;
  workingDir?: string | null;
  resumeTranscriptPath?: string | null;
}): string | null {
  const sessionsRoot = input.runtimeHomeRoot
    ? path.join(input.runtimeHomeRoot, "sessions")
    : nativeCodexSessionsRoot();
  return resolveTranscriptBinding({
    explicitPath: input.resumeTranscriptPath,
    sessionId: input.threadId,
    transcriptsRoot: sessionsRoot,
    workingDir: input.workingDir,
    matches: (filePath, candidate) =>
      codexTranscriptSessionId(filePath) === candidate.sessionId &&
      (!candidate.workingDir || codexTranscriptCwd(filePath) === candidate.workingDir),
  });
}

function nativeCodexSessionsRoot(): string {
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, "sessions")
    : codexSessionsRoot();
}

export async function runCodexAgent(
  input: ProviderRunInput,
  mode: "direct" | "sdk"
): Promise<ProviderExecutionResult> {
  const { config, prompt, resolvedProvider, options } = input;
  const continuable = mode === "sdk" && config.continuable === true;
  let createdLiveSession: CodexLiveSession | null = null;
  const threadConfig = {
    ...config,
    runtimeExecutionMode: mode,
  };

  try {
    const fullPrompt = mode === "direct"
      ? `${config.systemPrompt}\n\n${prompt}`
      : `${config.systemPrompt}

${codexSdkPolicyPrompt(config.sdkToolPolicy ?? "read-only")}

${prompt}`;
    const previousSession = continuable && input.continuationState?.kind === "codex"
      ? input.continuationState.liveSession as CodexLiveSession
      : null;
    const liveSession = continuable
      ? previousSession ?? (createdLiveSession = await createCodexLiveSession(
        resolvedProvider,
        threadConfig,
        "agent-framework-codex-"
      ))
      : null;
    const turn = liveSession
      ? await liveSession.thread.run(fullPrompt, { signal: options.signal })
      : await withCodexThread(
        resolvedProvider,
        threadConfig,
        "agent-framework-codex-",
        (thread) => thread.run(fullPrompt, { signal: options.signal })
      );

    const directViolation = mode === "direct"
      ? codexDirectToolUseErrorResult(turn, resolvedProvider)
      : null;
    if (directViolation) return directViolation;

    return {
      text: turn.finalResponse ?? "",
      usage: normalizeCodexUsage(turn.usage),
      provider: resolvedProvider.type,
      modelName: resolvedProvider.modelId,
      continuationState: liveSession
        ? {
            kind: "codex",
            nativeThreadId: liveSession.thread.id ?? null,
            liveSession,
            dispose: () => liveSession.dispose(),
          }
        : undefined,
    };
  } catch (error) {
    createdLiveSession?.dispose();
    if (isCancellationError(error)) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      text: `${mode === "direct" ? "[DIRECT ERROR]" : "[SDK ERROR]"} ${errorMessage}`,
      provider: resolvedProvider.type,
      modelName: resolvedProvider.modelId,
    };
  }
}

export async function loadCodexConstructor(): Promise<CodexConstructor> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const mod = await dynamicImport("@openai/codex-sdk") as { Codex?: CodexConstructor };
  if (!mod.Codex) throw new Error("@openai/codex-sdk did not export Codex");
  return mod.Codex;
}

export function copyCodexAuthIfPresent(tempHome: string): void {
  copyCodexAuthToHome(tempHome);
}

export async function withCodexThread<T>(
  resolvedProvider: ResolvedProvider,
  config: CodexThreadOptionsConfig,
  tempPrefix: string,
  callback: (thread: CodexThread) => Promise<T>
): Promise<T> {
  const session = await createCodexLiveSession(resolvedProvider, config, tempPrefix, false);
  try {
    const thread = session.thread;
    return await callback(thread);
  } finally {
    session.dispose();
  }
}

export async function createCodexLiveSession(
  resolvedProvider: ResolvedProvider,
  config: CodexThreadOptionsConfig,
  tempPrefix: string,
  persistHistory = true,
  resumeThreadId?: string
): Promise<CodexLiveSession> {
  const runtimeEnvironment = config.sdkRuntimeEnvironment ?? "isolated";
  assertManagedRuntimeHomeConfig({ sdkRuntimeHome: config.sdkRuntimeHome, sdkRuntimeEnvironment: runtimeEnvironment });
  const profile = resolveRuntimeHomeProfile({
    runtimeHomeProfile: config.runtimeHomeProfile,
    sdkRuntimeHome: config.sdkRuntimeHome,
    sdkRuntimeEnvironment: runtimeEnvironment,
    sdkToolPolicy: config.sdkToolPolicy ?? (config.runtimeExecutionMode === "direct" ? "none" : "read-only"),
    runtimeExecutionMode: config.runtimeExecutionMode,
  });
  let runtimeHome: ReturnType<typeof materializeRuntimeHome> | null = null;
  try {
    runtimeHome = materializeRuntimeHome({
      provider: "codex",
      profile,
      toolPolicy: config.sdkToolPolicy,
      runId: config.runtimeRunId ?? makeRuntimeRunId(tempPrefix),
      scenarioBinding: config.scenarioBinding,
    });
    const Codex = await loadCodexConstructor();
    const codexConfig = buildCodexConfig(
      runtimeEnvironment,
      runtimeHome.root,
      resolvedProvider.type === PROVIDER_TYPES.OPENROUTER,
      shouldPersistCodexHistory(persistHistory, runtimeHome.sessionPolicy),
      config.sdkToolPolicy ?? (config.runtimeExecutionMode === "direct" ? "none" : "read-only")
    );
    const env = buildCodexSessionEnv(
      runtimeEnvironment,
      runtimeHome.root,
      resolvedProvider.type === PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      config.sdkRuntimeHome,
      runtimeHome.env
    );
    const codex = new Codex({
      env,
      ...(codexConfig ? { config: codexConfig } : {}),
    });
    const options = buildCodexThreadOptions(config, resolvedProvider);
    const thread = startOrResumeCodexThread(codex, options, resumeThreadId);
    const materializedRuntimeHome = runtimeHome;
    return {
      runtimeHome: materializedRuntimeHome,
      thread,
      dispose: () => {
        materializedRuntimeHome.cleanup();
      },
    };
  } catch (error) {
    runtimeHome?.cleanup();
    throw error;
  }
}

export function buildCodexThreadOptions<T extends CodexThreadOptionsConfig>(
  config: T,
  resolvedProvider: ResolvedProvider
): Record<string, unknown> {
  const runtimeEnvironment = config.sdkRuntimeEnvironment ?? "isolated";
  const runtimeExecutionMode = config.runtimeExecutionMode ?? "sdk";
  return {
    workingDirectory: config.workingDir ?? process.cwd(),
    skipGitRepoCheck: true,
    model: resolvedProvider.modelId,
    ...codexRuntimePolicyOptions(runtimeEnvironment, runtimeExecutionMode, config.sdkToolPolicy ?? (runtimeExecutionMode === "direct" ? "none" : "read-only")),
    ...(resolvedProvider.reasoningEffort
      ? { modelReasoningEffort: resolvedProvider.reasoningEffort }
      : {}),
  };
}

export function shouldPersistCodexHistory(
  persistHistory: boolean,
  sessionPolicy: ReturnType<typeof materializeRuntimeHome>["sessionPolicy"]
): boolean {
  return persistHistory && sessionPolicy !== "none" && sessionPolicy !== "volatile";
}

export function startOrResumeCodexThread(
  codex: InstanceType<CodexConstructor>,
  options: Record<string, unknown>,
  resumeThreadId?: string
): CodexThread {
  if (!resumeThreadId) return codex.startThread(options);
  if (!codex.resumeThread) {
    throw new Error("Codex SDK does not support native thread resume.");
  }
  return codex.resumeThread(resumeThreadId, options);
}

function codexSandboxModeForToolPolicy(policy: RuntimeToolPolicy): string {
  const sandboxMode = sandboxModeForToolPolicy(policy);
  if (!sandboxMode) throw new Error("Codex runtime-home spec does not define sandboxModeForToolPolicy.");
  return sandboxMode;
}

function codexRuntimePolicyOptions(
  runtimeEnvironment: SdkRuntimeEnvironment,
  mode: CodexRuntimeExecutionMode,
  toolPolicy: CodexThreadOptionsConfig["sdkToolPolicy"] = "read-only",
): Record<string, unknown> {
  if (runtimeEnvironment === "user") return {};
  const effectiveToolPolicy = toolPolicy ?? "read-only";
  const approvalPolicy = mode === "direct" || effectiveToolPolicy === "none" || effectiveToolPolicy === "write"
    ? "never"
    : "on-request";
  return {
    sandboxMode: codexSandboxModeForToolPolicy(effectiveToolPolicy),
    approvalPolicy,
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    webSearchEnabled: false,
  };
}

const DIRECT_FORBIDDEN_CODEX_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);

export function codexTurnHasDirectForbiddenItems(turn: CodexTurn): boolean {
  return Array.isArray(turn.items) &&
    turn.items.some((item) =>
      typeof item?.type === "string" &&
      DIRECT_FORBIDDEN_CODEX_ITEM_TYPES.has(item.type)
    );
}

export function codexDirectToolUseErrorResult(
  turn: CodexTurn,
  resolvedProvider: ResolvedProvider
): ProviderExecutionResult | null {
  if (!codexTurnHasDirectForbiddenItems(turn)) return null;
  return {
    text: "[DIRECT ERROR] Direct Codex runtime attempted tool use",
    usage: normalizeCodexUsage(turn.usage),
    provider: resolvedProvider.type,
    modelName: resolvedProvider.modelId,
  };
}

export function normalizeCodexUsage(usage: CodexTurn["usage"]): ProviderUsage | undefined {
  return normalizeCodexProviderUsage(usage);
}

export function normalizeCodexAiUsage<T>(
  usage: CodexTurn["usage"],
  convert: (value: number | undefined) => T
): {
  promptTokens: T;
  cachedTokens: T;
  completionTokens: T;
  reasoningTokens: T;
  totalTokens: T;
} | null {
  return mapCodexTokenUsage(usage, convert);
}

export function buildCodexEnv(
  _runtimeEnvironment: SdkRuntimeEnvironment,
  _tempHome: string | null,
  openaiSubscription: boolean
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (openaiSubscription) scrubOpenAiSubscriptionEnv(env);
  return env;
}

export function buildCodexSessionEnv(
  _runtimeEnvironment: SdkRuntimeEnvironment,
  _tempHome: string | null,
  openaiSubscription: boolean,
  _sdkRuntimeHome: CodexThreadOptionsConfig["sdkRuntimeHome"],
  baseEnv?: NodeJS.ProcessEnv,
): Record<string, string> {
  const env = baseEnv
    ? Object.fromEntries(Object.entries(baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : buildCodexEnv(_runtimeEnvironment, _tempHome, openaiSubscription);
  if (openaiSubscription) scrubOpenAiSubscriptionEnv(env);
  return env;
}

function scrubOpenAiSubscriptionEnv(env: Record<string, string>): void {
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
}

export function buildCodexConfig(
  runtimeEnvironment: SdkRuntimeEnvironment,
  tempHome: string | null,
  openrouter: boolean,
  persistHistory = false,
  toolPolicy: CodexThreadOptionsConfig["sdkToolPolicy"] = "read-only",
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {
    show_raw_agent_reasoning: true,
  };
  if (runtimeEnvironment === "isolated") {
    const effectiveToolPolicy = toolPolicy ?? "read-only";
    if (!tempHome) throw new Error("Isolated Codex runtime requires a temporary home");
    if (!persistHistory) config.history = { persistence: "none" };
    config.log_dir = path.join(tempHome, "logs");
    if (!openrouter) config.forced_login_method = "chatgpt";
    config.sandbox_mode = codexSandboxModeForToolPolicy(effectiveToolPolicy);
  }
  if (openrouter) {
    config.model_provider = "openrouter";
    config.model_providers = {
      openrouter: {
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        env_key: "OPENROUTER_API_KEY",
      },
    };
  }
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

function codexSdkPolicyPrompt(policy: CodexThreadOptionsConfig["sdkToolPolicy"]): string {
  if (policy === "write") {
    return `You are running as a write-capable implementation agent for agent-framework. You may edit files only as required by the provided plan. ${writePolicyRuntimeAccessSentence()}`;
  }
  return "You are running as a read-only validation agent for agent-framework. Do not edit files. Use only read-only inspection. MCP tools are unavailable in this runtime.";
}
