import type { Mood, Trust } from "../utils/prediction-types.js";
import type { ReasonMustExpectation } from "./types.js";

export interface PredictionAnnotation {
  verdict: "correct" | "too_broad" | "wrong" | "INVESTIGATE";
  forbidden_blocks?: Array<{ tool?: string; target_pattern?: string }>;
  intent_must_contain?: string;
  expected_mood?: Mood;
  expected_trust?: Trust;
  notes?: string;
}

export interface RichExpectation {
  expected: string;
  by?: string;
  at?: number | "full";
  notes?: string;
  prediction?: PredictionAnnotation;
  reason_must?: ReasonMustExpectation;
}

export type ExpectationEntry = string | RichExpectation | RichExpectation[];
export type LabelValue = string | RichExpectation | RichExpectation[];

export function validatePredictionAnnotationShape(
  ctx: string,
  expected: string,
  by: string | undefined,
  prediction: unknown,
): void {
  if (!prediction || typeof prediction !== "object") {
    throw new Error(`${ctx}.prediction must be an object when set`);
  }
  const p = prediction as Record<string, unknown>;
  if (expected !== "deny") {
    throw new Error(
      `${ctx}.prediction requires expected="deny", got ${JSON.stringify(expected)}`,
    );
  }
  if (by !== "prediction-block" && by !== "batch-sibling") {
    throw new Error(
      `${ctx}.prediction requires by ∈ {"prediction-block","batch-sibling"}, got ${JSON.stringify(by)}`,
    );
  }
  const validVerdicts = ["correct", "too_broad", "wrong", "INVESTIGATE"];
  if (typeof p.verdict !== "string" || !validVerdicts.includes(p.verdict)) {
    throw new Error(
      `${ctx}.prediction.verdict must be one of ${validVerdicts.join(", ")}, got ${JSON.stringify(p.verdict)}`,
    );
  }
  if (p.verdict === "too_broad") {
    if (!Array.isArray(p.forbidden_blocks) || p.forbidden_blocks.length === 0) {
      throw new Error(
        `${ctx}.prediction.forbidden_blocks must be a non-empty array when verdict="too_broad"`,
      );
    }
  }
  if (p.intent_must_contain !== undefined) {
    if (typeof p.intent_must_contain !== "string" || p.intent_must_contain.length === 0) {
      throw new Error(
        `${ctx}.prediction.intent_must_contain must be a non-empty string when set`,
      );
    }
  }
  if (p.expected_mood !== undefined) {
    const validMoods = ["angry", "frustrated", "neutral", "satisfied", "happy"];
    if (typeof p.expected_mood !== "string" || !validMoods.includes(p.expected_mood as string)) {
      throw new Error(
        `${ctx}.prediction.expected_mood must be one of ${validMoods.join(", ")}, got ${JSON.stringify(p.expected_mood)}`,
      );
    }
  }
  if (p.expected_trust !== undefined) {
    const validTrusts = ["low", "normal", "high"];
    if (typeof p.expected_trust !== "string" || !validTrusts.includes(p.expected_trust as string)) {
      throw new Error(
        `${ctx}.prediction.expected_trust must be one of ${validTrusts.join(", ")}, got ${JSON.stringify(p.expected_trust)}`,
      );
    }
  }
}
