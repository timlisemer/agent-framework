import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCancellationError } from "../utils/cancellation.js";
import { PROVIDER_TYPES } from "./registry.js";
import type { ProviderExecutionResult, ProviderRunInput } from "./execution-types.js";

type CodexConstructor = new (options?: Record<string, unknown>) => {
  startThread(options?: Record<string, unknown>): {
    run(input: string, options?: Record<string, unknown>): Promise<{
      finalResponse?: string;
      usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      } | null;
    }>;
  };
};

export async function runCodexAgent(
  input: ProviderRunInput,
  mode: "direct" | "sdk"
): Promise<ProviderExecutionResult> {
  const { config, prompt, resolvedProvider, options } = input;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-"));

  try {
    copyCodexAuthIfPresent(tempHome);
    const Codex = await loadCodexConstructor();
    const env = buildCodexEnv(tempHome, resolvedProvider.type === PROVIDER_TYPES.OPENAI_SUBSCRIPTION);
    const codex = new Codex({
      env,
      config: buildCodexConfig(tempHome, resolvedProvider.type === PROVIDER_TYPES.OPENROUTER),
    });
    const thread = codex.startThread({
      workingDirectory: config.workingDir ?? process.cwd(),
      skipGitRepoCheck: true,
      model: resolvedProvider.modelId,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
      ...(resolvedProvider.reasoningEffort
        ? { modelReasoningEffort: resolvedProvider.reasoningEffort }
        : {}),
    });

    const fullPrompt = mode === "direct"
      ? `${config.systemPrompt}\n\n${prompt}`
      : `${config.systemPrompt}

You are running as a read-only validation agent for agent-framework. Do not edit files. Use only read-only inspection.

${prompt}`;
    const turn = await thread.run(fullPrompt, { signal: options.signal });
    const usage = turn.usage ? {
      promptTokens: turn.usage.input_tokens,
      cachedTokens: turn.usage.cached_input_tokens,
      completionTokens: turn.usage.output_tokens,
      reasoningTokens: turn.usage.reasoning_output_tokens,
      totalTokens: (turn.usage.input_tokens ?? 0) + (turn.usage.output_tokens ?? 0),
    } : undefined;

    return {
      text: turn.finalResponse ?? "",
      usage,
      provider: resolvedProvider.type,
      modelName: resolvedProvider.modelId,
    };
  } catch (error) {
    if (isCancellationError(error)) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      text: `${mode === "direct" ? "[DIRECT ERROR]" : "[SDK ERROR]"} ${errorMessage}`,
      provider: resolvedProvider.type,
      modelName: resolvedProvider.modelId,
    };
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

async function loadCodexConstructor(): Promise<CodexConstructor> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const mod = await dynamicImport("@openai/codex-sdk") as { Codex?: CodexConstructor };
  if (!mod.Codex) throw new Error("@openai/codex-sdk did not export Codex");
  return mod.Codex;
}

function copyCodexAuthIfPresent(tempHome: string): void {
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sourceAuth = path.join(sourceHome, "auth.json");
  if (fs.existsSync(sourceAuth)) {
    fs.mkdirSync(tempHome, { recursive: true });
    fs.copyFileSync(sourceAuth, path.join(tempHome, "auth.json"));
  }
}

function buildCodexEnv(tempHome: string, openaiSubscription: boolean): Record<string, string> {
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

function buildCodexConfig(tempHome: string, openrouter: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {
    history: { persistence: "none" },
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
