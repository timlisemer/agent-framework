import path from "node:path";
import { isCancellationError } from "../utils/cancellation.js";
import { errorMessage, optionalNumber, outputBlocks, stringField, textOutput } from "../utils/output.js";
import { summarizeToolInputForUi } from "../utils/tool-input-summary.js";
import { PROVIDER_TYPES } from "./registry.js";
import type { ProviderExecutionResult, ProviderRunInput, SdkRuntimeEnvironment, SdkRuntimeHome } from "./execution-types.js";
import type { ProviderUsage } from "./execution-types.js";
import type { ResolvedProvider } from "./types.js";
import type { AiRuntimeEvent } from "../ai-backend/runtime-events.js";
import { assertManagedRuntimeHomeConfig, copyCodexAuthToHome } from "./managed-runtime-home.js";
import { makeRuntimeRunId, materializeRuntimeHome, resolveRuntimeHomeProfile } from "../runtime-home/runtime-profiles.js";
import type { RuntimeToolPolicy } from "../runtime-home/profiles.js";
import type { AiMetadata } from "../ai-protocol/index.js";
import { resolveSessionTranscriptPathForProject, sessionToolLogFile } from "../utils/paths.js";
import type { ToolLogEntry } from "../utils/session-store.js";
import {
  codexToolLogIdentity,
  codexToolLogInput,
  codexToolLogMetadata,
  codexToolLogToolName,
  codexRuntimeToolHelpers,
  type CodexToolIdentity,
} from "../../adapters/codex/tool-identity.js";
import { sandboxModeForToolPolicy } from "../../adapters/codex/runtime-home.js";
import {
  createToolLogTailReader,
  isLiveToolLogStatus,
  type ToolLogTailReader,
  toolLogErrorMessage,
  toolLogTerminalStatus,
} from "../utils/agent-framework-tool-log.js";

const codexRuntimeTools = codexRuntimeToolHelpers;

