import { scenarioSnapshotSchema } from "../scenario/protocol/snapshot.js";
import type {
  ScenarioEffectRequest,
  ScenarioEffectResult,
} from "../scenario/runtime/effects.js";
import { recordFromUnknown } from "../utils/output.js";
import {
  defaultAllowPolicyResult,
  hookRuleEffectParametersSchema,
  hookRuleEffectResultSchema,
  HOOK_RULE_EFFECT_TYPE,
  projectHookRuleEffect,
  projectToolPolicyEffect,
  toolPolicyEffectParametersSchema,
  TOOL_POLICY_EFFECT_TYPE,
  type ToolPolicyEffectParameters,
  type ToolPolicyEffectResult,
} from "./rule-pipeline-contract.js";

export type DeterministicAgentFrameworkEffectOptions = {
  transformToolResult?: (
    result: ToolPolicyEffectResult,
    parameters: ToolPolicyEffectParameters,
    request: ScenarioEffectRequest,
  ) => ToolPolicyEffectResult;
};

/** Interpret one deterministic Agent Framework effect through the production projection contract. */
export function deterministicAgentFrameworkEffect(
  request: ScenarioEffectRequest,
  options: DeterministicAgentFrameworkEffectOptions = {},
): ScenarioEffectResult | null {
  const execution = recordFromUnknown(request.executionContext);
  const snapshot = scenarioSnapshotSchema.parse(execution.snapshot);
  const parameters = execution.parameters ?? request.parameters;
  if (request.effectType === TOOL_POLICY_EFFECT_TYPE) {
    const parsedParameters = toolPolicyEffectParametersSchema.parse(parameters);
    const defaultResult = defaultAllowPolicyResult(parsedParameters);
    const result = options.transformToolResult?.(defaultResult, parsedParameters, request) ?? defaultResult;
    return { result, projection: projectToolPolicyEffect(result, snapshot) };
  }
  if (request.effectType === HOOK_RULE_EFFECT_TYPE) {
    const parsedParameters = hookRuleEffectParametersSchema.parse(parameters);
    const result = hookRuleEffectResultSchema.parse({
      kind: "hookRuleEvaluation",
      event: parsedParameters.event,
      decision: "allow",
      reason: null,
      contextMessage: null,
      rules: [],
      evaluations: [],
      stages: [],
      stateChanges: [],
    });
    return { result, projection: projectHookRuleEffect(result, snapshot) };
  }
  return null;
}

/** Project a stored deterministic result with the same context precedence used by execution. */
export function projectAgentFrameworkDeterministicEffect(
  request: ScenarioEffectRequest,
  result: unknown,
): ScenarioEffectResult["projection"] | undefined {
  const execution = recordFromUnknown(request.executionContext);
  const snapshot = scenarioSnapshotSchema.parse(execution.snapshot);
  if (request.effectType === TOOL_POLICY_EFFECT_TYPE) {
    return projectToolPolicyEffect(result, snapshot);
  }
  if (request.effectType === HOOK_RULE_EFFECT_TYPE) {
    return projectHookRuleEffect(result, snapshot);
  }
  return undefined;
}
