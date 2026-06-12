import type { PlanModeDetection, PlanModeDetectionInput } from "../../src/adapter/types.js";
import { detectPermissionPlanMode } from "../../src/utils/plan-mode-detector.js";

export function detectPlanMode(input: PlanModeDetectionInput): PlanModeDetection {
  return detectPermissionPlanMode(input) ?? { active: false, mode: null, source: "none" };
}
