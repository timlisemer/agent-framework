import { z } from "zod";
import { canonicalJsonEqual } from "../scenario/protocol/canonical-json.js";
import { idSchema, jsonValueSchema, type JsonValue } from "../scenario/protocol/common.js";
import type { ScenarioSnapshot } from "../scenario/protocol/snapshot.js";

export const AGENT_FRAMEWORK_RULE_EXTENSION_ID = "agent-framework.rule-pipeline";
export const AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY = "rule.pipeline";

export const ruleDescriptorSchema = z.object({
  ruleId: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  priority: z.number().int(),
  supportedHookEvents: z.array(z.string()),
  appealable: z.boolean(),
  usesLlm: z.boolean(),
  version: z.string().min(1),
  configuration: z.record(z.string(), jsonValueSchema),
}).strict();
export type RuleDescriptor = z.infer<typeof ruleDescriptorSchema>;

export const ruleEvaluationStatusValues = ["started", "skipped", "completed", "failed"] as const;
export type RuleEvaluationStatus = typeof ruleEvaluationStatusValues[number];
export const ruleEvaluationSchema = z.object({
  evaluationId: idSchema,
  ruleId: z.string().min(1),
  commandId: idSchema,
  status: z.enum(ruleEvaluationStatusValues),
  result: z.string().nullable(),
  reason: z.string().nullable(),
  context: z.string().nullable(),
  elapsedMs: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
}).strict();
export type RuleEvaluation = z.infer<typeof ruleEvaluationSchema>;

export const ruleEvaluationStageSchema = z.object({
  eventType: z.enum([
    "rule.gate.requested",
    "rule.gate.completed",
    "rule.appeal.started",
    "rule.appeal.completed",
  ]),
  ruleId: z.string().nullable(),
  payload: z.record(z.string(), jsonValueSchema),
}).strict();
export type RuleEvaluationStage = z.infer<typeof ruleEvaluationStageSchema>;

export const agentFrameworkRulePipelineStateSchema = z.object({
  registry: z.array(ruleDescriptorSchema),
  evaluations: z.array(ruleEvaluationSchema),
}).strict();
export type AgentFrameworkRulePipelineState = z.infer<typeof agentFrameworkRulePipelineStateSchema>;

export function agentFrameworkRulePipelineState(
  snapshot: ScenarioSnapshot,
): AgentFrameworkRulePipelineState {
  const parsed = agentFrameworkRulePipelineStateSchema.safeParse(
    snapshot.stateSlices[AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY]?.value,
  );
  return parsed.success ? parsed.data : { registry: [], evaluations: [] };
}

export function ruleEvaluationEvent(status: RuleEvaluationStatus): string {
  switch (status) {
    case "started": return "rule.evaluation.started";
    case "skipped": return "rule.evaluation.skipped";
    case "failed": return "rule.evaluation.failed";
    case "completed": return "rule.evaluation.completed";
  }
}

export function mergeRulePipelineState(
  baseValue: JsonValue,
  incomingValue: JsonValue,
  currentValue: JsonValue | undefined,
): JsonValue {
  const base = parseRulePipelineState(baseValue);
  const incoming = parseRulePipelineState(incomingValue);
  const current = parseRulePipelineState(currentValue);
  const evaluations = new Map(current.evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]));
  const baseEvaluations = new Map(base.evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]));
  for (const evaluation of incoming.evaluations) {
    const prior = baseEvaluations.get(evaluation.evaluationId);
    if (prior && canonicalJsonEqual(prior, evaluation)) continue;
    evaluations.set(evaluation.evaluationId, evaluation);
  }
  return {
    registry: canonicalJsonEqual(base.registry, incoming.registry)
      ? current.registry
      : incoming.registry,
    evaluations: [...evaluations.values()],
  };
}

function parseRulePipelineState(value: JsonValue | undefined): AgentFrameworkRulePipelineState {
  const parsed = agentFrameworkRulePipelineStateSchema.safeParse(value);
  return parsed.success ? parsed.data : { registry: [], evaluations: [] };
}
