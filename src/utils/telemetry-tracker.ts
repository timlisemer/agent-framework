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

  // MCP agents - check for commit-related decisions
  if (decision === "CONFIRMED" || decision === "DECLINED") {
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
 *   decision: "APPROVED",
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
 * Normalize various decision formats to standard DecisionType.
 *
 * Agent outputs may use slightly different formats (e.g., "APPROVE" vs "APPROVED").
 * This function normalizes them to the canonical form.
 */
export function normalizeDecision(raw: string): DecisionType | null {
  const trimmed = raw.trim().toUpperCase();

  // Direct matches
  const directMatches: DecisionType[] = [
    "APPROVED",
    "DENIED",
    "CONFIRMED",
    "DECLINED",
    "OK",
    "BLOCK",
    "ALIGNED",
    "DRIFTED",
    "UPHOLD",
    "OVERTURN",
    "INTERVENE",
    "DRIFT",
  ];

  for (const decision of directMatches) {
    if (trimmed.startsWith(decision)) {
      return decision;
    }
  }

  // Handle short forms
  if (trimmed.startsWith("APPROVE")) return "APPROVED";
  if (trimmed.startsWith("DENY")) return "DENIED";
  if (trimmed.startsWith("CONFIRM")) return "CONFIRMED";
  if (trimmed.startsWith("DECLINE")) return "DECLINED";

  return null;
}

/**
 * Extract decision from agent output text.
 *
 * Agents typically start their output with the decision word.
 * This function extracts and normalizes that decision.
 *
 * @example
 * ```typescript
 * extractDecision("APPROVED - Command is safe") // "APPROVED"
 * extractDecision("DENY: Dangerous operation")  // "DENIED"
 * extractDecision("Some random text")           // null
 * ```
 */
export function extractDecision(text: string): DecisionType | null {
  const firstWord = text.trim().split(/[\s:,\n]/)[0];
  return normalizeDecision(firstWord);
}
