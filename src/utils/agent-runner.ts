/**
 * Agent Runner - Unified Execution for Direct API and Claude SDK Agents
 *
 * This module provides a single interface for executing all agents in the framework,
 * regardless of whether they use direct Anthropic API calls or the Claude SDK for
 * multi-turn agent interactions.
 *
 * ## DESIGN PHILOSOPHY
 *
 * All agents have the same interface: prompt in, text out.
 * The execution mode (direct API vs SDK) is an implementation detail hidden from callers.
 * This allows agents to be easily switched between modes without changing calling code.
 *
 * ## EXECUTION MODES
 *
 * ### 1. DIRECT MODE (default for most agents)
 *
 * Single request/response pattern using the Anthropic API directly.
 *
 * **Use for:**
 * - Hook agents (rule-gate, tool-appeal, error-acknowledge, etc.)
 * - Simple MCP agents that don't need to investigate code
 * - Any agent where speed is critical (<100ms)
 *
 * **Characteristics:**
 * - Fast, predictable, cost-effective
 * - Single API call, no streaming
 * - No tool use - all context passed via prompt
 *
 * ### 2. SDK MODE (for agents needing autonomous investigation)
 *
 * Multi-turn agent interactions using the Claude SDK.
 *
 * **Use for:**
 * - Agents that need to investigate code (confirm.ts)
 * - Agents that benefit from exploring the codebase autonomously
 *
 * **Characteristics:**
 * - Has access to Read and read-only Bash (search/navigation)
 * - Can make multiple turns to investigate
 * - More expensive, but can explore codebase
 * - Uses bypassPermissions mode for autonomous execution
 *
 * ## SECURITY CONSIDERATIONS
 *
 * SDK mode is restricted to Read + classified read-only Bash. SDK tool calls
 * flow through the normal hook and rule pipeline:
 * - Bash is allowed only for read-only search/navigation and safe read-only pipelines
 * - Mutation, execution, and network commands are denied deterministically
 * - No Write/Edit access - prevents file modifications
 * - Git data is passed via prompt rather than gathered via git commands
 *
 * This ensures the SDK agent can investigate but not modify anything.
 *
 * ## USAGE
 *
 * ```typescript
 * import { runAgent } from '../utils/agent-runner.js';
 * import { CHECK_AGENT } from '../utils/agent-configs.js';
 *
 * // Direct mode (default)
 * const result = await runAgent(
 *   { ...CHECK_AGENT, workingDir: '/path/to/project' },
 *   { prompt: 'Analyze this output:', context: linterOutput }
 * );
 *
 * // SDK mode (for confirm agent)
 * const result = await runAgent(
 *   { ...CONFIRM_AGENT, workingDir: '/path/to/project' },
 *   { prompt: 'Evaluate these changes:', context: gitDiff }
 * );
 * ```
 *
 * @module agent-runner
 */

import {
  type ModelTier,
  type ExecutionType,
  type ProviderType,
  MODEL_TIERS,
  resolveProvider,
  resolveProviderForType,
} from "../types.js";
import { logAgentDecision, extractDecision, logAgentStarted } from "./logger.js";
import type { DecisionType } from "../telemetry/types.js";
import {
  isCancellationError,
  type CancellationOptions,
  throwIfAborted,
} from "./cancellation.js";
import { runProviderDirect, runProviderSdk } from "../providers/index.js";
import type { ProviderContinuationState, ProviderExecutionResult } from "../providers/execution-types.js";
import type { SdkRuntimeEnvironment } from "../ai-protocol/index.js";

/**
 * Tools available to SDK mode agents.
 *
 * These tools allow code investigation without modification:
 * - Read: Read file contents
 * - Bash: Classified read-only commands only. The pre-tool-use hook gates
 *   Bash through the normal Bash policy classifier (ls, grep, rg, find,
 *   wc, sort, uniq, cut, tr, head, tail, file, stat, jq, echo, printf,
 *   safe read-only pipelines, and read-only-heavy nix-eval-jobs).
 *   Mutation, execution, build/compile, and network commands are denied deterministically.
 *
 * Glob/Grep were previously listed separately but were removed by
 * Claude Code v2.1.117 on native macOS/Linux builds (search routes through
 * Bash via bundled ugrep/bfs). Git data should be passed via the prompt
 * context rather than gathered via git commands.
 */
