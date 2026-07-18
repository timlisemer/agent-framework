import type { JsonValue } from "../protocol/common.js";
import type { StateSliceMutation } from "../protocol/snapshot.js";

export type ScenarioStateSliceMergeInput = {
  key: string;
  baseValue: JsonValue;
  incomingValue: JsonValue;
  currentValue: JsonValue | undefined;
};

/** Application-owned state behavior injected into the reusable Scenario runtime. */
export interface ScenarioStateSlicePolicy {
  initialChanges?(): readonly StateSliceMutation[];
  normalize?(key: string, value: JsonValue): JsonValue;
  merge?(input: ScenarioStateSliceMergeInput): JsonValue;
}
