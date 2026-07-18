import type {
  ScenarioRuntime,
  ScenarioRuntimeOptions,
} from "../../src/scenario/runtime/runtime.js";
import type {
  ScenarioEffectExecutor,
  ScenarioEffectRequest,
} from "../../src/scenario/runtime/effects.js";
import {
  type ToolPolicyEffectParameters,
  type ToolPolicyEffectResult,
} from "../../src/effects/rule-pipeline-contract.js";
import { deterministicAgentFrameworkEffect } from "../../src/effects/deterministic-effect.js";
import { createAgentFrameworkScenarioRuntime } from "../../src/effects/scenario-runtime-factory.js";
import type { JsonValue } from "../../src/scenario/protocol/common.js";

export type DeterministicPolicyExecutorOptions = {
  transformToolResult?: (
    result: ToolPolicyEffectResult,
    parameters: ToolPolicyEffectParameters,
    request: ScenarioEffectRequest,
  ) => ToolPolicyEffectResult;
  metadata?: Record<string, JsonValue>;
};

/** Build the canonical deterministic policy executor used by Scenario tests. */
export function createDeterministicPolicyExecutor(
  options: DeterministicPolicyExecutorOptions = {},
): ScenarioEffectExecutor {
  return {
    async execute(request: ScenarioEffectRequest) {
      const effect = deterministicAgentFrameworkEffect(request, {
        ...(options.transformToolResult === undefined
          ? {}
          : { transformToolResult: options.transformToolResult }),
      });
      if (!effect) {
      throw new Error(`Unsupported scenario effect: ${request.effectType}`);
      }
      return {
        ...effect,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      };
    },
  };
}

const allowingPolicyExecutor = createDeterministicPolicyExecutor();

/** Construct a Scenario runtime whose empty rule pipeline explicitly allows policy effects. */
export function createTestScenarioRuntime(options: ScenarioRuntimeOptions): ScenarioRuntime {
  const { effectExecutor = allowingPolicyExecutor, ...runtimeOptions } = options;
  return createAgentFrameworkScenarioRuntime({ ...runtimeOptions, effectExecutor });
}
