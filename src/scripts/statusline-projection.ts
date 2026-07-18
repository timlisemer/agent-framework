import type { ScenarioRecord } from "../scenario/protocol/records.js";
import { isRecord } from "../utils/output.js";
import { AGENT_FRAMEWORK_RULE_EXTENSION_ID } from "../effects/rule-observability.js";

export type CanonicalRuleStatusLineEntry = {
  evaluationId: string;
  agent: string;
  decision: "APPROVE" | "DENY";
  toolName: string;
  timestamp: number;
  latencyMs?: number;
  status: "running" | "completed";
};

/** Project canonical rule records into the statusline activity vocabulary. */
export function canonicalRuleStatusLineEntries(
  records: readonly ScenarioRecord[],
): CanonicalRuleStatusLineEntry[] {
  const toolNames = commandToolNames(records);
  const newestFirst = records.flatMap((record): CanonicalRuleStatusLineEntry[] => {
    const evaluation = record.eventType === "effect.progressed"
      ? record.payload.progress
      : record.eventType === "extension.observed" &&
          record.payload.extensionId === AGENT_FRAMEWORK_RULE_EXTENSION_ID &&
          typeof record.payload.event === "string" &&
          record.payload.event.startsWith("rule.evaluation.")
        ? record.payload.evaluation
        : undefined;
    if (!isRecord(evaluation)) return [];
    const ruleId = stringValue(evaluation.ruleId);
    const commandId = stringValue(evaluation.commandId);
    const status = stringValue(evaluation.status);
    if (!ruleId || !commandId || !status) return [];
    const result = stringValue(evaluation.result);
    return [{
      evaluationId: stringValue(evaluation.evaluationId) ?? `${commandId}:${ruleId}`,
      agent: ruleId,
      decision: status === "failed" || result === "deny" || result === "block" ? "DENY" : "APPROVE",
      toolName: toolNames.get(commandId) ?? "Hook",
      timestamp: Date.parse(record.recordedAt),
      latencyMs: numberValue(evaluation.elapsedMs),
      status: status === "started" ? "running" : "completed",
    }];
  }).reverse();
  const unique = new Map<string, CanonicalRuleStatusLineEntry>();
  for (const entry of newestFirst) {
    if (!unique.has(entry.evaluationId)) unique.set(entry.evaluationId, entry);
  }
  return [...unique.values()].slice(0, 50);
}

/** Hide superseded running rows and expire completed activity. */
export function filterRuleStatusLineEntries<T extends Pick<
  CanonicalRuleStatusLineEntry,
  "evaluationId" | "timestamp" | "status"
>>(
  entries: readonly T[],
  now = Date.now(),
  completedFadeMs = 5_000,
): T[] {
  const completedEvaluations = new Set(
    entries
      .filter((entry) => entry.status === "completed")
      .map((entry) => entry.evaluationId),
  );
  const running = entries.filter((entry) =>
    entry.status === "running" && !completedEvaluations.has(entry.evaluationId)
  );
  const completed = entries.filter((entry) =>
    entry.status === "completed" && now - entry.timestamp < completedFadeMs
  );
  return [...running, ...completed];
}

function commandToolNames(records: readonly ScenarioRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const record of records) {
    if (record.eventType === "tool.requested") {
      const name = stringValue(record.payload.name);
      if (name) names.set(record.commandId, name);
      continue;
    }
    if (record.eventType !== "command.accepted" || names.has(record.commandId)) continue;
    const command = record.payload.command;
    if (!isRecord(command)) continue;
    const payload = command.payload;
    if (!isRecord(payload)) continue;
    const name = stringValue(payload.name);
    if (name) names.set(record.commandId, name);
  }
  return names;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
