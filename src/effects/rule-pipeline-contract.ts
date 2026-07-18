import { z } from "zod";
import { jsonValueSchema, toJsonValue } from "../scenario/protocol/common.js";
import {
  scenarioEffectProjectionSchema,
  scenarioEffectStateChangeSchema,
  type ScenarioEffectProjection,
  type ScenarioEffectProjectionRecord,
} from "../scenario/protocol/effects.js";
import {
  type ScenarioSnapshot,
} from "../scenario/protocol/snapshot.js";
import type {
  PlannedScenarioEffect,
  ScenarioEffectPlanner,
} from "../scenario/runtime/effects.js";
import {
  AGENT_FRAMEWORK_RULE_EXTENSION_ID,
  AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY,
  agentFrameworkRulePipelineState,
  ruleDescriptorSchema,
  ruleEvaluationEvent,
  ruleEvaluationSchema,
  ruleEvaluationStageSchema,
} from "./rule-observability.js";
import {
  agentFrameworkStateChange,
  gateReasoningStateChange,
} from "./state-slices.js";

export const TOOL_POLICY_EFFECT_TYPE = "rulePipeline.evaluate";
export const HOOK_RULE_EFFECT_TYPE = "rulePipeline.evaluateHook";
export const hookRuleEventValues = ["UserPromptSubmit", "Stop"] as const;
export const hookRuleEventSchema = z.enum(hookRuleEventValues);
export type HookRuleEvent = z.infer<typeof hookRuleEventSchema>;

export const toolPolicyEffectParametersSchema = z.object({
  commandId: z.string().min(1),
  originCommandType: z.enum(["toolRequested", "hostPreToolUse"]),
  toolCallId: z.string().min(1),
  turnId: z.string().nullable(),
  name: z.string().min(1),
  input: jsonValueSchema,
  requiresUserDecision: z.boolean(),
}).strict();
export type ToolPolicyEffectParameters = z.infer<typeof toolPolicyEffectParametersSchema>;

export function planToolPolicyEffect(
  parametersInput: ToolPolicyEffectParameters,
): PlannedScenarioEffect {
  const parameters = toolPolicyEffectParametersSchema.parse(parametersInput);
  return {
    effectId: `policy:${parameters.toolCallId}`,
    effectType: TOOL_POLICY_EFFECT_TYPE,
    parameters: toJsonValue(parameters),
  };
}

export const hookRuleEffectParametersSchema = z.object({
  commandId: z.string().min(1),
  event: hookRuleEventSchema,
}).strict();
export type HookRuleEffectParameters = z.infer<typeof hookRuleEffectParametersSchema>;

export const runtimeStateChangeSchema = scenarioEffectStateChangeSchema;

export { ruleEvaluationStageSchema, type RuleEvaluationStage } from "./rule-observability.js";

export const hookRuleEffectResultSchema = z.object({
  kind: z.literal("hookRuleEvaluation"),
  event: hookRuleEventSchema,
  decision: z.enum(["allow", "block"]),
  reason: z.string().nullable(),
  contextMessage: z.string().nullable(),
  rules: z.array(ruleDescriptorSchema),
  evaluations: z.array(ruleEvaluationSchema),
  stages: z.array(ruleEvaluationStageSchema),
  stateChanges: z.array(runtimeStateChangeSchema),
}).strict();
export type HookRuleEffectResult = z.infer<typeof hookRuleEffectResultSchema>;

export const toolPolicyEffectResultSchema = z.object({
  kind: z.literal("toolPolicyEvaluation"),
  toolCallId: z.string().min(1),
  requiresUserDecision: z.boolean(),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().nullable(),
  agent: z.string().nullable(),
  gateNote: z.string().nullable(),
  rules: z.array(ruleDescriptorSchema),
  evaluations: z.array(ruleEvaluationSchema),
  stages: z.array(ruleEvaluationStageSchema),
  stateChanges: z.array(runtimeStateChangeSchema),
}).strict();
export type ToolPolicyEffectResult = z.infer<typeof toolPolicyEffectResultSchema>;

export function defaultAllowPolicyResult(
  parametersInput: ToolPolicyEffectParameters,
): ToolPolicyEffectResult {
  const parameters = toolPolicyEffectParametersSchema.parse(parametersInput);
  return {
    kind: "toolPolicyEvaluation",
    toolCallId: parameters.toolCallId,
    requiresUserDecision: parameters.requiresUserDecision,
    decision: "allow",
    reason: null,
    agent: "default-policy",
    gateNote: null,
    rules: [],
    evaluations: [],
    stages: [],
    stateChanges: [],
  };
}

