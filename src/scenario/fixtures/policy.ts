import type { ScenarioCommand } from "../protocol/commands.js";
import type { JsonValue } from "../protocol/common.js";
import type { ScenarioEffectProjection } from "../protocol/effects.js";
import type { ScenarioRecord } from "../protocol/records.js";
import type { ScenarioSnapshot } from "../protocol/snapshot.js";
import type { ScenarioCommandExtensionHandler } from "../runtime/command-extension.js";
import type {
  ScenarioEffectPlanner,
  ScenarioEffectRequest,
  ScenarioEffectResult,
} from "../runtime/effects.js";
import type { ScenarioStateSlicePolicy } from "../runtime/state-slice-policy.js";
import type { FixtureExpectation } from "./types.js";

export type MaterializedFixtureRecord = {
  record: ScenarioRecord;
  payload: Record<string, JsonValue>;
};

export type FixtureMaterializationContext = {
  commands: readonly ScenarioCommand[];
  snapshot: ScenarioSnapshot;
};

export type FixtureExpectationContext = FixtureMaterializationContext & {
  records: readonly MaterializedFixtureRecord[];
};

/** Optional application composition for opaque extensions and their effects. */
export interface ScenarioFixturePolicy {
  effectPlanner?: ScenarioEffectPlanner;
  extensionHandler?: ScenarioCommandExtensionHandler;
  stateSlicePolicy?: ScenarioStateSlicePolicy;
  isLiveBehavior?(context: FixtureMaterializationContext): boolean;
  projectLiveExpectations?(context: FixtureExpectationContext): FixtureExpectation[];
  defaultUndeclaredEffect?(
    request: ScenarioEffectRequest,
  ): ScenarioEffectResult | null | Promise<ScenarioEffectResult | null>;
  projectDeterministicEffect?(
    request: ScenarioEffectRequest,
    result: JsonValue,
  ): ScenarioEffectProjection | undefined | Promise<ScenarioEffectProjection | undefined>;
}
