import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCancellationError } from "../utils/cancellation.js";
import { errorMessage, optionalNumber, outputBlocks, stringField, textOutput } from "../utils/output.js";
import { summarizeToolInputForUi } from "../utils/tool-input-summary.js";
import { PROVIDER_TYPES } from "./registry.js";
import type { ProviderExecutionResult, ProviderRunInput } from "./execution-types.js";
import type { ProviderUsage } from "./execution-types.js";
import type { ResolvedProvider } from "./types.js";
import type { AiRuntimeEvent } from "../ai-backend/runtime-events.js";

export type CodexThreadOptionsConfig = {
  workingDir?: string | null;
};

export type CodexThread = {
  id?: string;
  run(input: string, options?: Record<string, unknown>): Promise<CodexTurn>;
  runStreamed?: (input: string, options?: Record<string, unknown>) => Promise<{ events: AsyncIterable<unknown> }>;
};

export type CodexTurn = {
  finalResponse?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  } | null;
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
};

export function createCodexUiStreamState(): CodexUiStreamState {
  return {
    seenMessages: new Set(),
    seenTools: new Set(),
    seenProcesses: new Set(),
  };
}

type CodexLiveSession = {
  tempHome: string;
  thread: CodexThread;
  dispose(): void;
};

export async function runCodexAgent(
  input: ProviderRunInput,
  mode: "direct" | "sdk"
): Promise<ProviderExecutionResult> {
  const { config, prompt, resolvedProvider, options } = input;
  const continuable = config.continuable === true;
  let createdLiveSession: CodexLiveSession | null = null;

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
        config,
        "agent-framework-codex-"
      ))
      : null;
    const turn = liveSession
      ? await liveSession.thread.run(fullPrompt, { signal: options.signal })
      : await withCodexThread(
        resolvedProvider,
        config,
        "agent-framework-codex-",
        (thread) => thread.run(fullPrompt, { signal: options.signal })
      );

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
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sourceAuth = path.join(sourceHome, "auth.json");
  if (fs.existsSync(sourceAuth)) {
    fs.mkdirSync(tempHome, { recursive: true });
    fs.copyFileSync(sourceAuth, path.join(tempHome, "auth.json"));
  }
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
  persistHistory = true
): Promise<CodexLiveSession> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  try {
    copyCodexAuthIfPresent(tempHome);
    const Codex = await loadCodexConstructor();
    const codex = new Codex({
      env: buildCodexEnv(tempHome, resolvedProvider.type === PROVIDER_TYPES.OPENAI_SUBSCRIPTION),
      config: buildCodexConfig(tempHome, resolvedProvider.type === PROVIDER_TYPES.OPENROUTER, persistHistory),
    });
    const thread = codex.startThread(buildCodexThreadOptions(config, resolvedProvider));
    return {
      tempHome,
      thread,
      dispose: () => fs.rmSync(tempHome, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(tempHome, { recursive: true, force: true });
    throw error;
  }
}

export function buildCodexThreadOptions<T extends CodexThreadOptionsConfig>(
  config: T,
  resolvedProvider: ResolvedProvider
): Record<string, unknown> {
  return {
    workingDirectory: config.workingDir ?? process.cwd(),
    skipGitRepoCheck: true,
    model: resolvedProvider.modelId,
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    webSearchEnabled: false,
    ...(resolvedProvider.reasoningEffort
      ? { modelReasoningEffort: resolvedProvider.reasoningEffort }
      : {}),
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
    return [{ type: "message.completed", ref: "assistant", usage: normalizeCodexAiUsage(raw.usage as CodexTurn["usage"], optionalNumber) }];
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

export function buildCodexEnv(tempHome: string, openaiSubscription: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.CODEX_HOME = tempHome;
  if (openaiSubscription) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.OPENROUTER_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

function mapCodexUiItem(
  eventType: string,
  item: Record<string, unknown>,
  state: CodexUiStreamState
): AiRuntimeEvent[] {
  const itemType = stringField(item, "type");
  const id = stringField(item, "id") ?? `${itemType ?? "item"}-${state.seenTools.size + state.seenProcesses.size + 1}`;
  switch (itemType) {
    case "agent_message": {
      const text = stringField(item, "text") ?? "";
      const ref = "assistant";
      const events: AiRuntimeEvent[] = [];
      if (!state.seenMessages.has(ref)) {
        state.seenMessages.add(ref);
        events.push({ type: "message.created", ref, content: "" });
      }
      if (eventType === "item.completed") {
        events.push({ type: "message.completed", ref, content: text, usage: null });
      } else if (text) {
        events.push({ type: "message.delta", ref, delta: text });
      }
      return events;
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
      const name = "external_tool";
      const status = stringField(item, "status");
      const events = ensureTool(state, id, name, item.arguments);
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
      const events = ensureTool(state, id, "file_edit", { changes: item.changes });
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
      return [];
  }
}

function ensureTool(state: CodexUiStreamState, ref: string, name: string, input: unknown): AiRuntimeEvent[] {
  if (state.seenTools.has(ref)) return [];
  state.seenTools.add(ref);
  return [{ type: "tool.created", ref, name, input: summarizeToolInputForUi(name, input) }];
}

export function buildCodexConfig(
  tempHome: string,
  openrouter: boolean,
  persistHistory = false
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    history: persistHistory ? undefined : { persistence: "none" },
    log_dir: path.join(tempHome, "logs"),
    forced_login_method: openrouter ? undefined : "chatgpt",
  };
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
