import type { ModelTier } from "../types.js";

export type TelemetryEventType =
  | "agent_execution"
  | "hook_decision"
  | "error"
  | "escalation"
  | "commit";

export interface TelemetryEvent {
  hostId: string;
  sessionId: string;
  eventType: TelemetryEventType;
  agentName: string;
  timestamp: string;
  decision?: string;
  decisionReason?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  workingDir?: string;
  latencyMs?: number;
  modelTier?: ModelTier;
  errorCount?: number;
  warningCount?: number;
  extraData?: Record<string, unknown>;
}

export interface TelemetryConfig {
  endpoint: string;
  apiKey: string;
  hostId: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  enableHomeAssistant?: boolean;
}

export interface BatchTelemetryRequest {
  events: TelemetryEvent[];
}

export interface BatchTelemetryResponse {
  accepted: number;
}
