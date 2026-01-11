/**
 * Logger utility for agent telemetry tracking.
 *
 * This module provides the logAgentDecision function which wraps
 * the telemetry tracker with a simplified interface for agent logging.
 */

import { trackAgentExecution, extractDecision } from "./telemetry-tracker.js";
import { getExecutionMode } from "./execution-context.js";
import type { DecisionType } from "../telemetry/types.js";
import {
  MODEL_TIERS,
  EXECUTION_TYPES,
  getModelId,
  type ModelTier,
  type ExecutionType,
  type ProviderType,
} from "../types.js";
import type { AgentExecutionResult } from "./agent-runner.js";

/**
 * Parameters for logging an agent execution.
 */
export interface AgentLog {
  /** Agent name (e.g., "tool-approve", "commit") */
  agent: string;
  /** Hook or MCP tool name */
  hookName: string;
  /** Decision result (APPROVE, DENY, CONFIRM, SUCCESS, ERROR) */
  decision: DecisionType;
  /** Execution type - whether LLM was called or pure TypeScript */
  executionType: ExecutionType;
  /** Tool being evaluated or MCP tool itself */
  toolName: string;
  /** Working directory path */
  workingDir: string;
  /** Operation latency in milliseconds */
  latencyMs: number;
  /** Model tier used (required when executionType="llm") */
  modelTier?: ModelTier;
  /** Whether the agent executed successfully */
  success: boolean;
  /** Number of LLM errors (defaults to 0) */
  errorCount?: number;
  /** Explanation for the decision */
  decisionReason?: string;
  /** Additional data */
  extraData?: Record<string, unknown>;
  /** Token usage - prompt tokens from LLM provider */
  promptTokens?: number;
  /** Token usage - completion tokens from LLM provider */
  completionTokens?: number;
  /** Token usage - total tokens from LLM provider */
  totalTokens?: number;
  /** Token usage - cached prompt tokens */
  cachedTokens?: number;
  /** Token usage - reasoning tokens */
  reasoningTokens?: number;
  /** Cost in USD from LLM provider */
  cost?: number;
  /** OpenRouter generation ID for async cost fetching */
  generationId?: string;
  /** Provider type (openrouter or claude-subscription) */
  provider?: ProviderType;
}

/**
 * Log an agent execution to telemetry.
 *
 * This is the main entry point for logging agent activity.
 * It wraps trackAgentExecution with a consistent interface.
 * Mode is automatically read from the execution context.
 *
 * @example
 * ```typescript
 * logAgentDecision({
 *   agent: "tool-approve",
 *   hookName: "PreToolUse",
 *   decision: "APPROVE",
 *   executionType: "llm",
 *   toolName: "Bash",
 *   workingDir: "/home/user/project",
 *   latencyMs: 150,
 *   modelTier: "haiku",
 *   success: true,
 *   decisionReason: "Command is safe",
 * });
 * ```
 */
export function logAgentDecision(log: AgentLog): void {
  trackAgentExecution({
    agentName: log.agent,
    hookName: log.hookName,
    decision: log.decision,
    mode: getExecutionMode(),
    executionType: log.executionType,
    toolName: log.toolName,
    workingDir: log.workingDir,
    latencyMs: log.latencyMs,
    modelTier: log.modelTier,
    success: log.success,
    errorCount: log.errorCount,
    decisionReason: log.decisionReason,
    extraData: log.extraData,
    promptTokens: log.promptTokens,
    completionTokens: log.completionTokens,
    totalTokens: log.totalTokens,
    cachedTokens: log.cachedTokens,
    reasoningTokens: log.reasoningTokens,
    cost: log.cost,
    generationId: log.generationId,
    provider: log.provider,
  });
}

/**
 * Helper to log an agent execution result with context.
 *
 * Combines AgentExecutionResult with hook/tool context for telemetry.
 * Mode is automatically read from the execution context.
 *
 * @example
 * ```typescript
 * const result = await runAgent(config, input);
 * logAgentResult(result, {
 *   agent: "tool-approve",
 *   hookName: "PreToolUse",
 *   toolName: "Bash",
 *   workingDir: "/home/user/project",
 *   executionType: "llm",
 * });
 * ```
 */
export function logAgentResult(
  result: AgentExecutionResult,
  context: {
    agent: string;
    hookName: string;
    toolName: string;
    workingDir: string;
    executionType: ExecutionType;
    decisionOverride?: DecisionType;
    decisionReason?: string;
    extraData?: Record<string, unknown>;
  }
): void {
  const decision =
    context.decisionOverride ?? extractDecision(result.output) ?? "DENY";

  logAgentDecision({
    agent: context.agent,
    hookName: context.hookName,
    decision,
    executionType: context.executionType,
    toolName: context.toolName,
    workingDir: context.workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: context.decisionReason ?? result.output.slice(0, 1000),
    extraData: context.extraData,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cachedTokens: result.cachedTokens,
    reasoningTokens: result.reasoningTokens,
    cost: result.cost,
    generationId: result.generationId,
    provider: result.provider,
  });
}

/**
 * Log an APPROVE decision (agent approved tool execution).
 * Mode is automatically read from the execution context.
 */
