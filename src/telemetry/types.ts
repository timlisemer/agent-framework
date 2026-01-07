import type { ModelTier } from "../types.js";

export type TelemetryEventType =
  | "agent_execution"
  | "hook_decision"
  | "error"
  | "escalation"
  | "commit";

export type DecisionType =
  | "APPROVED"
  | "DENIED"
  | "CONFIRMED"
  | "DECLINED"
  | "OK"
  | "BLOCK"
  | "ALIGNED"
  | "DRIFTED"
  | "UPHOLD"
  | "OVERTURN"
  | "INTERVENE"
  | "DRIFT";

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
  toolName: string;
  workingDir: string;
  latencyMs: number;
  modelTier: ModelTier;
  modelName: string; // Actual model ID (e.g., claude-3-haiku-20240307)
  errorCount: number; // LLM errors (0 if none)
  success: boolean; // true if agent ran without errors

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
