import { trackEvent, getSessionId } from "../telemetry/index.js";
import type { TelemetryEventType } from "../telemetry/index.js";
import type { ModelTier } from "../types.js";

interface AgentLog {
  agent: string;
  level: string;
  problem: string;
  answer: string;
  latencyMs?: number;
  modelTier?: ModelTier;
}

function mapLevelToEventType(level: string): TelemetryEventType {
  switch (level) {
    case "error":
      return "error";
    case "decision":
      return "hook_decision";
    case "escalation":
      return "escalation";
    default:
      return "agent_execution";
  }
}

function extractDecision(answer: string): string | undefined {
  const match = answer.match(
    /^(APPROVED|DENIED|CONFIRMED|DECLINED|OK|BLOCK|DRIFT|INTERVENE|OVERTURN|UPHOLD|ALIGNED|DRIFTED)/
  );
  return match ? match[1] : undefined;
}

export function logToHomeAssistant(log: AgentLog): void {
  trackEvent({
    eventType: mapLevelToEventType(log.level),
    agentName: log.agent,
    sessionId: getSessionId(),
    decision: extractDecision(log.answer),
    decisionReason: log.answer.slice(0, 1000),
    workingDir: log.problem,
    latencyMs: log.latencyMs,
    modelTier: log.modelTier,
  });
}
