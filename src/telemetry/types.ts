import type { ModelTier, TelemetryMode, ExecutionType } from "../types.js";

// Re-export for convenience
export type { TelemetryMode, ExecutionType };

export type TelemetryEventType =
  | "agent_execution"
  | "hook_decision"
  | "error"
  | "escalation"
  | "commit";

/**
 * Decision types expected by the telemetry API.
 * - APPROVE: Agent approved tool execution (final decision)
 * - CONTINUE: Intermediate validation passed, continuing to next check
 * - DENY: Agent blocked tool execution
 * - CONFIRM: Check/confirm agent validated code
 * - SUCCESS: Operation completed without errors
 * - ERROR: Provider error occurred (API failures, etc.)
 */
export type DecisionType = "APPROVE" | "CONTINUE" | "DENY" | "CONFIRM" | "SUCCESS" | "ERROR";

/**
 * Telemetry event matching the new API spec.
 *
 * Key concept: success=true even for DENIED decisions.
 * Success tracks agent execution, not approval outcome.
 */
export interface TelemetryEvent {
  // Required fields
  hostId: string;
  sessionId: string;
  eventType: TelemetryEventType;
  agentName: string;
  hookName: string; // "PreToolUse" | "PostToolUse" | "Stop" | MCP tool name
  decision: DecisionType;
  mode: TelemetryMode; // Execution mode (direct or lazy)
  executionType: ExecutionType; // Whether LLM was called or pure TypeScript
  toolName: string;
  workingDir: string;
  latencyMs: number;
  errorCount: number; // LLM errors (0 if none)
  success: boolean; // true if agent ran without errors

  // Required only when executionType="llm"
  modelTier?: ModelTier;
  modelName?: string; // Actual model ID (e.g., claude-3-haiku-20240307)

  // Token usage (only for executionType="llm")
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;

  // Cost tracking (USD)
  cost?: number;

  // Client version (e.g., "1.0.42")
  clientVersion?: string;

  // Optional fields
  timestamp?: string; // ISO 8601, defaults to server time
  decisionReason?: string;
  extraData?: Record<string, unknown>;
}

export interface TelemetryConfig {
  endpoint: string;
  apiKey: string;
  hostId: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
}

export interface BatchTelemetryRequest {
  events: TelemetryEvent[];
}

export interface BatchTelemetryResponse {
  accepted: number;
}