const SDK_TOOLS = ["Read", "Bash"] as const;

/**
 * Internal result from agent execution functions.
 * Contains text output and optional usage data from LLM provider.
 */
type InternalAgentResult = ProviderExecutionResult;

/**
 * Configuration for an agent.
 *
 * Defines the agent's identity, model tier, execution mode, and behavior.
 * Configs are typically defined in agent-configs.ts and spread with
 * runtime values like workingDir.
 */
export interface AgentConfig {
  /**
   * Agent name for logging and identification.
   * @example 'confirm', 'check', 'tool-approve'
   */
  name: string;

  /**
   * Model tier to use for this agent.
   * Maps to provider-specific model IDs via provider resolution.
   *
   * Tier selection guidelines:
   * - haiku: Fast tasks, simple validation (<100ms target)
   * - sonnet: Detailed analysis, complex parsing
   * - opus: Complex decisions requiring deep reasoning
   */
  tier: ModelTier;

  /**
   * Execution mode for this agent.
   *
   * - 'direct': Single API call, no tools, fastest
   * - 'sdk': Multi-turn with Read and read-only Bash tools
   */
  mode: "direct" | "sdk";

  /**
   * Whether SDK mode should keep provider-native conversation state across
   * repeated turns from a reusable agent session.
   *
   * Defaults to false. runAgent() remains one-shot; use
   * createContinuableAgentSession() when a caller owns repeated turns.
   */
  continuable?: boolean;

  /**
   * SDK runtime setup to use for providers that support separate isolated and
   * user runtime environments. Defaults to isolated for framework agents.
   */
  sdkRuntimeEnvironment?: SdkRuntimeEnvironment;

  /**
   * System prompt defining agent behavior.
   * Should include output format requirements.
   */
  systemPrompt: string;

  /**
   * Maximum tokens for response.
   * Direct mode: Total response limit
   * SDK mode: Per-turn limit
   * @default 2000
   */
  maxTokens?: number;

  /**
   * Maximum turns for SDK mode.
   * Limits how many tool-use rounds the agent can perform.
   * Ignored in direct mode.
   * @default 10
   */
  maxTurns?: number;

  /**
   * Working directory for SDK mode.
   * Required for SDK mode to know where to run tools.
   * Optional for direct mode (used only for logging).
   */
  workingDir?: string;

  /**
   * Additional tools beyond the SDK defaults.
   *
   * By default, SDK mode has Read and read-only Bash.
   * Use this to enable additional tools like:
   * - 'Task': Allow spawning built-in agents (Explore, Plan, general-purpose)
   * - 'WebFetch': Fetch web content
   * - 'WebSearch': Search the web
   *
   * @example extraTools: ['Task'] // Enable agent spawning
   */
  extraTools?: string[];

  /**
   * Output format validation.
   *
   * If provided, the runner validates output and handles failures:
   * - Direct mode: Uses retryUntilValid() to fix malformed output
   * - SDK mode: Returns fallbackOutput if validation fails (can't retry multi-turn)
   *
   * @example
   * ```typescript
   * formatValidation: {
   *   validator: /## Verdict\s*\n(CONFIRMED|DECLINED)/i,
   *   formatReminder: "Reply with ## Verdict followed by CONFIRMED or DECLINED",
   *   fallbackOutput: "## Verdict\nDECLINED: Malformed output\n\n## Raw\n$RAW",
   * }
   * ```
   */
  formatValidation?: {
    /** Regex to validate output format */
    validator: RegExp;
    /** Message for retry (direct mode only) */
    formatReminder: string;
    /** Fallback output template when validation fails. Use $RAW for raw output snippet. */
    fallbackOutput: string;
  };
}

/**
 * Input to an agent execution.
 *
 * Combines the main prompt with optional context.
 * Context is typically pre-gathered data like git diffs,
 * linter output, or command results.
 */
export interface AgentInput {
  /**
   * The main prompt/instruction for the agent.
   * @example 'Evaluate these code changes:'
   */
  prompt: string;

  /**
   * Additional context to append to the prompt.
   * Separated from prompt by double newline.
   * @example Git diff, linter output, etc.
   */
  context?: string;
}

