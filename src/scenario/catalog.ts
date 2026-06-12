import * as path from "path";
import { scenarioJsonFile, scenariosRoot } from "../utils/paths.js";

export type ScenarioSourceTag =
  | "home"
  | "expected-to-pass"
  | "non-deterministic"
  | "expected-to-fail";

export type ScenarioRealityValue = "expected-to-pass" | "non-deterministic" | "expected-to-fail" | null;

export interface ScenarioSource {
  name: string;
  source: ScenarioSourceTag;
  inputPath: string;
  outputDir: string;
  hasReport: boolean;
  error?: string;
  lastRun?: { reality: ScenarioRealityValue; at: string };
}

export function scenariosDir(): string {
  return scenariosRoot();
}

export function scenarioDir(name: string): string {
  return path.dirname(scenarioJsonFile(name));
}
