import type { JsonValue } from "../protocol/common.js";
import type { ScenarioCommand } from "../protocol/commands.js";
import type { ScenarioEffectProjection } from "../protocol/effects.js";
import type { ScenarioSnapshot } from "../protocol/snapshot.js";

export type ScenarioEffectRequest = {
  effectId: string;
  effectType: string;
  parameters: JsonValue;
  /** Runtime-only context. Never persisted in effect.requested records. */
  executionContext?: JsonValue;
  /** Runtime-only cancellation signal. Never persisted. */
  signal?: AbortSignal;
  /** Runtime-only claim token for fencing executor-owned external writes. */
  fencingToken?: string;
  /** Runtime-owned progress sink. Never persisted in effect.requested records. */
  reportProgress?(progress: JsonValue): Promise<void>;
};

export type ScenarioEffectResult = {
  result: JsonValue;
  metadata?: Record<string, JsonValue>;
  projection?: ScenarioEffectProjection;
};

export type PlannedScenarioEffect = {
  effectId: string;
  effectType: string;
  parameters: JsonValue;
};

/** Injected application policy for planning effects and projecting their failures. */
export interface ScenarioEffectPlanner {
  plan(command: ScenarioCommand, snapshot: ScenarioSnapshot): PlannedScenarioEffect | null;
  projectFailure(
    effect: PlannedScenarioEffect,
    error: string,
    snapshot: ScenarioSnapshot,
  ): ScenarioEffectProjection | null;
}

/** Ask the runtime to complete an executor-owned effect as cancelled. */
export class ScenarioEffectCancellationError extends Error {
  public constructor(public readonly reason: string) {
    super(reason);
    this.name = "ScenarioEffectCancellationError";
  }
}

export interface ScenarioEffectExecutor {
  execute(request: ScenarioEffectRequest): Promise<ScenarioEffectResult>;
}