/**
 * Result of an agent execution.
 *
 * Contains both the output and metadata for telemetry tracking.
 * Callers should use this to track telemetry with full context.
 */
export interface AgentExecutionResult {
  /** The agent's text output */
  output: string;
  /** Operation latency in milliseconds */
  latencyMs: number;
  /** Model tier used */
  modelTier: ModelTier;
  /** Actual model name/ID */
  modelName: string;
  /** Whether the agent executed successfully (no LLM errors) */
  success: boolean;
  /** Number of LLM errors encountered */
  errorCount: number;
  /** Token usage from LLM provider */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  /** Cost in USD from LLM provider */
  cost?: number;
  /** OpenRouter generation ID for async cost fetching */
  generationId?: string;
  /** Provider type used */
  provider?: ProviderType;
}

/**
 * Run an agent with the specified configuration.
 *
 * This is the main entry point for agent execution. It automatically
 * selects the appropriate execution mode based on config.mode and
 * returns execution metadata for telemetry.
 *
 * Note: This function no longer logs telemetry directly. Callers are
 * responsible for tracking telemetry using the returned metadata and
 * their knowledge of hookName/toolName context.
 *
 * @param config - Agent configuration (typically from agent-configs.ts)
 * @param input - Prompt and optional context
 * @returns Execution result with output and metadata
 *
 * @example
 * ```typescript
 * // Using a predefined config
 * const result = await runAgent(
 *   { ...CONFIRM_AGENT, workingDir: cwd },
 *   { prompt: 'Evaluate:', context: diff }
 * );
 *
 * // Track telemetry with full context
 * const confirmMcp = activeSpec().mcpWireName("confirm");
 * trackAgentExecution({
 *   agentName: "confirm",
 *   hookName: confirmMcp,
 *   decision: extractDecision(result.output) ?? "DECLINED",
 *   toolName: confirmMcp,
 *   workingDir: cwd,
 *   latencyMs: result.latencyMs,
 *   modelTier: result.modelTier,
 *   success: result.success,
 *   errorCount: result.errorCount,
 *   decisionReason: result.output.slice(0, 500),
 * });
 * ```
 */
export async function runAgent(
  config: AgentConfig,
  input: AgentInput,
  options: CancellationOptions = {}
): Promise<AgentExecutionResult> {
  throwIfAborted(options.signal);
  const startTime = Date.now();

  // Combine prompt and context
  const fullPrompt = input.context
    ? `${input.prompt}\n\n${input.context}`
    : input.prompt;

  // Execute based on mode
  let result: InternalAgentResult;
  let success = true;
  let errorCount = 0;

  try {
    const executionConfig: AgentConfig =
      config.mode === "sdk" ? { ...config, continuable: false } : config;
    result =
      executionConfig.mode === "sdk"
        ? await runSdkAgent(executionConfig, fullPrompt, options)
        : await runDirectAgent(executionConfig, fullPrompt, options);

    // Detect error responses
    if (result.text.startsWith("[DIRECT ERROR]") || result.text.startsWith("[SDK ERROR]")) {
      success = false;
      errorCount = 1;
    }

    ({ result, success, errorCount } = await applyFormatValidation(
      executionConfig,
      result,
      options,
      success,
      errorCount
    ));
  } catch (error) {
    if (isCancellationError(error)) {
      throw error;
    }
    result = { text: error instanceof Error ? error.message : String(error) };
    success = false;
    errorCount = 1;
  }

  const latencyMs = Date.now() - startTime;

  return {
    output: result.text,
    latencyMs,
    modelTier: config.tier,
    modelName: result.modelName ?? resolveProvider(config.tier, config.mode).modelId,
    success,
    errorCount,
    // Pass through usage data
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
    cachedTokens: result.usage?.cachedTokens,
    reasoningTokens: result.usage?.reasoningTokens,
    cost: result.usage?.cost,
    generationId: result.generationId,
    provider: result.provider,
  };
}

export interface ContinuableAgentSession {
  run(input: AgentInput, options?: CancellationOptions): Promise<AgentExecutionResult>;
  dispose(): Promise<void>;
}

