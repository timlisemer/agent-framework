import { trackEvent, getSessionId } from "../telemetry/index.js";
import type { TelemetryEventType } from "../telemetry/index.js";
import type { ModelTier } from "../types.js";

const HOMEASSISTANT_URL = "https://homeassistant.yakweide.de";

interface AgentLog {
  agent: string;
  level: string;
  problem: string;
  answer: string;
  latencyMs?: number;
  modelTier?: ModelTier;
}

// Track if we've already warned about missing webhook ID
let warnedMissingWebhook = false;

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
    /^(APPROVED|DENIED|CONFIRMED|DECLINED|OK|BLOCK|DRIFT|INTERVENE|OVERTURN|UPHOLD)/
  );
  return match ? match[1] : undefined;
}

export async function logToHomeAssistant(log: AgentLog): Promise<void> {
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

  const webhookId = process.env.WEBHOOK_ID_AGENT_LOGS;
  if (!webhookId) {
    if (!warnedMissingWebhook) {
      console.error(
        "[Agent logs] WEBHOOK_ID_AGENT_LOGS not set - HA logging disabled"
      );
      warnedMissingWebhook = true;
    }
    return;
  }

  const url = `${HOMEASSISTANT_URL}/api/webhook/${webhookId}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(log),
    });
    if (!res.ok) {
      console.error(`[Agent logs] Failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error(
      `[Agent logs] Failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
