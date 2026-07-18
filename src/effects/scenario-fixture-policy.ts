import { canonicalJson } from "../scenario/protocol/canonical-json.js";
import type { JsonValue } from "../scenario/protocol/common.js";
import type {
  FixtureExpectationContext,
  ScenarioFixturePolicy,
} from "../scenario/fixtures/policy.js";
import type { FixtureExpectation } from "../scenario/fixtures/types.js";
import { scenarioTerminalStatusSchema } from "../scenario/runtime/results.js";
import { isRecord } from "../utils/output.js";
import {
  deterministicAgentFrameworkEffect,
  projectAgentFrameworkDeterministicEffect,
} from "./deterministic-effect.js";
import {
  AGENT_FRAMEWORK_HOST_EXTENSION_ID,
  agentFrameworkHostCommandData,
  agentFrameworkHostEvent,
  agentFrameworkHostExtensionHandler,
} from "./host-command.js";
import {
  agentFrameworkEffectPlanner,
  TOOL_POLICY_EFFECT_TYPE,
} from "./rule-pipeline-contract.js";
import { agentFrameworkStateSlicePolicy } from "./state-slices.js";
import { AGENT_FRAMEWORK_RULE_EXTENSION_ID } from "./rule-observability.js";
import { isAgentFrameworkLiveBehaviorCommand } from "./scenario-behavior.js";

/** Agent Framework's application policy for replaying its opaque Scenario extension. */
export const agentFrameworkScenarioFixturePolicy: ScenarioFixturePolicy = {
  effectPlanner: agentFrameworkEffectPlanner,
  extensionHandler: agentFrameworkHostExtensionHandler,
  stateSlicePolicy: agentFrameworkStateSlicePolicy,
  isLiveBehavior({ commands }) {
    return commands.some((command) => {
      const host = agentFrameworkHostCommandData(command.payload);
      return host !== null && isAgentFrameworkLiveBehaviorCommand(host);
    });
  },
  projectLiveExpectations: agentFrameworkLiveBehaviorExpectations,
  defaultUndeclaredEffect(request) {
    if (request.effectType !== TOOL_POLICY_EFFECT_TYPE) return null;
    const effect = deterministicAgentFrameworkEffect(request);
    if (!effect) return null;
    return {
      ...effect,
      metadata: { fixtureDefaultPolicy: true },
    };
  },
  projectDeterministicEffect(request, result) {
    return projectAgentFrameworkDeterministicEffect(request, result);
  },
};

function agentFrameworkLiveBehaviorExpectations({
  records,
  snapshot,
  commands,
}: FixtureExpectationContext) {
  const expectations: FixtureExpectation[] = [];
  if (!records.some(({ record }) => record.eventType === "runtime.error")) {
    expectations.push({ kind: "absentRecord", eventType: "runtime.error" });
  }
  for (const command of commands) {
    const host = agentFrameworkHostCommandData(command.payload);
    if (!host) continue;
    const event = agentFrameworkHostEvent(host);
    if (event === "SessionStart") continue;
    const commandResult = snapshot.commandResults[command.commandId];
    const parsedResult = scenarioTerminalStatusSchema.safeParse(
      isRecord(commandResult) ? commandResult.status : undefined,
    );
    if (parsedResult.success) {
      expectations.push({
        kind: "commandResult",
        commandId: command.commandId,
        status: parsedResult.data,
      });
    }
    const count = records.filter(({ record, payload }) =>
      record.eventType === "extension.observed" &&
      payload.extensionId === AGENT_FRAMEWORK_HOST_EXTENSION_ID &&
      payload.event === event
    ).length;
    expectations.push({
      kind: "record",
      eventType: "extension.observed",
      payloadContains: { extensionId: AGENT_FRAMEWORK_HOST_EXTENSION_ID, event },
      count,
    });
  }
  if (snapshot.stateSlices["host.context"] !== undefined) {
    expectations.push({
      kind: "snapshot",
      path: "/stateSlices/host.context/status",
      equals: snapshot.stateSlices["host.context"].status,
    });
  }
  snapshot.effects.forEach((effect, index) => {
    if (effect.metadata.executor === "agent-framework-rule-pipeline") {
      expectations.push({
        kind: "snapshot",
        path: `/effects/${index}/metadata/executor`,
        equals: "agent-framework-rule-pipeline",
      });
    }
    if (!isRecord(effect.result)) return;
    const kind = effect.result.kind;
    const decision = effect.result.decision;
    if (
      (kind !== "toolPolicyEvaluation" && kind !== "hookRuleEvaluation") ||
      typeof decision !== "string"
    ) return;
    const stableResult: Record<string, JsonValue> = { kind, decision };
    if (kind === "toolPolicyEvaluation" && typeof effect.result.toolCallId === "string") {
      stableResult.toolCallId = effect.result.toolCallId;
      const evaluations = effect.result.evaluations;
      if (Array.isArray(evaluations) && evaluations.length > 0) {
        expectations.push({
          kind: "snapshotArrayMinLength",
          path: `/effects/${index}/result/evaluations`,
          minLength: evaluations.length,
        });
      }
    }
    if (kind === "hookRuleEvaluation" && typeof effect.result.event === "string") {
      stableResult.event = effect.result.event;
    }
    expectations.push({
      kind: "record",
      eventType: "effect.completed",
      payloadContains: { effectId: effect.effectId, result: stableResult },
      count: 1,
    });
  });
  const evaluationCounts = new Map<string, { ruleId: string; result: JsonValue; count: number }>();
  for (const { record, payload } of records) {
    if (
      record.eventType !== "extension.observed" ||
      payload.extensionId !== AGENT_FRAMEWORK_RULE_EXTENSION_ID ||
      payload.event !== "rule.evaluation.completed" ||
      !isRecord(payload.evaluation)
    ) continue;
    const ruleId = payload.evaluation.ruleId;
    const result = payload.evaluation.result;
    if (typeof ruleId !== "string") continue;
    const key = canonicalJson({ ruleId, result });
    const existing = evaluationCounts.get(key);
    if (existing) existing.count += 1;
    else evaluationCounts.set(key, { ruleId, result, count: 1 });
  }
  for (const evaluation of evaluationCounts.values()) {
    expectations.push({
      kind: "record",
      eventType: "extension.observed",
      payloadContains: {
        extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
        event: "rule.evaluation.completed",
        evaluation: { ruleId: evaluation.ruleId, result: evaluation.result },
      },
      count: evaluation.count,
    });
  }
  return expectations;
}