export function createContinuableAgentSession(config: AgentConfig): ContinuableAgentSession {
  return new ContinuableAgentSessionImpl(config);
}

class ContinuableAgentSessionImpl implements ContinuableAgentSession {
  readonly #config: AgentConfig;
  #continuationState: ProviderContinuationState | undefined;
  #disposed = false;

  constructor(config: AgentConfig) {
    this.#config = config;
  }

  async run(input: AgentInput, options: CancellationOptions = {}): Promise<AgentExecutionResult> {
    if (this.#disposed) {
      throw new Error(`Agent session '${this.#config.name}' has been disposed`);
    }
    throwIfAborted(options.signal);
    const fullPrompt = input.context
      ? `${input.prompt}\n\n${input.context}`
      : input.prompt;
    const startTime = Date.now();
    let result: InternalAgentResult;
    let success = true;
    let errorCount = 0;

    try {
      if (this.#config.mode === "sdk") {
        result = await runSdkAgent(this.#config, fullPrompt, options, this.#continuationState);
      } else {
        result = await runDirectAgent(this.#config, fullPrompt, options);
      }
      this.#continuationState = result.continuationState ?? this.#continuationState;
      if (result.text.startsWith("[DIRECT ERROR]") || result.text.startsWith("[SDK ERROR]")) {
        success = false;
        errorCount = 1;
      }
      ({ result, success, errorCount } = await applyFormatValidation(
        this.#config,
        result,
        options,
        success,
        errorCount
      ));
    } catch (error) {
      if (isCancellationError(error)) throw error;
      result = { text: error instanceof Error ? error.message : String(error) };
      success = false;
      errorCount = 1;
    }

    return toAgentExecutionResult(this.#config, result, startTime, success, errorCount);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const dispose = this.#continuationState && "dispose" in this.#continuationState
      ? this.#continuationState.dispose
      : undefined;
    this.#continuationState = undefined;
    if (dispose) await dispose();
  }
}

/**
 * Execute an agent using direct Anthropic API call.
 *
 * This is the fast path for simple agents that don't need tools.
 * Single request/response, no streaming, no tool use.
 *
 * @internal
 * @param config - Agent configuration
 * @param prompt - Full prompt (including any context)
 * @returns Agent's text response with usage data
 */
async function runDirectAgent(
  config: AgentConfig,
  prompt: string,
  options: CancellationOptions = {}
): Promise<InternalAgentResult> {
  throwIfAborted(options.signal);
  const resolvedProvider = resolveProvider(config.tier, "direct");
  return runProviderDirect({
    config: {
      ...config,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
    },
    prompt,
    resolvedProvider,
    options,
  });
}

function mergeRetryResult(
  previous: InternalAgentResult,
  retry: InternalAgentResult
): InternalAgentResult {
  const generationIds = [previous.generationId, retry.generationId]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .join(",");
  return {
    text: retry.text,
    usage: retry.usage ?? previous.usage,
    generationId: generationIds || undefined,
    provider: retry.provider ?? previous.provider,
    modelName: retry.modelName ?? previous.modelName,
  };
}

async function applyFormatValidation(
  config: AgentConfig,
  result: InternalAgentResult,
  options: CancellationOptions,
  success: boolean,
  errorCount: number
): Promise<{
  result: InternalAgentResult;
  success: boolean;
  errorCount: number;
}> {
  // Run validation even when success===false from a sentinel error so that
  // [SDK ERROR] / [DIRECT ERROR] outputs are translated into the agent's
  // configured fallbackOutput (e.g. confirm's "## Verdict\nDECLINED:").
  // Without this, sentinel errors leak upward as if they were valid verdicts.
  if (!config.formatValidation) {
    return { result, success, errorCount };
  }

  const { validator, formatReminder, fallbackOutput } = config.formatValidation;

  if (!validator.test(result.text)) {
    if (config.mode === "sdk" && config.continuable !== true) {
      result.text = fallbackOutput.replace("$RAW", result.text.slice(0, 500));
      success = false;
      errorCount++;
      return { result, success, errorCount };
    }

    // Skip the retry-tier loop when the input is already a sentinel —
    // a cheaper model cannot reformat "no output received" into a verdict.
    const isSentinelError =
      result.text.startsWith("[DIRECT ERROR]") ||
      result.text.startsWith("[SDK ERROR]");

    if (!isSentinelError) {
      const retryTiers = getRetryTiers(config.tier);
      const baseProvider = result.provider ?? resolveProvider(config.tier, "direct").type;

      for (const retryTier of retryTiers) {
        const retryResolved = resolveProviderForType(baseProvider, retryTier, "direct");
        const retryResult = await runProviderDirect({
          config: {
            ...config,
            tier: retryTier,
            maxTokens: 500,
            continuable: false,
            sdkRuntimeEnvironment: "isolated",
          },
          prompt: `Invalid format. ${formatReminder}\n\nOriginal output:\n${result.text.slice(0, 2000)}`,
          resolvedProvider: retryResolved,
          options,
        });
        result = mergeRetryResult(result, retryResult);

        if (validator.test(result.text)) break;
      }
    }

    if (!validator.test(result.text)) {
      result.text = fallbackOutput.replace("$RAW", result.text.slice(0, 500));
      success = false;
      errorCount++;
    }
  }

  return { result, success, errorCount };
}

/**
 * Execute an agent using Claude SDK for multi-turn interactions.
 *
 * This mode gives the agent access to Read and classified read-only Bash
 * for autonomous code investigation. Uses bypassPermissions mode for
 * unattended execution.
 *
 * ## Tool Restrictions
 *
 * The agent is intentionally limited to read-only tools:
 * - Read: View file contents
 * - Bash: Classified read-only commands only (simple inspection,
 *   read-only-heavy evaluation such as nix-eval-jobs, and safe read-only
 *   pipelines). Gated by the pre-tool-use hook via the normal Bash policy.
 *
 * Git data (status/diff/log/show) must be passed via the prompt context
 * rather than gathered via bash git commands -- those are denied by the hook.
 *
 * ## Output Collection
 *
 * The SDK streams messages. Final output is collected from:
 * 1. 'result' message type → message.result field (preferred)
 * 2. Last 'assistant' message content (fallback)
 *
 * @internal
 * @param config - Agent configuration (must have workingDir for SDK mode)
 * @param prompt - Full prompt (including any context)
 * @returns Agent's final text response
 */
async function runSdkAgent(
  config: AgentConfig,
  prompt: string,
  options: CancellationOptions = {},
  continuationState?: ProviderContinuationState
): Promise<InternalAgentResult> {
  throwIfAborted(options.signal);
  if (!config.workingDir) {
    throw new Error(`SDK mode requires workingDir for agent '${config.name}'`);
  }
  const resolvedProvider = resolveProvider(config.tier, "sdk");
  const tools = [...SDK_TOOLS, ...(config.extraTools ?? [])];
  return runProviderSdk({
    config: {
      ...config,
      sdkRuntimeEnvironment: config.sdkRuntimeEnvironment ?? "isolated",
    },
    prompt,
    resolvedProvider,
    options,
    tools,
    continuationState,
  });
}

function toAgentExecutionResult(
  config: AgentConfig,
  result: InternalAgentResult,
  startTime: number,
  success: boolean,
  errorCount: number
): AgentExecutionResult {
  return {
    output: result.text,
    latencyMs: Date.now() - startTime,
    modelTier: config.tier,
    modelName: result.modelName ?? resolveProvider(config.tier, config.mode).modelId,
    success,
    errorCount,
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
    cachedTokens: result.usage?.cachedTokens,
    reasoningTokens: result.usage?.reasoningTokens,
    cost: result.usage?.cost,
    generationId: result.generationId,
    provider: result.provider,
  };
}

/**
 * Options for retry behavior in runAgentWithRetry.
 */
export interface AgentRetryOptions {
  /**
   * Maximum number of retry attempts.
   * @default 2
   */
  maxRetries?: number;

  /**
   * Function to validate if the response format is acceptable.
   * Return true if format is valid, false to trigger retry.
   */
  formatValidator: (text: string) => boolean;

  /**
   * Message to send on retry, reminding the model of expected format.
   */
  formatReminder: string;

  /**
   * Context description for retry messages.
   * @example "Tool approval for Bash command"
   */
  context?: string;

  /**
   * Max tokens for retry requests.
   * @default 100
   */
  maxTokens?: number;
}

/**
 * Run an agent with automatic format retry.
 *
 * Combines runAgent + retryUntilValid into a single call.
 * Use this when you need the agent to output a specific format
 * and want automatic retries if the format is wrong.
 *
 * @param config - Agent configuration
 * @param input - Prompt and optional context
 * @param retryOptions - Format validation and retry settings
 * @returns The execution result with validated response
 *
 * @example
 * ```typescript
 * const result = await runAgentWithRetry(
 *   { ...RULE_GATE_AGENT, workingDir: cwd },
 *   { prompt: 'Evaluate:', context: toolCall },
 *   {
 *     formatValidator: (text) => text.startsWith('APPROVE') || text.startsWith('DENY:'),
 *     formatReminder: 'Reply with EXACTLY: APPROVE or DENY: <reason>',
 *   }
 * );
 * ```
 */
export async function runAgentWithRetry(
  config: AgentConfig,
  input: AgentInput,
  retryOptions: AgentRetryOptions,
  options: CancellationOptions = {}
): Promise<AgentExecutionResult> {
  const startTime = Date.now();

  // Get initial response
  const initialResult = await runAgent(config, input, options);

  // Check if already valid
  if (retryOptions.formatValidator(initialResult.output)) {
    return initialResult;
  }

  // Retry until valid
  const {
    maxRetries = 2,
    formatValidator,
    formatReminder,
    context,
    maxTokens = 100,
  } = retryOptions;

  const contextDesc = context ?? input.prompt.slice(0, 100);

  let decision = initialResult.output;
  let retries = 0;
  let totalErrorCount = initialResult.errorCount;
  let modelName = initialResult.modelName;
  let usage = {
    promptTokens: initialResult.promptTokens,
    completionTokens: initialResult.completionTokens,
    totalTokens: initialResult.totalTokens,
    cachedTokens: initialResult.cachedTokens,
    reasoningTokens: initialResult.reasoningTokens,
    cost: initialResult.cost,
  };
  // Collect generation IDs from initial + all retry attempts
  const generationIds: string[] = [];
  if (initialResult.generationId) {
    generationIds.push(initialResult.generationId);
  }
  const baseProvider = initialResult.provider ?? resolveProvider(config.tier, "direct").type;

  while (!formatValidator(decision) && retries < maxRetries) {
    retries++;

    try {
      const retryResolved = resolveProviderForType(baseProvider, config.tier, "direct");
      const retryResult = await runProviderDirect({
        config: {
          ...config,
          maxTokens,
          continuable: false,
          sdkRuntimeEnvironment: "isolated",
        },
        prompt: `Invalid format: "${decision}". You are evaluating: ${contextDesc}. ${formatReminder}`,
        resolvedProvider: retryResolved,
        options,
      });

      if (retryResult.generationId) {
        generationIds.push(retryResult.generationId);
      }
      decision = retryResult.text;
      modelName = retryResult.modelName ?? modelName;
      usage = {
        promptTokens: retryResult.usage?.promptTokens ?? usage.promptTokens,
        completionTokens: retryResult.usage?.completionTokens ?? usage.completionTokens,
        totalTokens: retryResult.usage?.totalTokens ?? usage.totalTokens,
        cachedTokens: retryResult.usage?.cachedTokens ?? usage.cachedTokens,
        reasoningTokens: retryResult.usage?.reasoningTokens ?? usage.reasoningTokens,
        cost: retryResult.usage?.cost ?? usage.cost,
      };
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      // Return error as string rather than throwing (matches runDirectAgent pattern)
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      totalErrorCount++;
      return {
        output: `[RETRY ERROR] ${errorMessage}`,
        latencyMs: Date.now() - startTime,
        modelTier: config.tier,
        modelName,
        success: false,
        errorCount: totalErrorCount,
        ...usage,
        generationId: generationIds.length > 0 ? generationIds.join(",") : undefined,
        provider: initialResult.provider,
      };
    }
  }

  return {
    output: decision,
    latencyMs: Date.now() - startTime,
    modelTier: config.tier,
    modelName,
    success: true,
    errorCount: totalErrorCount,
    ...usage,
    generationId: generationIds.length > 0 ? generationIds.join(",") : undefined,
    provider: initialResult.provider,
  };
}

/**
 * Context required for automatic telemetry logging.
 *
 * This provides the hook/tool context that the agent runner cannot
 * infer on its own. Combined with AgentExecutionResult metadata,
 * this gives complete telemetry data.
 */
export interface TelemetryContext {
  /** Agent name (e.g., "tool-approve", "commit") */
  agent: string;
  /** Hook or MCP tool name */
  hookName: string;
  /** Tool being evaluated or MCP tool itself */
  toolName: string;
  /** Working directory path */
  workingDir: string;
  /** Execution type - whether LLM was called or pure TypeScript */
  executionType: ExecutionType;
  /** Optional custom reason (defaults to output.slice(0, 1000)) */
  decisionReason?: string;
  /** Force a specific decision type instead of extracting from output */
  decisionOverride?: DecisionType;  // Force CONFIRM for check/confirm agents
}

/**
 * Run an agent with automatic telemetry logging.
 *
 * This is the preferred entry point when you want telemetry to be
 * handled automatically. It wraps runAgent() and logs the decision
 * based on the agent's output, making it impossible to forget telemetry.
 *
 * ## Decision Extraction
 *
 * The decision is automatically extracted from the agent's output using
 * extractDecision(), which recognizes common patterns like:
 * - APPROVE, OK, ALIGNED, SUCCESS → "APPROVE"
 * - DENY, DENIED, BLOCK, UPHOLD → "DENY"
 * - CONFIRM, DECLINED → "CONFIRM"
 * - ERROR → "ERROR"
 *
 * If no decision is extracted, defaults to "DENY" for safety.
 *
 * @param config - Agent configuration (typically from agent-configs.ts)
 * @param input - Prompt and optional context
 * @param telemetry - Context for telemetry logging
 * @returns Execution result with output and metadata
 *
 * @example
 * ```typescript
 * const result = await runAgentWithTelemetry(
 *   { ...RULE_GATE_AGENT, workingDir: cwd },
 *   { prompt: 'Evaluate:', context: toolCall },
 *   {
 *     agent: "rule-gate",
 *     hookName: "PreToolUse",
 *     toolName: "Bash",
 *     workingDir: cwd,
 *     executionType: EXECUTION_TYPES.LLM,
 *   }
 * );
 *
 * // Telemetry is already logged - just use the result
 * if (result.output.startsWith("APPROVE")) {
 *   return { approved: true };
 * }
 * ```
 */
export async function runAgentWithTelemetry(
  config: AgentConfig,
  input: AgentInput,
  telemetry: TelemetryContext
): Promise<AgentExecutionResult> {
  // Mark agent as running in statusline before execution
  logAgentStarted(telemetry.agent, telemetry.toolName);

  const result = await runAgent(config, input);

  // Auto-extract decision from output (APPROVE/DENY/CONFIRM/ERROR)
  const decision = telemetry.decisionOverride ?? extractDecision(result.output) ?? "DENY";

  logAgentDecision({
    agent: telemetry.agent,
    hookName: telemetry.hookName,
    decision,
    executionType: telemetry.executionType,
    toolName: telemetry.toolName,
    workingDir: telemetry.workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    modelName: result.modelName,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: telemetry.decisionReason ?? result.output.slice(0, 1000),
  });

  return result;
}

/**
 * Run an agent with automatic retry and telemetry logging.
 *
 * Combines runAgentWithRetry() and telemetry logging into a single call.
 * Use this when you need format retry behavior alongside automatic telemetry.
 *
 * @param config - Agent configuration (typically from agent-configs.ts)
 * @param input - Prompt and optional context
 * @param retryOptions - Format validation and retry settings
 * @param telemetry - Context for telemetry logging
 * @returns Execution result with output and metadata
 */
export async function runAgentWithRetryAndTelemetry(
  config: AgentConfig,
  input: AgentInput,
  retryOptions: AgentRetryOptions,
  telemetry: TelemetryContext,
  options: CancellationOptions = {},
): Promise<AgentExecutionResult> {
  // Test-harness LLM stub: when AGENT_FRAMEWORK_LLM_STUBS is set and contains
  // a key matching telemetry.agent, synthesize an AgentExecutionResult from
  // the mapped string and skip runAgentWithRetry entirely. This is the
  // LLM-transport boundary — stubbing here covers tool-appeal, rule-gate,
  // style-drift, question-validate, edit-intent, plan-validate, and every
  // other LLM verdict path with a single mechanism. The anti-bypass banner
  // in src/agents/hooks/tool-appeal.ts:1-34 is preserved because tool-appeal
  // itself is untouched.
  const stubs = readLlmStubsFromEnv();
  const stubbedOutput = stubs[telemetry.agent];
  if (typeof stubbedOutput === "string") {
    logAgentStarted(telemetry.agent, telemetry.toolName);
    const decision = telemetry.decisionOverride ?? extractDecision(stubbedOutput) ?? "DENY";
    logAgentDecision({
      agent: telemetry.agent,
      hookName: telemetry.hookName,
      decision,
      executionType: telemetry.executionType,
      toolName: telemetry.toolName,
      workingDir: telemetry.workingDir,
      latencyMs: 0,
      modelTier: MODEL_TIERS.HAIKU,
      modelName: "stub",
      success: true,
      errorCount: 0,
      decisionReason: telemetry.decisionReason ?? stubbedOutput.slice(0, 1000),
    });
    return {
      output: stubbedOutput,
      latencyMs: 0,
      modelTier: MODEL_TIERS.HAIKU,
      modelName: "stub",
      success: true,
      errorCount: 0,
    };
  }

  // Mark agent as running in statusline before execution
  logAgentStarted(telemetry.agent, telemetry.toolName);

  const result = await runAgentWithRetry(config, input, retryOptions, options);

  // Auto-extract decision from output
  const decision = telemetry.decisionOverride ?? extractDecision(result.output) ?? "DENY";

  logAgentDecision({
    agent: telemetry.agent,
    hookName: telemetry.hookName,
    decision,
    executionType: telemetry.executionType,
    toolName: telemetry.toolName,
    workingDir: telemetry.workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    modelName: result.modelName,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: telemetry.decisionReason ?? result.output.slice(0, 1000),
  });

  return result;
}

/**
 * Module-private memoized reader for the AGENT_FRAMEWORK_LLM_STUBS env var.
 * Parses once per process; subsequent calls return the cached map. Throws a
 * descriptive error on malformed JSON so a typo cannot silently no-op into
 * the LLM path. Returns an empty map when the env var is unset.
 */
let llmStubsCache: Record<string, string> | null = null;
let llmStubsCacheRaw: string | undefined;
function readLlmStubsFromEnv(): Record<string, string> {
  const raw = process.env.AGENT_FRAMEWORK_LLM_STUBS;
  if (llmStubsCache !== null && raw === llmStubsCacheRaw) return llmStubsCache;
  llmStubsCacheRaw = raw;
  if (!raw) {
    llmStubsCache = {};
    return llmStubsCache;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AGENT_FRAMEWORK_LLM_STUBS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "AGENT_FRAMEWORK_LLM_STUBS must be a JSON object mapping agent names to stubbed output strings",
    );
  }
  const map: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new Error(
        `AGENT_FRAMEWORK_LLM_STUBS[${JSON.stringify(key)}] must be a string, got ${typeof val}`,
      );
    }
    map[key] = val;
  }
  llmStubsCache = map;
  return llmStubsCache;
}

/**
 * Get retry tiers for format validation failures.
 *
 * Returns progressively cheaper models to try reformatting:
 * - opus → sonnet → haiku → haiku
 * - sonnet → haiku → haiku
 * - haiku → haiku → haiku
 *
 * @param originalTier - The tier that produced malformed output
 * @returns Array of tiers to try for retry
 */
function getRetryTiers(originalTier: ModelTier): ModelTier[] {
  switch (originalTier) {
    case MODEL_TIERS.OPUS:
      return [MODEL_TIERS.SONNET, MODEL_TIERS.HAIKU, MODEL_TIERS.HAIKU];
    case MODEL_TIERS.SONNET:
      return [MODEL_TIERS.HAIKU, MODEL_TIERS.HAIKU];
    case MODEL_TIERS.HAIKU:
    default:
      return [MODEL_TIERS.HAIKU, MODEL_TIERS.HAIKU];
  }
}