export function projectToolPolicyEffect(
  resultInput: unknown,
  snapshot: ScenarioSnapshot,
): ScenarioEffectProjection {
  const result = toolPolicyEffectResultSchema.parse(resultInput);
  const entityRef = { kind: "toolCall", id: result.toolCallId };
  const records: ScenarioEffectProjectionRecord[] = [
    ...sharedRuleProjection(result),
    {
      eventType: "extension.observed",
      entityRef,
      visibility: "localSensitive",
      payload: {
        extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
        event: "rule.gate.completed",
        toolCallId: result.toolCallId,
        decision: result.decision,
        agent: result.agent,
        reason: result.reason,
        gateNote: result.gateNote,
      },
    },
    {
      eventType: "tool.authorization.policyResolved",
      entityRef,
      visibility: "localSensitive",
      payload: {
        toolCallId: result.toolCallId,
        policy: result.decision === "allow" ? "allowed" : "denied",
        reason: result.reason,
      },
    },
  ];
  if (result.decision === "deny") {
    records.push({
      eventType: "tool.authorization.finalResolved",
      entityRef,
      visibility: "localSensitive",
      payload: { toolCallId: result.toolCallId, final: "denied", reason: result.reason },
    });
    return projection(result, records, {
      status: "denied",
      ...(result.reason === null ? {} : { reason: result.reason }),
    }, snapshot);
  }
  if (result.requiresUserDecision && snapshot.capabilities.interactiveToolDecisions) {
    records.push({
      eventType: "tool.authorization.userDecisionPending",
      entityRef,
      visibility: "localSensitive",
      payload: { toolCallId: result.toolCallId },
    });
    return projection(result, records, { status: "userDecisionRequired" }, snapshot);
  }
  if (result.requiresUserDecision) {
    const fallback = snapshot.manifest.configuration.nonInteractiveToolFallback === "allow"
      ? "allowed"
      : "denied";
    records.push(
      {
        eventType: "tool.authorization.userUnavailable",
        entityRef,
        visibility: "localSensitive",
        payload: { toolCallId: result.toolCallId },
      },
      {
        eventType: "tool.authorization.finalResolved",
        entityRef,
        visibility: "localSensitive",
        payload: {
          toolCallId: result.toolCallId,
          final: fallback,
          reason: fallback === "denied" ? "Interactive tool decision is unavailable" : null,
        },
      },
    );
    return projection(result, records, fallback === "allowed"
      ? { status: "allowed" }
      : { status: "denied", reason: "Interactive tool decision is unavailable" }, snapshot);
  }
  records.push({
    eventType: "tool.authorization.finalResolved",
    entityRef,
    visibility: "localSensitive",
    payload: { toolCallId: result.toolCallId, final: "allowed", reason: result.reason },
  });
  return projection(result, records, { status: "allowed" }, snapshot);
}

export function projectHookRuleEffect(
  resultInput: unknown,
  snapshot: ScenarioSnapshot,
): ScenarioEffectProjection {
  const result = hookRuleEffectResultSchema.parse(resultInput);
  return projection(result, sharedRuleProjection(result), result.decision === "block"
    ? {
        status: result.event === "Stop" ? "stopBlocked" : "denied",
        ...(result.reason ? { reason: result.reason } : {}),
      }
    : {
      status: "accepted",
      ...(result.contextMessage ? { data: { contextMessage: result.contextMessage } } : {}),
      }, snapshot);
}

export const agentFrameworkEffectPlanner: ScenarioEffectPlanner = {
  plan(command) {
    const payload = command.payload;
    if (payload.type === "toolRequested") {
      return planToolPolicyEffect({
        commandId: command.commandId,
        originCommandType: payload.type,
        toolCallId: payload.toolCallId,
        turnId: payload.turnId,
        name: payload.name,
        input: payload.input,
        requiresUserDecision: payload.requiresUserDecision,
      });
    }
    return null;
  },
  projectFailure(effect, error) {
    const records: ScenarioEffectProjectionRecord[] = [];
    if (effect.effectType === TOOL_POLICY_EFFECT_TYPE) {
      const parameters = toolPolicyEffectParametersSchema.parse(effect.parameters);
      const entityRef = { kind: "toolCall", id: parameters.toolCallId };
      records.push(
        {
          eventType: "tool.authorization.policyResolved",
          entityRef,
          visibility: "localSensitive",
          payload: { toolCallId: parameters.toolCallId, policy: "failed", reason: error },
        },
        {
          eventType: "tool.authorization.finalResolved",
          entityRef,
          visibility: "localSensitive",
          payload: { toolCallId: parameters.toolCallId, final: "failed", reason: error },
        },
      );
    } else if (effect.effectType !== HOOK_RULE_EFFECT_TYPE) {
      return null;
    }
    return scenarioEffectProjectionSchema.parse({
      records,
      stateChanges: [],
      terminalResult: { status: "failed", reason: error },
    });
  },
};

type SharedRuleProjection = Pick<
  ToolPolicyEffectResult,
  "rules" | "evaluations" | "stages" | "stateChanges"
>;

function sharedRuleProjection(result: SharedRuleProjection): ScenarioEffectProjectionRecord[] {
  return [
    ...result.evaluations.map((evaluation) => ({
      eventType: "extension.observed" as const,
      entityRef: { kind: "ruleEvaluation", id: evaluation.evaluationId },
      visibility: "localSensitive" as const,
      payload: {
        extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
        event: ruleEvaluationEvent(evaluation.status),
        evaluation: toJsonValue(evaluation),
      },
    })),
    ...result.stages.map((stage) => ({
      eventType: "extension.observed" as const,
      ...(stage.ruleId === null ? {} : { entityRef: { kind: "rule", id: stage.ruleId } }),
      visibility: "localSensitive" as const,
      payload: {
        extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
        event: stage.eventType,
        ...stage.payload,
      },
    })),
  ];
}

function projection(
  result: SharedRuleProjection,
  records: ScenarioEffectProjectionRecord[],
  terminalResult: unknown,
  snapshot: ScenarioSnapshot,
): ScenarioEffectProjection {
  const reasoning = gateReasoningStateChange(snapshot, result.stages);
  const priorRuleState = agentFrameworkRulePipelineState(snapshot);
  const evaluations = new Map(
    priorRuleState.evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]),
  );
  for (const evaluation of result.evaluations) evaluations.set(evaluation.evaluationId, evaluation);
  const ruleState = agentFrameworkStateChange({
    key: AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY,
    schemaId: "agent-framework://state/rule-pipeline",
    source: "rulePipeline.effectProjection",
    baseValue: priorRuleState,
    value: { registry: result.rules, evaluations: [...evaluations.values()] },
  });
  return scenarioEffectProjectionSchema.parse({
    records,
    stateChanges: [
      ...result.stateChanges,
      ruleState,
      ...(reasoning === null ? [] : [reasoning]),
    ],
    terminalResult,
  });
}
