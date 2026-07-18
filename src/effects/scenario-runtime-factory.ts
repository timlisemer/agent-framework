import { ScenarioRuntime, type ScenarioRuntimeOptions } from "../scenario/runtime/runtime.js";
import { agentFrameworkHostExtensionHandler } from "./host-command.js";
import { RulePipelineEffectExecutor } from "./rule-pipeline-executor.js";
import { agentFrameworkEffectPlanner } from "./rule-pipeline-contract.js";
import { resolveAgentFrameworkScenarioRoot } from "./scenario-root.js";
import { agentFrameworkStateSlicePolicy } from "./state-slices.js";

/** Construct the environment-aware production Scenario runtime used by host boundaries. */
export function createAgentFrameworkScenarioRuntime(
  options: Omit<ScenarioRuntimeOptions, "root"> & { root?: string } = {},
): ScenarioRuntime {
  const configuredSecretPaths = (process.env.AGENT_FRAMEWORK_SCENARIO_SECRET_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const {
    root: requestedRoot,
    redactionPaths: requestedRedactionPaths = [],
    ...runtimeOptions
  } = options;
  return new ScenarioRuntime({
    root: resolveAgentFrameworkScenarioRoot(requestedRoot),
    effectExecutor: new RulePipelineEffectExecutor(),
    effectPlanner: agentFrameworkEffectPlanner,
    extensionHandler: agentFrameworkHostExtensionHandler,
    stateSlicePolicy: agentFrameworkStateSlicePolicy,
    ...runtimeOptions,
    redactionPaths: [
      "credentials.*",
      "authentication.*",
      "provider.credentials.*",
      ...configuredSecretPaths,
      ...requestedRedactionPaths,
    ],
  });
}
