import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCancellationError } from "../utils/cancellation.js";
import { errorMessage, optionalNumber, outputBlocks, stringField, textOutput } from "../utils/output.js";
import { summarizeToolInputForUi } from "../utils/tool-input-summary.js";
import { PROVIDER_TYPES } from "./registry.js";
import type { ProviderExecutionResult, ProviderRunInput, SdkRuntimeEnvironment, SdkRuntimeHome } from "./execution-types.js";
import type { ProviderUsage } from "./execution-types.js";
import type { ResolvedProvider } from "./types.js";
import type { AiRuntimeEvent } from "../ai-backend/runtime-events.js";
import { hashSha256Prefix } from "../utils/hash-utils.js";
import { assertManagedRuntimeHomeConfig, copyCodexAuthToHome, prepareManagedRuntimeHome } from "./managed-runtime-home.js";

export type CodexThreadOptionsConfig = {
  workingDir?: string | null;
  sdkRuntimeEnvironment?: SdkRuntimeEnvironment;
  sdkRuntimeHome?: SdkRuntimeHome;
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
};

export function createCodexUiStreamState(): CodexUiStreamState {
  return {
    seenMessages: new Set(),
    seenTools: new Set(),
    seenProcesses: new Set(),
    assistantText: new Map(),
    assistantReasoning: new Map(),
  };
}