export type CodexThreadOptionsConfig = {
  workingDir?: string | null;
  sdkRuntimeEnvironment?: SdkRuntimeEnvironment;
  sdkRuntimeHome?: SdkRuntimeHome;
  runtimeHomeProfile?: ProviderRunInput["config"]["runtimeHomeProfile"];
  sdkToolPolicy?: ProviderRunInput["config"]["sdkToolPolicy"];
  runtimeRunId?: string;
  runtimeExecutionMode?: CodexRuntimeExecutionMode;
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

export type CodexUiStreamState = {
  seenMessages: Set<string>;
  seenTools: Set<string>;
  seenProcesses: Set<string>;
  assistantText: Map<string, string>;
  assistantReasoning: Map<string, string>;
  toolRefAliases: Map<string, string>;
  pendingHookToolRefsBySignature: Map<string, string[]>;
  pendingHookToolRefsByCanonicalName: Map<string, string[]>;
  completedHookRefsBySignature: Map<string, string[]>;
  completedHookRefsByCanonicalName: Map<string, string[]>;
  completedHookAliases: Set<string>;
  completedHookRefs: Set<string>;
  pendingFunctionOutputsByCallId: Map<string, PendingCodexFunctionOutput[]>;
};

export function createCodexUiStreamState(): CodexUiStreamState {
  return {
    seenMessages: new Set(),
    seenTools: new Set(),
    seenProcesses: new Set(),
    assistantText: new Map(),
    assistantReasoning: new Map(),
    toolRefAliases: new Map(),
    pendingHookToolRefsBySignature: new Map(),
    pendingHookToolRefsByCanonicalName: new Map(),
    completedHookRefsBySignature: new Map(),
    completedHookRefsByCanonicalName: new Map(),
    completedHookAliases: new Set(),
    completedHookRefs: new Set(),
    pendingFunctionOutputsByCallId: new Map(),
  };
}

export type CodexToolLogPoller = {
  poll(): AiRuntimeEvent[];
};

type CodexLiveSession = {
  runtimeHome: ReturnType<typeof materializeRuntimeHome>;
  thread: CodexThread;
  dispose(): void;
};

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
    });
    const Codex = await loadCodexConstructor();
    const codexConfig = buildCodexConfig(
      runtimeEnvironment,
      runtimeHome.root,
      resolvedProvider.type === PROVIDER_TYPES.OPENROUTER,
      persistHistory && runtimeHome.sessionPolicy !== "none" && runtimeHome.sessionPolicy !== "volatile",
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
  return usage ? {
    promptTokens: usage.input_tokens,
    cachedTokens: usage.cached_input_tokens,
    completionTokens: usage.output_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  } : undefined;
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
  return usage ? {
    promptTokens: convert(usage.input_tokens),
    cachedTokens: convert(usage.cached_input_tokens),
    completionTokens: convert(usage.output_tokens),
    reasoningTokens: convert(usage.reasoning_output_tokens),
    totalTokens: convert((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
  } : null;
}

export function mapCodexUiStreamEvent(event: unknown, state: CodexUiStreamState): AiRuntimeEvent[] {
  if (!event || typeof event !== "object") return [];
  const raw = event as Record<string, unknown>;
  if (raw.type === "turn.completed") {
    return [{ type: "turn.completed", usage: normalizeCodexAiUsage(raw.usage as CodexTurn["usage"], optionalNumber) }];
  }
  if (raw.type === "turn.failed") {
    return [{ type: "error", error: errorMessage(raw.error) }];
  }
  if (raw.type === "error") {
    return [{ type: "error", error: stringField(raw, "message") ?? "Runtime stream error" }];
  }
  if (
    raw.type !== "item.started" &&
    raw.type !== "item.updated" &&
    raw.type !== "item.completed"
  ) {
    return [];
  }
  const item = raw.item;
  if (!item || typeof item !== "object") return [];
  return mapCodexUiItem(raw.type, item as Record<string, unknown>, state);
}

export function createCodexToolLogPoller(
  projectDir: string | null | undefined,
  state: CodexUiStreamState
): CodexToolLogPoller | null {
  const initial = resolveSessionTranscriptPathForProject(projectDir ?? undefined);
  const startedAt = Date.now();
  let sessionDir = initial?.sessionDir ?? null;
  let logPath = sessionDir ? sessionToolLogFile(sessionDir) : null;
  let reader: ToolLogTailReader | null = logPath
    ? createToolLogTailReader(logPath, { minTimestamp: startedAt - 1000 })
    : null;

  return {
    poll(): AiRuntimeEvent[] {
      const resolved = resolveSessionTranscriptPathForProject(projectDir ?? undefined);
      if (resolved?.sessionDir && resolved.sessionDir !== sessionDir) {
        sessionDir = resolved.sessionDir;
        logPath = sessionToolLogFile(sessionDir);
        reader = createToolLogTailReader(logPath, { offset: 0, minTimestamp: startedAt - 1000 });
      }
      if (!logPath || !reader) return [];

      const events: AiRuntimeEvent[] = [];
      for (const entry of reader.read()) {
        events.push(...mapCodexToolLogEntryForUi(entry, state));
      }
      return events;
    },
  };
}

export function mapCodexToolLogEntryForUi(
  entry: ToolLogEntry,
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  if (!isLiveToolLogStatus(entry.status)) return [];
  const identity = codexToolLogIdentity(entry);
  if (!entry.toolUseId) {
    const ref = consumePendingHookToolRef(state, identity) ?? null;
    if (!ref) return [];
    if (entry.gate === "post-tool-use" && entry.status === "allowed") {
      registerCompletedHookRef(state, identity, ref);
      return [{ type: "tool.completed", ref, output: [] }];
    }
    if (toolLogTerminalStatus(entry) === "failed") {
      const metadata = codexToolLogMetadata(entry);
      const message = toolLogErrorMessage(entry);
      return [{
        type: "tool.failed",
        ref,
        error: message,
        publicMessage: message,
        metadata,
      }];
    }
    return [];
  }

  const metadata = codexToolLogMetadata(entry);
  const ref = canonicalToolRef(state, entry.toolUseId, identity, false);
  const events = ensureTool(
    state,
    ref,
    codexToolLogToolName(entry),
    codexToolLogInput(entry),
    metadata
  );

  if (entry.status === "allowed") {
    registerPendingHookToolRef(state, identity, ref);
    events.push({ type: "tool.updated", ref, status: "running" });
    return events;
  }

  const message = toolLogErrorMessage(entry);
  events.push({
    type: "tool.failed",
    ref,
    error: message,
    publicMessage: message,
    metadata,
  });
  return events;
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

function mapCodexUiItem(
  eventType: string,
  item: Record<string, unknown>,
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  const itemType = stringField(item, "type");
  const rawId = stringField(item, "id") ?? codexRuntimeTools.syntheticItemRef(itemType, item);
  const identity = codexRuntimeTools.itemToolIdentity(itemType, item);
  const id = isFunctionCallItemType(itemType)
    ? rawId
    : canonicalToolRef(state, rawId, identity, true);
  const completedHookAlias = isCompletedHookAliasForSdkToolItem(state, itemType, rawId);
  switch (itemType) {
    case "agent_message": {
      const text = stringField(item, "text") ?? "";
      const ref = stringField(item, "id") ?? codexRuntimeTools.syntheticItemRef(itemType, item);
      const trackingId = ref;
      const events: AiRuntimeEvent[] = [];
      ensureAssistantMessage(events, state, ref);
      if (eventType === "item.completed") {
        events.push({ type: "message.completed", ref, content: text, usage: null });
      } else if (text) {
        const previous = state.assistantText.get(trackingId) ?? "";
        const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
        state.assistantText.set(trackingId, text);
        if (delta) events.push({ type: "message.delta", ref, delta });
      }
      return events;
    }
    case "reasoning": {
      const text = stringField(item, "text") ?? stringField(item, "summary") ?? "";
      const ref = stringField(item, "id") ?? codexRuntimeTools.syntheticItemRef(itemType, item);
      const trackingId = ref;
      const events: AiRuntimeEvent[] = [];
      ensureAssistantMessage(events, state, ref);
      if (!text) return events;
      const previous = state.assistantReasoning.get(trackingId) ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      state.assistantReasoning.set(trackingId, text);
      if (delta) events.push({ type: "message.reasoning_delta", ref, delta });
      return events;
    }
    case "todo_list": {
      const planText = codexTodoPlanText(item.items ?? item.todos);
      return planText
        ? [{ type: "plan.updated", state: { mode: "planning", planText, approved: false } }]
        : [];
    }
    case "command_execution": {
      const command = stringField(item, "command") ?? "Command";
      const status = stringField(item, "status");
      const output = stringField(item, "aggregated_output");
      const actionSummary = codexRuntimeTools.commandActionSummary(item.commandActions ?? item.actions);
      const events = ensureTool(state, id, "shell", {
        command,
        ...(actionSummary ? { actionSummary, actionCount: actionSummary.split("\n").length } : {}),
      }, codexRuntimeTools.itemMetadata(item, itemType, id));
      if (status === "completed") {
        events.push({ type: "tool.completed", ref: id, output: output ? textOutput(output) : [] });
      } else if (codexRuntimeTools.isFailureStatus(status)) {
        if (output) events.push({ type: "tool.output", ref: id, output: textOutput(output) });
        events.push({
          type: "tool.failed",
          ref: id,
          error: "Operation failed",
          publicMessage: output ?? "Command failed",
          metadata: codexRuntimeTools.itemMetadata(item, itemType, id),
        });
      } else if (!completedHookAlias) {
        events.push({ type: "tool.updated", ref: id, status: "running" });
        if (output) events.push({ type: "tool.progress", ref: id, progress: output });
      }
      return events;
    }
    case "mcp_tool_call": {
      const server = stringField(item, "server");
      const tool = stringField(item, "tool");
      const name = server && tool ? `mcp__${server}__${tool}` : "mcp_tool";
      const status = stringField(item, "status");
      const metadata = codexRuntimeTools.itemMetadata(item, itemType, id);
      const events = ensureTool(state, id, name, { server, tool, arguments: item.arguments }, metadata);
      if (status === "completed") {
        events.push({ type: "tool.completed", ref: id, output: outputBlocks(item.result) });
      } else if (codexRuntimeTools.isFailureStatus(status)) {
        const message = errorMessage(item.error);
        events.push({ type: "tool.failed", ref: id, error: message, publicMessage: message, metadata });
      } else if (!completedHookAlias) {
        events.push({ type: "tool.updated", ref: id, status: "running" });
      }
      return events;
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = codexRuntimeTools.extractFileChangePaths(item);
      const events = ensureTool(state, id, "file_edit", {
        changes: item.changes,
        changeCount: changes.length,
        files: paths.slice(0, 3).join(", "),
        path: paths[0] ?? null,
      }, codexRuntimeTools.itemMetadata(item, itemType, id));
      const status = stringField(item, "status");
      if (codexRuntimeTools.isFailureStatus(status)) {
        events.push({
          type: "tool.failed",
          ref: id,
          error: "File change failed",
          publicMessage: "File change failed",
          metadata: codexRuntimeTools.itemMetadata(item, itemType, id),
        });
      } else if (status === "completed" || eventType === "item.completed") {
        events.push({ type: "tool.completed", ref: id, output: outputBlocks(item.changes) });
      } else if (!completedHookAlias) {
        events.push({ type: "tool.updated", ref: id, status: "running" });
      }
      return events;
    }
    case "web_search": {
      const events = ensureTool(state, id, "search", { query: item.query }, codexRuntimeTools.itemMetadata(item, itemType, id));
      if (eventType === "item.completed") {
        events.push({ type: "tool.completed", ref: id, output: [] });
      } else if (!completedHookAlias) {
        events.push({ type: "tool.updated", ref: id, status: "running" });
      }
      return events;
    }
    case "function_call":
    case "custom_tool_call":
      return mapCodexFunctionCallItem(eventType, item, itemType, id, state);
    case "function_call_output":
    case "custom_tool_call_output":
      return mapCodexFunctionCallOutputItem(item, itemType, id, state);
    case "error":
      return [{ type: "error", error: stringField(item, "message") ?? "Runtime item error" }];
    default:
      return mapUnknownCodexItem(eventType, item, itemType, id, completedHookAlias, state);
  }
}

function ensureTool(
  state: CodexUiStreamState,
  ref: string,
  name: string,
  input: unknown,
  metadata?: AiMetadata
): AiRuntimeEvent[] {
  if (state.seenTools.has(ref)) return [];
  state.seenTools.add(ref);
  return [{
    type: "tool.created",
    ref,
    name,
    input: summarizeToolInputForUi(name, input),
    ...(metadata ? { metadata } : {}),
  }];
}

function canonicalToolRef(
  state: CodexUiStreamState,
  ref: string,
  identity: CodexToolIdentity,
  consumePendingHook: boolean
): string {
  const existing = state.toolRefAliases.get(ref) ??
    (consumePendingHook ? consumePendingHookToolRef(state, identity) : undefined) ??
    (consumePendingHook ? consumeCompletedHookRef(state, identity) : undefined);
  const canonical = existing ?? ref;
  state.toolRefAliases.set(ref, canonical);
  if (existing && state.completedHookRefs.has(existing)) state.completedHookAliases.add(ref);
  return canonical;
}

function isCompletedHookAliasForSdkToolItem(
  state: CodexUiStreamState,
  itemType: string | null,
  rawId: string
): boolean {
  return isSdkToolItemType(itemType) && state.completedHookAliases.has(rawId);
}

function isSdkToolItemType(itemType: string | null): boolean {
  return itemType === "command_execution" ||
    itemType === "mcp_tool_call" ||
    itemType === "file_change" ||
    itemType === "web_search" ||
    itemType === null ||
    itemType === "runtime_item";
}

function registerPendingHookToolRef(state: CodexUiStreamState, identity: CodexToolIdentity, ref: string): void {
  appendPendingHookRef(state.pendingHookToolRefsBySignature, identity.signature, ref);
  appendPendingHookRef(state.pendingHookToolRefsByCanonicalName, identity.canonicalToolName, ref);
}

function appendPendingHookRef(target: Map<string, string[]>, key: string, ref: string): void {
  const refs = target.get(key) ?? [];
  if (!refs.includes(ref)) refs.push(ref);
  target.set(key, refs);
}

function consumePendingHookToolRef(state: CodexUiStreamState, identity: CodexToolIdentity): string | undefined {
  return consumeHookRefFromIndexes({
    bySignature: state.pendingHookToolRefsBySignature,
    byCanonicalName: state.pendingHookToolRefsByCanonicalName,
    seenTools: state.seenTools,
    identity,
  });
}

function registerCompletedHookRef(state: CodexUiStreamState, identity: CodexToolIdentity, ref: string): void {
  state.completedHookRefs.add(ref);
  appendPendingHookRef(state.completedHookRefsBySignature, identity.signature, ref);
  appendPendingHookRef(state.completedHookRefsByCanonicalName, identity.canonicalToolName, ref);
}

function consumeCompletedHookRef(state: CodexUiStreamState, identity: CodexToolIdentity): string | undefined {
  return consumeHookRefFromIndexes({
    bySignature: state.completedHookRefsBySignature,
    byCanonicalName: state.completedHookRefsByCanonicalName,
    seenTools: state.seenTools,
    identity,
  });
}

function consumeHookRefFromIndexes(input: {
  bySignature: Map<string, string[]>;
  byCanonicalName: Map<string, string[]>;
  seenTools: Set<string>;
  identity: CodexToolIdentity;
}): string | undefined {
  const bySignature = consumePendingHookRefForKey(input.bySignature, input.identity.signature, input.seenTools);
  if (bySignature) {
    removePendingHookRefForKey(input.byCanonicalName, input.identity.canonicalToolName, bySignature);
    return bySignature;
  }
  if (codexRuntimeTools.isFileMutationTool(input.identity.canonicalToolName) && codexRuntimeTools.toolIdentityPaths(input.identity).length > 0) {
    return undefined;
  }
  const canonicalRefs = input.byCanonicalName.get(input.identity.canonicalToolName) ?? [];
  const liveCanonicalRefs = canonicalRefs.filter((ref) => input.seenTools.has(ref));
  if (liveCanonicalRefs.length !== 1) return undefined;
  const byCanonical = liveCanonicalRefs[0];
  removePendingHookRefForKey(input.byCanonicalName, input.identity.canonicalToolName, byCanonical);
  removePendingHookRefFromAll(input.bySignature, byCanonical);
  return byCanonical;
}

function consumePendingHookRefForKey(target: Map<string, string[]>, key: string, seenTools: Set<string>): string | undefined {
  const refs = target.get(key);
  if (!refs) return undefined;
  while (refs.length > 0) {
    const ref = refs.shift();
    if (ref && seenTools.has(ref)) {
      if (refs.length === 0) target.delete(key);
      return ref;
    }
  }
  target.delete(key);
  return undefined;
}

function removePendingHookRefForKey(target: Map<string, string[]>, key: string, ref: string): void {
  const refs = target.get(key);
  if (!refs) return;
  const remaining = refs.filter((candidate) => candidate !== ref);
  if (remaining.length > 0) {
    target.set(key, remaining);
  } else {
    target.delete(key);
  }
}

function removePendingHookRefFromAll(target: Map<string, string[]>, ref: string): void {
  for (const key of [...target.keys()]) {
    removePendingHookRefForKey(target, key, ref);
  }
}

function ensureAssistantMessage(events: AiRuntimeEvent[], state: CodexUiStreamState, ref: string): void {
  if (state.seenMessages.has(ref)) return;
  state.seenMessages.add(ref);
  events.push({ type: "message.created", ref, content: "" });
}

function codexTodoPlanText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const lines = value.map((todo) => {
    if (!todo || typeof todo !== "object") return null;
    const raw = todo as Record<string, unknown>;
    const text = stringField(raw, "content") ?? stringField(raw, "text") ?? stringField(raw, "title");
    if (!text) return null;
    const status = stringField(raw, "status") ?? "";
    const marker = status === "completed" ? "x" : " ";
    return `- [${marker}] ${text}`;
  }).filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}

function mapUnknownCodexItem(
  eventType: string,
  item: Record<string, unknown>,
  itemType: string | null,
  id: string,
  completedHookAlias: boolean,
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  const status = stringField(item, "status");
  const metadata = codexRuntimeTools.itemMetadata(item, itemType, id);
  const events = ensureTool(state, id, "runtime_item", {
    itemType: itemType ?? "unknown",
    status: status ?? eventType,
  }, metadata);
  if (eventType === "item.completed" || status === "completed") {
    events.push({ type: "tool.completed", ref: id, output: [{ type: "json", value: item }] });
  } else if (codexRuntimeTools.isFailureStatus(status)) {
    const message = errorMessage(item.error);
    events.push({ type: "tool.failed", ref: id, error: message, publicMessage: message, metadata });
  } else if (!completedHookAlias) {
    events.push({ type: "tool.updated", ref: id, status: "running" });
  }
  return events;
}

type PendingCodexFunctionOutput = {
  item: Record<string, unknown>;
  itemType: string;
};

function mapCodexFunctionCallItem(
  eventType: string,
  item: Record<string, unknown>,
  itemType: string,
  id: string,
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  const name = codexRuntimeTools.normalizeToolName(item);
  const input = codexRuntimeTools.parseToolInput(item);
  const rawCallId = stringField(item, "call_id") ?? id;
  const callId = canonicalToolRef(
    state,
    rawCallId,
    codexRuntimeTools.toolIdentity(name, input),
    true
  );
  const metadata = codexRuntimeTools.itemMetadata(item, itemType, callId);
  const events = ensureTool(state, callId, name, input, metadata);
  if (state.completedHookAliases.has(rawCallId)) {
    events.push(...consumePendingCodexFunctionOutputs(state, rawCallId, callId));
    return events;
  }
  const status = stringField(item, "status");
  if (codexRuntimeTools.isFailureStatus(status)) {
    const message = errorMessage(item.error);
    events.push({ type: "tool.failed", ref: callId, error: message, publicMessage: message, metadata });
  } else if (status !== "completed" && eventType !== "item.completed") {
    events.push({ type: "tool.updated", ref: callId, status: "running" });
  }
  events.push(...consumePendingCodexFunctionOutputs(state, rawCallId, callId));
  return events;
}

function mapCodexFunctionCallOutputItem(
  item: Record<string, unknown>,
  itemType: string,
  id: string,
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  const rawCallId = stringField(item, "call_id") ?? id;
  const callId = state.toolRefAliases.get(rawCallId) ?? rawCallId;
  if (state.completedHookAliases.has(rawCallId) || state.completedHookRefs.has(callId)) {
    return codexFunctionOutputEvents(item, itemType, callId);
  }
  if (!state.seenTools.has(callId)) {
    const pending = state.pendingFunctionOutputsByCallId.get(rawCallId) ?? [];
    pending.push({ item, itemType });
    state.pendingFunctionOutputsByCallId.set(rawCallId, pending);
    return [];
  }
  return codexFunctionOutputEvents(item, itemType, callId);
}

function consumePendingCodexFunctionOutputs(
  state: CodexUiStreamState,
  rawCallId: string,
  callId: string
): AiRuntimeEvent[] {
  const pending = state.pendingFunctionOutputsByCallId.get(rawCallId);
  if (!pending) return [];
  state.pendingFunctionOutputsByCallId.delete(rawCallId);
  return pending.flatMap((output) => codexFunctionOutputEvents(output.item, output.itemType, callId));
}

function codexFunctionOutputEvents(
  item: Record<string, unknown>,
  itemType: string,
  callId: string
): AiRuntimeEvent[] {
  const { output, error } = codexRuntimeTools.interpretToolOutput(item, item.output ?? item.result);
  const metadata = codexRuntimeTools.itemMetadata(item, itemType, callId);
  if (error) {
    const events: AiRuntimeEvent[] = output.length > 0
      ? [{ type: "tool.output", ref: callId, output }]
      : [];
    const message = error.message;
    events.push({ type: "tool.failed", ref: callId, error: message, publicMessage: message, metadata });
    return events;
  } else {
    return [{ type: "tool.completed", ref: callId, output }];
  }
}

function isFunctionCallItemType(itemType: string | null): boolean {
  return itemType === "function_call" ||
    itemType === "custom_tool_call" ||
    itemType === "function_call_output" ||
    itemType === "custom_tool_call_output";
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
    return "You are running as a write-capable implementation agent for agent-framework. You may edit files only as required by the provided plan. MCP tools are unavailable; parent-owned workflow code runs check and validation.";
  }
  return "You are running as a read-only validation agent for agent-framework. Do not edit files. Use only read-only inspection. MCP tools are unavailable in this runtime.";
}
