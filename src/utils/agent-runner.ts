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
 * - Hook agents (tool-approve, tool-appeal, error-acknowledge, etc.)
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
 * - Has access to Read, Glob, Grep tools (read-only)
 * - Can make multiple turns to investigate
 * - More expensive, but can explore codebase
 * - Uses bypassPermissions mode for autonomous execution
 *
 * ## SECURITY CONSIDERATIONS
 *
 * SDK mode is restricted to read-only tools (Read, Glob, Grep):
 * - No Bash access - prevents unintended command execution
 * - No Write/Edit access - prevents file modifications
 * - Git data is passed via prompt, not gathered by agent
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

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getAnthropicClient } from "./anthropic-client.js";
import { getModelId, type ModelTier, type ExecutionType } from "../types.js";
import { extractTextFromResponse } from "./response-parser.js";
import { logAgentDecision, extractDecision } from "./logger.js";

/**
 * Read-only tools available to SDK mode agents.
 *
 * These tools allow code investigation without modification:
 * - Read: Read file contents
 * - Glob: Find files by pattern
 * - Grep: Search file contents
 *
 * Bash is explicitly NOT included to prevent command execution.
 * Git data should be passed via the prompt context instead.
 */
const SDK_TOOLS = ["Read", "Glob", "Grep"] as const;

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
   * - 'sdk': Multi-turn with Read/Glob/Grep tools
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
   * Additional tools beyond read-only for SDK mode.
   *
   * By default, SDK mode only has Read/Glob/Grep (read-only).
   * Use this to enable additional tools like:
   * - 'Task': Allow spawning built-in subagents (Explore, Plan, general-purpose)
   * - 'WebFetch': Fetch web content
   * - 'WebSearch': Search the web
   *
   * @example extraTools: ['Task'] // Enable subagent spawning
   */
  extraTools?: string[];
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
  input: AgentInput
): Promise<AgentExecutionResult> {
  const startTime = Date.now();

  // Combine prompt and context
  const fullPrompt = input.context
    ? `${input.prompt}\n\n${input.context}`
    : input.prompt;

  // Execute based on mode
  let output: string;
  let success = true;
  let errorCount = 0;

  try {
    output =
      config.mode === "sdk"
        ? await runSdkAgent(config, fullPrompt)
        : await runDirectAgent(config, fullPrompt);

    // Detect error responses
    if (output.startsWith("[DIRECT ERROR]") || output.startsWith("[SDK ERROR]")) {
      success = false;
      errorCount = 1;
    }
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    success = false;
    errorCount = 1;
  }

  const latencyMs = Date.now() - startTime;

  return {
    output,
    latencyMs,
    modelTier: config.tier,
    modelName: getModelId(config.tier),
    success,
    errorCount,
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
 * @returns Agent's text response
 */
async function runDirectAgent(
  config: AgentConfig,
  prompt: string
): Promise<string> {
  try {
    const client = getAnthropicClient();

    const response = await client.messages.create({
      model: getModelId(config.tier),
      max_tokens: config.maxTokens ?? 2000,
      system: config.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    return extractTextFromResponse(response);
  } catch (error) {
    // Return error as string rather than throwing
    // This allows the caller to handle it gracefully (matches runSdkAgent pattern)
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return `[DIRECT ERROR] ${errorMessage}`;
  }
}

/**
 * Execute an agent using Claude SDK for multi-turn interactions.
 *
 * This mode gives the agent access to read-only tools (Read, Glob, Grep)
 * for autonomous code investigation. Uses bypassPermissions mode for
 * unattended execution.
 *
 * ## Tool Restrictions
 *
 * The agent is intentionally limited to read-only tools:
 * - Read: View file contents
 * - Glob: Find files by pattern
 * - Grep: Search file contents
 *
 * Bash is NOT available - any command data (git status, git diff, etc.)
 * must be passed via the prompt context.
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
  prompt: string
): Promise<string> {
  // Validate workingDir for SDK mode
  if (!config.workingDir) {
    throw new Error(`SDK mode requires workingDir for agent '${config.name}'`);
  }

  // Enhance system prompt with tool guidance
  const enhancedSystemPrompt = `${config.systemPrompt}

## TOOLS AVAILABLE

You have access to these read-only tools for investigating code:
- **Read**: Read file contents to understand context
- **Glob**: Find files by pattern (e.g., "src/**/*.ts")
- **Grep**: Search file contents for patterns

Use these tools when you need to:
- Understand context around changed code
- Verify patterns are followed consistently
- Check if documentation matches implementation

Do NOT use Bash - git data is already provided in the prompt.
Your final response should be your complete analysis in the required format.`;

  try {
    // Build tool list: base read-only tools + any extra tools
    const tools = [...SDK_TOOLS, ...(config.extraTools ?? [])];

    // Create SDK query with configured tools
    const q = query({
      prompt,
      options: {
        model: getModelId(config.tier),
        cwd: config.workingDir,
        systemPrompt: enhancedSystemPrompt,
        tools,
        allowedTools: tools, // Auto-approve these tools
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: config.maxTurns ?? 10,
      },
    });

    // Collect output from streaming response
    let finalResult = "";
    let lastAssistantContent = "";

    for await (const message of q) {
      // Prefer 'result' message type - this is the final output
      if (message.type === "result") {
        if ("result" in message && typeof message.result === "string") {
          finalResult = message.result;
        }
        break;
      }

      // Track assistant messages as fallback
      if (message.type === "assistant") {
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

    // Return result, falling back to last assistant content
    return finalResult || lastAssistantContent || "[SDK ERROR] No output received";
  } catch (error) {
    // Return error as string rather than throwing
    // This allows the caller to handle it gracefully
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return `[SDK ERROR] ${errorMessage}`;
  }
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
 *   { ...TOOL_APPROVE_AGENT, workingDir: cwd },
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
  retryOptions: AgentRetryOptions
): Promise<AgentExecutionResult> {
  const startTime = Date.now();

  // Get initial response
  const initialResult = await runAgent(config, input);

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
      });

      decision = extractTextFromResponse(retryResponse);
    } catch (error) {
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
 *   { ...TOOL_APPROVE_AGENT, workingDir: cwd },
 *   { prompt: 'Evaluate:', context: toolCall },
 *   {
 *     agent: "tool-approve",
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
  const result = await runAgent(config, input);

  // Auto-extract decision from output (APPROVE/DENY/CONFIRM/ERROR)
  const decision = extractDecision(result.output) ?? "DENY";

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
