import type { ScenarioCommand } from "../protocol/commands.js";
import type { ScenarioEffectProjectionRecord, ScenarioEffectStateChange } from "../protocol/effects.js";
import type { ScenarioSnapshot } from "../protocol/snapshot.js";
import type { ScenarioTerminalResult } from "./results.js";

export type ScenarioCommandExtensionMutation =
  | { kind: "record"; record: ScenarioEffectProjectionRecord }
  | { kind: "stateChange"; change: ScenarioEffectStateChange };

export type ScenarioCommandExtensionResult = {
  mutations: readonly ScenarioCommandExtensionMutation[];
  terminalResult: ScenarioTerminalResult;
};

/** Application composition for opaque commands that are not part of the shared protocol. */
export interface ScenarioCommandExtensionHandler {
  /** Validate opaque application data before generic persistence sanitization. */
  validate?(
    command: ScenarioCommand & {
      payload: Extract<ScenarioCommand["payload"], { type: "extensionCommand" }>;
    },
  ): void;
  project(
    command: ScenarioCommand & {
      payload: Extract<ScenarioCommand["payload"], { type: "extensionCommand" }>;
    },
    snapshot: ScenarioSnapshot,
  ): ScenarioCommandExtensionResult | null;
}
