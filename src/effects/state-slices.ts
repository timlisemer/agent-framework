import { canonicalJsonEqual } from "../scenario/protocol/canonical-json.js";
import { toJsonValue, type JsonValue } from "../scenario/protocol/common.js";
import type { StateSliceMutation } from "../scenario/protocol/snapshot.js";
import type { ScenarioEffectStateChange } from "../scenario/protocol/effects.js";
import type { ScenarioSnapshot } from "../scenario/protocol/snapshot.js";
import type { ScenarioStateSlicePolicy } from "../scenario/runtime/state-slice-policy.js";
import {
  mergeSessionWorkflowChanges,
  sessionWorkflowStateFromJson,
} from "./session-workflow.js";
import {
  AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY,
  mergeRulePipelineState,
} from "./rule-observability.js";

const initialAgentFrameworkState: readonly StateSliceMutation[] = [
  initialStateChange("session.workflow", "defaulted", {}),
  initialStateChange("gate.reasoning", "uninitialized", null),
  initialStateChange(AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY, "uninitialized", {
    registry: [],
    evaluations: [],
  }),
  initialStateChange("plan.mode", "uninitialized", null),
  initialStateChange("plan.validation", "uninitialized", null),
  initialStateChange("injections", "uninitialized", []),
];

/** Agent Framework composition for state initialization, host projection, and merge policy. */
export const agentFrameworkStateSlicePolicy: ScenarioStateSlicePolicy = {
  initialChanges: () => initialAgentFrameworkState,
  normalize(key, value) {
    return key === "session.workflow"
      ? toJsonValue(sessionWorkflowStateFromJson(value))
      : value;
  },
  merge({ key, baseValue, incomingValue, currentValue }) {
    if (key === "session.workflow") {
      return toJsonValue(mergeSessionWorkflowChanges(
        sessionWorkflowStateFromJson(baseValue),
        sessionWorkflowStateFromJson(incomingValue),
        sessionWorkflowStateFromJson(currentValue),
      ));
    }
    if (key === "gate.reasoning") {
      return toJsonValue(mergeAppendOnlyArray(baseValue, incomingValue, currentValue));
    }
    if (key === AGENT_FRAMEWORK_RULE_PIPELINE_STATE_KEY) {
      return mergeRulePipelineState(baseValue, incomingValue, currentValue);
    }
    return incomingValue;
  },
};

/** Journal gate and appeal stages through an explicit Agent Framework state projection. */
export function gateReasoningStateChange(
  snapshot: ScenarioSnapshot,
  stages: readonly {
    eventType: string;
    payload: Record<string, JsonValue>;
  }[],
): ScenarioEffectStateChange | null {
  if (stages.length === 0) return null;
  const priorValue = snapshot.stateSlices["gate.reasoning"]?.value;
  const prior = Array.isArray(priorValue) ? priorValue : [];
  return agentFrameworkStateChange({
    key: "gate.reasoning",
    schemaId: "agent-framework://state/gate-reasoning",
    source: "rulePipeline.traceProjection",
    baseValue: prior,
    value: [
      ...prior,
      ...stages.map((stage) => ({
        eventType: stage.eventType,
        recordedAt: snapshot.manifest.updatedAt,
        ...stage.payload,
      })),
    ],
  });
}

type AgentFrameworkStateChangeInput = {
  key: string,
  value: unknown,
  source: string,
  schemaId?: string,
  status?: StateSliceMutation["status"],
  baseValue?: unknown,
};

/** Construct every Agent Framework-owned state mutation with one policy envelope. */
export function agentFrameworkStateChange(
  input: AgentFrameworkStateChangeInput,
): StateSliceMutation {
  return {
    key: input.key,
    schemaId: input.schemaId ?? `agent-framework://state/${input.key.replaceAll(".", "-")}`,
    status: input.status ?? "validated",
    source: input.source,
    visibility: "localSensitive",
    value: toJsonValue(input.value),
    ...(input.baseValue === undefined ? {} : { baseValue: toJsonValue(input.baseValue) }),
    diagnostics: [],
  };
}

function initialStateChange(
  key: string,
  status: StateSliceMutation["status"],
  value: JsonValue,
): StateSliceMutation {
  return agentFrameworkStateChange({
    key,
    status,
    value,
    source: "agentFramework.initialStateCatalog",
  });
}

function mergeAppendOnlyArray(
  baseValue: JsonValue,
  incomingValue: JsonValue,
  currentValue: JsonValue | undefined,
): JsonValue[] {
  const base = Array.isArray(baseValue) ? baseValue : [];
  const incoming = Array.isArray(incomingValue) ? incomingValue : [];
  const current = Array.isArray(currentValue) ? currentValue : [];
  const baseIsPrefix = base.every((entry, index) =>
    index < incoming.length && canonicalJsonEqual(entry, incoming[index] as JsonValue)
  );
  return [...current, ...(baseIsPrefix ? incoming.slice(base.length) : incoming)];
}