export function logApprove(
  result: AgentExecutionResult,
  agent: string,
  hookName: string,
  toolName: string,
  workingDir: string,
  executionType: ExecutionType,
  reason?: string
): void {
  logAgentDecision({
    agent,
    hookName,
    decision: "APPROVE",
    executionType,
    toolName,
    workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: reason,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cachedTokens: result.cachedTokens,
    reasoningTokens: result.reasoningTokens,
    cost: result.cost,
    generationId: result.generationId,
    provider: result.provider,
  });
}

/**
 * Log a DENY decision (agent blocked tool execution).
 * Mode is automatically read from the execution context.
 */
export function logDeny(
  result: AgentExecutionResult,
  agent: string,
  hookName: string,
  toolName: string,
  workingDir: string,
  executionType: ExecutionType,
  reason: string
): void {
  logAgentDecision({
    agent,
    hookName,
    decision: "DENY",
    executionType,
    toolName,
    workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: reason,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cachedTokens: result.cachedTokens,
    reasoningTokens: result.reasoningTokens,
    cost: result.cost,
    generationId: result.generationId,
    provider: result.provider,
  });
}

/**
 * Log a CONFIRM decision (check/confirm agent validated code).
 * Mode is automatically read from the execution context.
 */
export function logConfirm(
  result: AgentExecutionResult,
  agent: string,
  hookName: string,
  toolName: string,
  workingDir: string,
  executionType: ExecutionType,
  reason?: string
): void {
  logAgentDecision({
    agent,
    hookName,
    decision: "CONFIRM",
    executionType,
    toolName,
    workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: reason,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cachedTokens: result.cachedTokens,
    reasoningTokens: result.reasoningTokens,
    cost: result.cost,
    generationId: result.generationId,
    provider: result.provider,
  });
}

/**
 * Log an ERROR decision (provider error occurred).
 * Mode is automatically read from the execution context.
 */
export function logError(
  result: AgentExecutionResult,
  agent: string,
  hookName: string,
  toolName: string,
  workingDir: string,
  executionType: ExecutionType,
  reason: string
): void {
  logAgentDecision({
    agent,
    hookName,
    decision: "ERROR",
    executionType,
    toolName,
    workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: false,
    errorCount: result.errorCount,
    decisionReason: reason,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cachedTokens: result.cachedTokens,
    reasoningTokens: result.reasoningTokens,
    cost: result.cost,
    generationId: result.generationId,
    provider: result.provider,
  });
}

/**
 * Log a CONTINUE decision (intermediate validation passed, continuing to next check).
 * Mode is automatically read from the execution context.
 */
export function logContinue(
  result: AgentExecutionResult,
  agent: string,
  hookName: string,
  toolName: string,
  workingDir: string,
  executionType: ExecutionType,
  reason?: string
): void {
  logAgentDecision({
    agent,
    hookName,
    decision: "CONTINUE",
    executionType,
    toolName,
    workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: reason,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cachedTokens: result.cachedTokens,
    reasoningTokens: result.reasoningTokens,
    cost: result.cost,
    generationId: result.generationId,
    provider: result.provider,
  });
}

/**
 * Log a fast-path continue for TypeScript-only intermediate decisions.
 *
 * Use this for intermediate validation passes where no LLM was called:
 * - Error-ack "OK" result
 * - Response-align approved
 * - Style-drift approved (before final approval)
 *
 * Creates a synthetic AgentExecutionResult with zero latency
 * and logs it as a CONTINUE with TYPESCRIPT execution type.
 */
export function logFastPathContinue(
  agent: string,
  hookName: string,
  toolName: string,
  workingDir: string,
  reason: string
): void {
  logContinue(
    {
      output: "CONTINUE",
      latencyMs: 0,
      success: true,
      errorCount: 0,
      modelTier: MODEL_TIERS.HAIKU,
      modelName: getModelId(MODEL_TIERS.HAIKU),
    },
    agent,
    hookName,
    toolName,
    workingDir,
    EXECUTION_TYPES.TYPESCRIPT,
    reason
  );
}

/**
 * Log a fast-path approval for TypeScript-only decisions.
 *
 * Use this for early-exit approvals where no LLM was called:
 * - Subagent skips
 * - Empty edit approvals
 * - Trusted file fast-paths
 * - Low-risk tool bypasses
 *
 * Creates a synthetic AgentExecutionResult with zero latency
 * and logs it as an APPROVE with TYPESCRIPT execution type.
 *
 * @example
 * ```typescript
 * // Instead of:
 * logApprove(
 *   { output: "APPROVE", latencyMs: 0, success: true, errorCount: 0,
 *     modelTier: MODEL_TIERS.HAIKU, modelName: getModelId(MODEL_TIERS.HAIKU) },
 *   "response-align", hookName, toolName, workingDir, EXECUTION_TYPES.TYPESCRIPT, "Subagent skip"
 * );
 *
 * // Use:
 * logFastPathApproval("response-align", hookName, toolName, workingDir, "Subagent skip");
 * ```
 */
export function logFastPathApproval(
  agent: string,
  hookName: string,
  toolName: string,
  workingDir: string,
  reason: string
): void {
  logApprove(
    {
      output: "APPROVE",
      latencyMs: 0,
      success: true,
      errorCount: 0,
      modelTier: MODEL_TIERS.HAIKU,
      modelName: getModelId(MODEL_TIERS.HAIKU),
    },
    agent,
    hookName,
    toolName,
    workingDir,
    EXECUTION_TYPES.TYPESCRIPT,
    reason
  );
}

// Re-export for convenience
export { extractDecision };
