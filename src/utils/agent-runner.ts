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

import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getAnthropicClient } from "./anthropic-client.js";
import {
  getModelId,
  type ModelTier,
  type ExecutionType,
  type ProviderType,
  PROVIDER_TYPES,
  MODEL_TIERS,
  resolveProvider,
} from "../types.js";
import { extractTextFromResponse } from "./response-parser.js";
import { logAgentDecision, extractDecision, logAgentStarted } from "./logger.js";
import type { DecisionType } from "../telemetry/types.js";
import {
  abortableDelay,
  isCancellationError,
  linkAbortSignal,
  type CancellationOptions,
  throwIfAborted,
} from "./cancellation.js";

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
interface InternalAgentResult {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
    cost?: number;
  };
  /** OpenRouter generation ID - at top level to survive when usage is undefined */
  generationId?: string;
  /** Provider type used for this execution */
  provider?: ProviderType;
}

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
   * Maps to actual model IDs via getModelId() from types.ts.
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
  /** Provider type used (openrouter or claude-subscription) */
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
 * trackAgentExecution({
 *   agentName: "confirm",
 *   hookName: "mcp__agent-framework__confirm",
 *   decision: extractDecision(result.output) ?? "DECLINED",
 *   toolName: "mcp__agent-framework__confirm",
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
    result =
      config.mode === "sdk"
        ? await runSdkAgent(config, fullPrompt, options)
        : await runDirectAgent(config, fullPrompt, options);

    // Detect error responses
    if (result.text.startsWith("[DIRECT ERROR]") || result.text.startsWith("[SDK ERROR]")) {
      success = false;
      errorCount = 1;
    }

    // Format validation (if configured)
    // Run validation even when success===false from a sentinel error so that
    // [SDK ERROR] / [DIRECT ERROR] outputs are translated into the agent's
    // configured fallbackOutput (e.g. confirm's "## Verdict\nDECLINED:").
    // Without this, sentinel errors leak upward as if they were valid verdicts.
    if (config.formatValidation) {
      const { validator, formatReminder, fallbackOutput } = config.formatValidation;

      if (!validator.test(result.text)) {
        // Skip the retry-tier loop when the input is already a sentinel —
        // a cheaper model cannot reformat "no output received" into a verdict.
        const isSentinelError =
          result.text.startsWith("[DIRECT ERROR]") ||
          result.text.startsWith("[SDK ERROR]");

        if (!isSentinelError) {
          const client = getAnthropicClient();
          const retryTiers = getRetryTiers(config.tier);

          for (const retryTier of retryTiers) {
            const retryResponse = await client.messages.create({
              model: getModelId(retryTier),
              max_tokens: 500,
              messages: [{
                role: "user",
                content: `Invalid format. ${formatReminder}\n\nOriginal output:\n${result.text.slice(0, 2000)}`,
              }],
            }, {
              maxRetries: 0,
              signal: options.signal,
            });
            result.text = extractTextFromResponse(retryResponse);

            if (validator.test(result.text)) break;
          }
        }

        if (!validator.test(result.text)) {
          result.text = fallbackOutput.replace("$RAW", result.text.slice(0, 500));
          success = false;
          errorCount++;
        }
      }
    }
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
    modelName: getModelId(config.tier),
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
  // Resolve provider for direct mode (currently always openrouter)
  const provider = resolveProvider(config.tier, "direct");

  try {
    const client = getAnthropicClient();

    const response = await client.messages.create({
      model: provider.modelId,
      max_tokens: config.maxTokens ?? 2000,
      system: config.systemPrompt,
      messages: [{ role: "user", content: prompt }],
      // OpenRouter: request usage/cost data in response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ usage: { include: true } } as any),
    }, {
      // Disable SDK-level retries — framework's own retry loops (rule-gate,
      // tool-appeal) handle retries with exponential backoff and fresh attempts.
      // SDK retrying internally reuses the same connection pool, which just
      // delays failure surfacing if the connection is broken.
      maxRetries: 0,
      signal: options.signal,
    });

    // Extract usage data from response
    // OpenRouter returns: input_tokens, output_tokens, cache_read_input_tokens
    // OpenAI-compatible returns: prompt_tokens, completion_tokens, total_tokens, cost
    // Anthropic SDK returns: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
    const rawUsage = (response as unknown as { usage?: Record<string, unknown> })
      .usage as Record<string, unknown> | undefined;
    let promptTokens = (rawUsage?.prompt_tokens ?? rawUsage?.input_tokens) as number | undefined;
    let completionTokens = (rawUsage?.completion_tokens ?? rawUsage?.output_tokens) as number | undefined;
    let cachedTokens = (rawUsage?.cache_read_input_tokens as number | undefined) ??
      (rawUsage?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens as number | undefined;
    let reasoningTokens = (rawUsage?.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens as number | undefined;
    // Don't track cost for subscription (included in subscription)
    let cost = provider.type !== PROVIDER_TYPES.CLAUDE_SUBSCRIPTION
      ? (rawUsage?.cost as number | undefined)
      : undefined;

    // Extract generationId from OpenRouter response for async cost fetching
    // Cost will be fetched by the telemetry server asynchronously
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generationId = (response as any).id as string | undefined;

    const usage = rawUsage ? {
      promptTokens,
      completionTokens,
      // Calculate total if not provided
      totalTokens: (rawUsage.total_tokens as number | undefined) ??
        (promptTokens && completionTokens ? promptTokens + completionTokens : undefined),
      cachedTokens: cachedTokens || undefined,
      reasoningTokens: reasoningTokens || undefined,
      cost,
    } : undefined;

    return {
      text: extractTextFromResponse(response),
      usage,
      generationId,  // At top level, independent of usage
      provider: provider.type,
    };
  } catch (error) {
    if (isCancellationError(error)) {
      throw error;
    }
    // Return error as string rather than throwing
    // This allows the caller to handle it gracefully (matches runSdkAgent pattern)
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return { text: `[DIRECT ERROR] ${errorMessage}`, provider: provider.type };
  }
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
  options: CancellationOptions = {}
): Promise<InternalAgentResult> {
  throwIfAborted(options.signal);
  // Validate workingDir for SDK mode
  if (!config.workingDir) {
    throw new Error(`SDK mode requires workingDir for agent '${config.name}'`);
  }

  const provider = resolveProvider(config.tier, "sdk");

  // Prepare environment for subprocess
  // For subscription: pass OAuth token so Claude Code uses subscription auth
  const subprocessEnv = {
    ...process.env,
    // Clear OpenRouter-specific vars for subscription mode
    ...(provider.type === PROVIDER_TYPES.CLAUDE_SUBSCRIPTION
      ? {
          // Don't pass OpenRouter base URL to subprocess
          ANTHROPIC_BASE_URL: undefined,
        }
      : {}),
  };

  // Enhance system prompt with tool guidance
  const enhancedSystemPrompt = `${config.systemPrompt}

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

  // Build tool list: base read-only tools + any extra tools
  const tools = [...SDK_TOOLS, ...(config.extraTools ?? [])];

  // Run a single SDK attempt, returning either a successful result text or
  // the captured diagnostics needed to compose an enriched sentinel.
  const runOnce = async (): Promise<SdkAttemptOutcome> => {
    let stderrBuffer = "";

    // Diagnostics tracked across the for-await loop. These let us produce an
    // enriched "[SDK ERROR] No output received (...)" sentinel when the stream
    // ends without a usable result, and let the retry helper decide whether
    // re-attempting is warranted.
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

    // Accumulate usage across all messages
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;

    try {
      const abortController = new AbortController();
      const unlinkAbortSignal = linkAbortSignal(options.signal, abortController);
      // Create SDK query with configured tools
      try {
        const q = query({
          prompt,
          options: {
            model: provider.modelId,
            cwd: config.workingDir,
            systemPrompt: enhancedSystemPrompt,
            tools,
            allowedTools: tools, // Auto-approve these tools
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: config.maxTurns ?? 10,
            env: subprocessEnv, // Pass env to subprocess (cleared for subscription)
            // SDK 0.2.x spawns a native Claude Code subprocess. Point at the
            // user-installed binary at ~/.local/bin/claude instead of the
            // bundled @anthropic-ai/claude-agent-sdk-linux-x64-musl/claude
            // which isn't present in this deployment.
            pathToClaudeCodeExecutable: `${homedir()}/.local/bin/claude`,
            persistSession: false, // Don't create transcript files for SDK agents
            abortController,
            stderr: (data: string) => {
              // Cap to last 2 KiB so a chatty subprocess can't blow memory.
              stderrBuffer = (stderrBuffer + data).slice(-2048);
            },
          },
        });

        for await (const message of q) {
        messageCount++;
        lastMessageType = message.type;
        const msgAny = message as Record<string, unknown>;

        // api_retry system messages expose transient API retries (added in
        // SDK v0.2.77). Surface counts so the enriched sentinel can show
        // "apiRetries=N/last=<error>".
        if (message.type === "system" && msgAny.subtype === "api_retry") {
          apiRetryCount++;
          if (typeof msgAny.error === "string") {
            lastApiRetryStatus = msgAny.error;
          }
        }

        // Prefer 'result' message type - this is the final output with aggregated data
        if (message.type === "result") {
          lastResultSubtype = (message as { subtype?: string }).subtype;
          if ("is_error" in message && typeof message.is_error === "boolean") {
            lastResultIsError = message.is_error;
          }
          if (
            "terminal_reason" in message &&
            typeof (message as { terminal_reason?: unknown }).terminal_reason === "string"
          ) {
            lastResultTerminalReason = (message as { terminal_reason: string }).terminal_reason;
          }
          if ("errors" in message && Array.isArray((message as { errors?: unknown }).errors)) {
            lastResultErrors = (message as { errors: string[] }).errors;
          }

          // Extract usage from result message (aggregated token counts)
          const resultUsage = msgAny.usage as Record<string, unknown> | undefined;
          if (resultUsage) {
            totalPromptTokens = (resultUsage.input_tokens ?? 0) as number;
            totalCompletionTokens = (resultUsage.output_tokens ?? 0) as number;
            // cache_read_input_tokens from BetaUsage
            totalCachedTokens = (resultUsage.cache_read_input_tokens ?? 0) as number;
          }

          // Extract cached tokens from modelUsage (per-model breakdown)
          // This has cacheReadInputTokens which we sum across all models
          const modelUsage = msgAny.modelUsage as Record<string, Record<string, unknown>> | undefined;
          if (modelUsage && totalCachedTokens === 0) {
            // Sum cacheReadInputTokens across all models
            for (const modelData of Object.values(modelUsage)) {
              if (typeof modelData.cacheReadInputTokens === "number") {
                totalCachedTokens += modelData.cacheReadInputTokens;
              }
            }
          }

          // Only treat the SDKResultSuccess subtype with is_error=false as a
          // real result. Any error subtype (or success+is_error=true) leaves
          // finalResult empty so the enriched sentinel fires.
          if (
            lastResultSubtype === "success" &&
            lastResultIsError !== true &&
            "result" in message &&
            typeof message.result === "string"
          ) {
            finalResult = message.result;
          }
          break;
        }

        // Track assistant messages as fallback - but only if the assistant
        // message itself is not flagged as errored. Per agentSdkTypes.d.ts,
        // SDKAssistantMessage.error is set on rate_limit / server_error /
        // billing_error / etc. Using error-tagged content as fallback would
        // poison lastAssistantContent with partial garbage.
        if (message.type === "assistant") {
          const assistantError = (message as { error?: string }).error;
          if (typeof assistantError === "string" && assistantError.length > 0) {
            lastAssistantError = assistantError;
            continue;
          }

          if ("message" in message) {
            // Handle message object with content
            const msg = message.message;
            if (msg && typeof msg === "object" && "content" in msg) {
              const content = msg.content;
              if (typeof content === "string") {
                lastAssistantContent = content;
              } else if (Array.isArray(content)) {
                // Extract text from content blocks
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
                if (textBlocks.length > 0) {
                  lastAssistantContent = textBlocks.join("\n");
                }
              }
            }
          }
        }
        }
      } finally {
        unlinkAbortSignal();
      }
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        kind: "thrown",
        text: `[SDK ERROR] ${errorMessage}`,
      };
    }

    // Build usage object - include all available token data
    // Note: SDK mode does not track cost (unreliable) or reasoningTokens (not available)
    const hasUsage = totalPromptTokens > 0 || totalCompletionTokens > 0 || totalCachedTokens > 0;
    const usage = hasUsage ? {
      promptTokens: totalPromptTokens || undefined,
      completionTokens: totalCompletionTokens || undefined,
      totalTokens: (totalPromptTokens + totalCompletionTokens) || undefined,
      cachedTokens: totalCachedTokens || undefined,
    } : undefined;

    if (finalResult || lastAssistantContent) {
      return {
        kind: "ok",
        text: finalResult || lastAssistantContent,
        usage,
      };
    }

    // No usable text. Compose enriched sentinel preserving the literal
    // "[SDK ERROR] No output received" prefix so the upstream
    // `startsWith("[SDK ERROR]")` checks (agent-runner.ts:348, :364-366)
    // and the existing test assertion keep working.
    return {
      kind: "noOutput",
      text: composeNoOutputSentinel({
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
      diagnostics: {
        messageCount,
        lastResultSubtype,
        lastResultIsError,
      },
    };
  };

  // First attempt
  const first = await runOnce();
  if (first.kind === "ok") {
    return {
      text: first.text,
      usage: first.usage,
      generationId: undefined,
      provider: provider.type,
    };
  }

  // Decide whether a single in-process retry is warranted. Conditions per the
  // implementation plan:
  //  (a) zero result messages — stream ended without any 'result' frame
  //  (b) lastResultSubtype === "error_during_execution"
  //  (c) lastResultIsError === true on a 'success' subtype
  // Do NOT retry deterministic limits (error_max_turns / error_max_budget_usd /
  // error_max_structured_output_retries) or thrown exceptions.
  let shouldRetry = false;
  if (first.kind === "noOutput") {
    const d = first.diagnostics;
    const sawNoResult = d.lastResultSubtype === undefined;
    const transientErrorSubtype = d.lastResultSubtype === "error_during_execution";
    const isErrorOnSuccess =
      d.lastResultSubtype === "success" && d.lastResultIsError === true;
    shouldRetry = sawNoResult || transientErrorSubtype || isErrorOnSuccess;
  }

  if (!shouldRetry) {
    return {
      text: first.text,
      usage: first.kind === "noOutput" ? first.usage : undefined,
      generationId: undefined,
      provider: provider.type,
    };
  }

  // 250 ms cool-off so any underlying HTTP/2 / TLS state has a chance to tear
  // down — same-tick retries don't fix connection-pool failures.
  await abortableDelay(250, options.signal);

  const second = await runOnce();
  if (second.kind === "ok") {
    return {
      text: second.text,
      usage: second.usage,
      generationId: undefined,
      provider: provider.type,
    };
  }

  // Retry also failed — return the enriched sentinel from the second attempt
  // (or the thrown-error sentinel if the second attempt threw).
  return {
    text: second.text,
    usage: second.kind === "noOutput" ? second.usage : undefined,
    generationId: undefined,
    provider: provider.type,
  };
}

/**
 * Outcome of a single `runOnce` attempt inside `runSdkAgent`.
 *
 * - `ok`: stream produced usable text (either a successful result or a
 *   non-errored assistant fallback).
 * - `noOutput`: stream finished without usable text. Includes the enriched
 *   sentinel and the diagnostics needed by the retry decision.
 * - `thrown`: the SDK call threw. Wraps the error message in the
 *   `[SDK ERROR]` prefix; not eligible for retry.
 */
type SdkAttemptOutcome =
  | {
      kind: "ok";
      text: string;
      usage?: InternalAgentResult["usage"];
    }
  | {
      kind: "noOutput";
      text: string;
      usage?: InternalAgentResult["usage"];
      diagnostics: {
        messageCount: number;
        lastResultSubtype: string | undefined;
        lastResultIsError: boolean | undefined;
      };
    }
  | {
      kind: "thrown";
      text: string;
    };

/**
 * Compose the enriched "[SDK ERROR] No output received" sentinel.
 *
 * The literal prefix MUST be preserved so the upstream sentinel detection at
 * `runAgent` (the `startsWith("[SDK ERROR]")` checks) and the existing test
 * assertion in `tests/utils/agent-runner-sdk-error-fallback.test.ts` continue
 * to work. The parenthetical contains whichever diagnostics are populated,
 * each capped so the line stays scannable.
 */
function composeNoOutputSentinel(diag: {
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

  if (diag.lastResultSubtype !== undefined) {
    parts.push(`subtype=${diag.lastResultSubtype}`);
  }
  if (diag.lastResultIsError !== undefined) {
    parts.push(`isError=${diag.lastResultIsError}`);
  }
  if (diag.lastResultErrors && diag.lastResultErrors.length > 0) {
    const joined = diag.lastResultErrors.slice(0, 3).join(" | ").slice(0, 300);
    parts.push(`errors="${joined}"`);
  }
  if (diag.lastResultTerminalReason !== undefined) {
    parts.push(`terminalReason=${diag.lastResultTerminalReason}`);
  }
  if (diag.apiRetryCount > 0) {
    const status = diag.lastApiRetryStatus ?? "unknown";
    parts.push(`apiRetries=${diag.apiRetryCount}/last=${status}`);
  }
  if (diag.lastAssistantError !== undefined) {
    parts.push(`assistantError=${diag.lastAssistantError}`);
  }
  if (diag.stderrBuffer.length > 0) {
    const tail = diag.stderrBuffer.slice(-200).replace(/\s+/g, " ").trim();
    if (tail.length > 0) {
      parts.push(`stderrTail=${tail}`);
    }
  }

  return `[SDK ERROR] No output received (${parts.join(", ")})`;
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

  const client = getAnthropicClient();
  const contextDesc = context ?? input.prompt.slice(0, 100);

  let decision = initialResult.output;
  let retries = 0;
  let totalErrorCount = initialResult.errorCount;
  // Collect generation IDs from initial + all retry attempts
  const generationIds: string[] = [];
  if (initialResult.generationId) {
    generationIds.push(initialResult.generationId);
  }

  while (!formatValidator(decision) && retries < maxRetries) {
    retries++;

    try {
      const retryResponse = await client.messages.create({
        model: getModelId(config.tier),
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: `Invalid format: "${decision}". You are evaluating: ${contextDesc}. ${formatReminder}`,
          },
        ],
        // OpenRouter: request usage/cost data in response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ usage: { include: true } } as any),
      }, {
        maxRetries: 0,
        signal: options.signal,
      });

      // Capture generation ID from retry response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryGenerationId = (retryResponse as any).id as string | undefined;
      if (retryGenerationId) {
        generationIds.push(retryGenerationId);
      }

      decision = extractTextFromResponse(retryResponse);
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
        modelName: getModelId(config.tier),
        success: false,
        errorCount: totalErrorCount,
        generationId: generationIds.length > 0 ? generationIds.join(",") : undefined,
        provider: initialResult.provider,
      };
    }
  }

  return {
    output: decision,
    latencyMs: Date.now() - startTime,
    modelTier: config.tier,
    modelName: getModelId(config.tier),
    success: true,
    errorCount: totalErrorCount,
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
  telemetry: TelemetryContext
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

  const result = await runAgentWithRetry(config, input, retryOptions);

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
function readLlmStubsFromEnv(): Record<string, string> {
  if (llmStubsCache !== null) return llmStubsCache;
  const raw = process.env.AGENT_FRAMEWORK_LLM_STUBS;
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