type CodexLiveSession = {
  tempHome: string | null;
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

You are running as a read-only validation agent for agent-framework. Do not edit files. Use only read-only inspection.

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
  const tempHome = runtimeEnvironment === "isolated"
    ? fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix))
    : null;
  try {
    if (tempHome) copyCodexAuthIfPresent(tempHome);
    const Codex = await loadCodexConstructor();
    const codexConfig = buildCodexConfig(
      runtimeEnvironment,
      tempHome,
      resolvedProvider.type === PROVIDER_TYPES.OPENROUTER,
      persistHistory
    );
    const env = buildCodexSessionEnv(
      runtimeEnvironment,
      tempHome,
      resolvedProvider.type === PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      config.sdkRuntimeHome
    );
    const codex = new Codex({
      env,
      ...(codexConfig ? { config: codexConfig } : {}),
    });
    const options = buildCodexThreadOptions(config, resolvedProvider);
    const thread = startOrResumeCodexThread(codex, options, resumeThreadId);
    return {
      tempHome,
      thread,
      dispose: () => {
        if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
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
    ...codexRuntimePolicyOptions(runtimeEnvironment, runtimeExecutionMode),
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

function codexRuntimePolicyOptions(
  runtimeEnvironment: SdkRuntimeEnvironment,
  mode: CodexRuntimeExecutionMode
): Record<string, unknown> {
  if (runtimeEnvironment === "user") return {};
  return {
    sandboxMode: "read-only",
    approvalPolicy: mode === "direct" ? "never" : "on-request",
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

export function buildCodexEnv(
  runtimeEnvironment: SdkRuntimeEnvironment,
  tempHome: string | null,
  openaiSubscription: boolean
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (openaiSubscription) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.OPENROUTER_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  if (runtimeEnvironment === "user") return env;
  if (!tempHome) throw new Error("Isolated Codex runtime requires a temporary home");
  env.CODEX_HOME = tempHome;
  return env;
}

export function buildCodexSessionEnv(
  runtimeEnvironment: SdkRuntimeEnvironment,
  tempHome: string | null,
  openaiSubscription: boolean,
  sdkRuntimeHome: CodexThreadOptionsConfig["sdkRuntimeHome"]
): Record<string, string> {
  const env = buildCodexEnv(runtimeEnvironment, tempHome, openaiSubscription);
  if (sdkRuntimeHome !== "managedAstral") return env;
  assertManagedRuntimeHomeConfig({ sdkRuntimeHome, sdkRuntimeEnvironment: runtimeEnvironment });
  return prepareManagedRuntimeHome("codex", env).env as Record<string, string>;
}

function mapCodexUiItem(
  eventType: string,
  item: Record<string, unknown>,
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  const itemType = stringField(item, "type");
  const id = stringField(item, "id") ?? syntheticCodexItemRef(itemType, item);
  switch (itemType) {
    case "agent_message": {
      const text = stringField(item, "text") ?? "";
      const ref = stringField(item, "id") ?? syntheticCodexItemRef(itemType, item);
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
      const ref = stringField(item, "id") ?? syntheticCodexItemRef(itemType, item);
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
      const events = ensureTool(state, id, "shell", { command });
      if (status === "completed") {
        events.push({ type: "tool.completed", ref: id, output: output ? textOutput(output) : [] });
      } else if (status === "failed") {
        if (output) events.push({ type: "tool.output", ref: id, output: textOutput(output) });
        events.push({ type: "tool.failed", ref: id, error: "Operation failed" });
      } else {
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
      const events = ensureTool(state, id, name, { server, tool, arguments: item.arguments });
      if (status === "completed") {
        events.push({ type: "tool.completed", ref: id, output: outputBlocks(item.result) });
      } else if (status === "failed") {
        events.push({ type: "tool.failed", ref: id, error: errorMessage(item.error) });
      } else {
        events.push({ type: "tool.updated", ref: id, status: "running" });
      }
      return events;
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => change && typeof change === "object" ? stringField(change as Record<string, unknown>, "path") : null)
        .filter((path): path is string => Boolean(path));
      const events = ensureTool(state, id, "file_edit", {
        changes: item.changes,
        changeCount: changes.length,
        files: paths.slice(0, 3).join(", "),
        path: paths[0] ?? null,
      });
      const status = stringField(item, "status");
      if (status === "failed") {
        events.push({ type: "tool.failed", ref: id, error: "File change failed" });
      } else if (status === "completed" || eventType === "item.completed") {
        events.push({ type: "tool.completed", ref: id, output: outputBlocks(item.changes) });
      } else {
        events.push({ type: "tool.updated", ref: id, status: "running" });
      }
      return events;
    }
    case "web_search": {
      const events = ensureTool(state, id, "search", { query: item.query });
      if (eventType === "item.completed") {
        events.push({ type: "tool.completed", ref: id, output: [] });
      } else {
        events.push({ type: "tool.updated", ref: id, status: "running" });
      }
      return events;
    }
    case "error":
      return [{ type: "error", error: stringField(item, "message") ?? "Runtime item error" }];
    default:
      return mapUnknownCodexItem(eventType, item, itemType, id, state);
  }
}

function ensureTool(state: CodexUiStreamState, ref: string, name: string, input: unknown): AiRuntimeEvent[] {
  if (state.seenTools.has(ref)) return [];
  state.seenTools.add(ref);
  return [{ type: "tool.created", ref, name, input: summarizeToolInputForUi(name, input) }];
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
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  const status = stringField(item, "status");
  const events = ensureTool(state, id, "runtime_item", {
    itemType: itemType ?? "unknown",
    status: status ?? eventType,
  });
  if (eventType === "item.completed" || status === "completed") {
    events.push({ type: "tool.completed", ref: id, output: [{ type: "json", value: item }] });
  } else if (status === "failed" || status === "error") {
    events.push({ type: "tool.failed", ref: id, error: errorMessage(item.error) });
  } else {
    events.push({ type: "tool.updated", ref: id, status: "running" });
  }
  return events;
}

function syntheticCodexItemRef(itemType: string | null, item: Record<string, unknown>): string {
  const stableItem = stableCodexItemPayload(itemType, item);
  const canonical = canonicalJson(stableItem);
  const hash = hashSha256Prefix(canonical, 12);
  return `${itemType ?? "item"}:${hash}`;
}

function stableCodexItemPayload(itemType: string | null, item: Record<string, unknown>): Record<string, unknown> {
  switch (itemType) {
    case "command_execution":
      return { type: itemType, command: item.command };
    case "mcp_tool_call":
      return { type: itemType, server: item.server, tool: item.tool, arguments: item.arguments };
    case "file_change":
      return { type: itemType, changes: item.changes };
    case "web_search":
      return { type: itemType, query: item.query };
    default: {
      const stable: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(item)) {
        if (["status", "text", "summary", "aggregated_output", "result", "error", "progress"].includes(key)) continue;
        stable[key] = value;
      }
      return stable;
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

export function buildCodexConfig(
  runtimeEnvironment: SdkRuntimeEnvironment,
  tempHome: string | null,
  openrouter: boolean,
  persistHistory = false
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {
    show_raw_agent_reasoning: true,
  };
  if (runtimeEnvironment === "isolated") {
    if (!tempHome) throw new Error("Isolated Codex runtime requires a temporary home");
    if (!persistHistory) config.history = { persistence: "none" };
    config.log_dir = path.join(tempHome, "logs");
    if (!openrouter) config.forced_login_method = "chatgpt";
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
