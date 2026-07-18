import { AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES } from "../../effects/scenario-behavior.js";

export const SCENARIO_SOURCE_TAGS = [
  "home",
  ...AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES,
] as const;
export type ScenarioSourceTag = typeof SCENARIO_SOURCE_TAGS[number];

export interface ScenarioCatalogEntry {
  name: string;
  source: ScenarioSourceTag;
  inputPath: string;
  outputDir: string;
  error?: string;
}
