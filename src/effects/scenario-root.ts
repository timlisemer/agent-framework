import * as path from "node:path";
import { runtimeRoot } from "../utils/paths.js";

/** Resolve the application-owned canonical Scenario storage root. */
export function resolveAgentFrameworkScenarioRoot(requestedRoot?: string): string {
  if (requestedRoot) return path.resolve(requestedRoot);
  const configuredRoot = process.env.AGENT_FRAMEWORK_SCENARIO_ROOT;
  return configuredRoot ? path.resolve(configuredRoot) : runtimeRoot();
}
