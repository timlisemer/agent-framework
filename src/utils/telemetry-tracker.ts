/**
 * Telemetry Tracker - Centralized agent execution tracking
 *
 * Provides a type-safe API for tracking agent executions with all required fields.
 */

import { trackEvent, getSessionId } from "../telemetry/index.js";
import type {
  TelemetryEvent,
  TelemetryEventType,
  DecisionType,
  TelemetryMode,
} from "../telemetry/types.js";
import { getModelId, type ModelTier } from "../types.js";

/**
 * Parameters for tracking an agent execution.
 */
export interface TrackAgentParams {
  /** Agent name (e.g., "tool-approve", "commit", "check") */
  agentName: string;
  /** Hook or MCP tool name (e.g., "PreToolUse", "mcp__agent-framework__check") */
  hookName: string;
  /** Decision result from the agent */
  decision: DecisionType;
  /** Execution mode (direct or lazy) */
  mode: TelemetryMode;
  /** Tool being evaluated (for hooks) or the MCP tool itself */
  toolName: string;
  /** Working directory path */
  workingDir: string;
  /** Operation latency in milliseconds */
  latencyMs: number;
  /** Model tier used */
  modelTier: ModelTier;
  /** Whether the agent executed successfully (even if it DENIED) */
  success: boolean;
  /** Number of LLM errors encountered (defaults to 0) */
  errorCount?: number;
  /** Explanation for the decision */
  decisionReason?: string;
  /** Additional arbitrary data */
  extraData?: Record<string, unknown>;
}

/**
 * Determine the event type based on hook name and decision.
 */
function determineEventType(
  hookName: string,
  decision: DecisionType,
  success: boolean
): TelemetryEventType {
  // Error events
  if (!success) {
    return "error";
  }

  // Hook decisions
  if (
    hookName === "PreToolUse" ||
    hookName === "PostToolUse" ||
    hookName === "Stop"
  ) {
    return "hook_decision";
  }

  // MCP agents - check for quality decisions
  if (decision === "CONFIRM") {
    return "agent_execution";
  }

  // Default to agent_execution for MCP agents
  return "agent_execution";
}

/**
 * Track an agent execution with all required telemetry fields.
 *
 * This is the main entry point for tracking agent activity. It automatically
 * derives modelName from modelTier and determines the appropriate eventType.
 *
 * @example
 * ```typescript
 * trackAgentExecution({
 *   agentName: "tool-approve",
 *   hookName: "PreToolUse",
 *   decision: "APPROVE",
 *   mode: "direct",
 *   toolName: "Bash",
 *   workingDir: "/home/user/project",
 *   latencyMs: 150,
 *   modelTier: "haiku",
 *   success: true,
 *   decisionReason: "Command is safe",
 * });
 * ```
 */
export function trackAgentExecution(params: TrackAgentParams): void {
  const {
    agentName,
    hookName,
    decision,
    mode,
    toolName,
    workingDir,
    latencyMs,
    modelTier,
    success,
    errorCount = 0,
    decisionReason,
    extraData,
  } = params;

  const event: Omit<TelemetryEvent, "hostId" | "timestamp"> = {
    sessionId: getSessionId(),
    eventType: determineEventType(hookName, decision, success),
    agentName,
    hookName,
    decision,
    mode,
    toolName,
    workingDir,
    latencyMs,
    modelTier,
    modelName: getModelId(modelTier),
    errorCount,
    success,
    decisionReason,
    extraData,
  };

  trackEvent(event);
}

/**
 * Map agent output keywords to telemetry DecisionType.
 *
 * Agent outputs use various keywords (APPROVE, DENY, OK, BLOCK, etc.)
 * that need to be mapped to the telemetry API's decision types.
 */
export function normalizeDecision(raw: string): DecisionType | null {
  const trimmed = raw.trim().toUpperCase();

  // Map to APPROVE
  if (
    trimmed.startsWith("APPROVE") ||
    trimmed.startsWith("OK") ||
    trimmed.startsWith("ALIGNED") ||
    trimmed.startsWith("OVERTURN") ||
    trimmed.startsWith("SUCCESS")
  ) {
    return "APPROVE";
  }

  // Map to DENY
  if (
    trimmed.startsWith("DENY") ||
    trimmed.startsWith("DENIED") ||
    trimmed.startsWith("BLOCK") ||
    trimmed.startsWith("UPHOLD") ||
    trimmed.startsWith("INTERVENE") ||
    trimmed.startsWith("DRIFT")
  ) {
    return "DENY";
  }

  // Map to CONFIRM
  if (
    trimmed.startsWith("CONFIRM") ||
    trimmed.startsWith("DECLINED")
  ) {
    return "CONFIRM";
  }

  // Map to ERROR
  if (trimmed.startsWith("ERROR")) {
    return "ERROR";
  }

  return null;
}

/**
 * Extract decision from agent output text.
 *
 * Agents typically start their output with the decision word.
 * This function extracts and maps it to a telemetry DecisionType.
 *
 * @example
 * ```typescript
 * extractDecision("APPROVED - Command is safe") // "APPROVE"
 * extractDecision("DENY: Dangerous operation")  // "DENY"
 * extractDecision("Some random text")           // null
 * ```
 */
export function extractDecision(text: string): DecisionType | null {
  const firstWord = text.trim().split(/[\s:,\n]/)[0];
  return normalizeDecision(firstWord);
}
