import type { PlanModeDetection, PlanModeDetectionSource } from "../adapter/types.js";

export type PlanModeEntrySource = "SessionStart" | "UserPromptSubmit";

export interface PlanModeStoredState {
  active: boolean;
  updatedAt: number;
  lastSource: PlanModeEntrySource;
  mode: string | null;
  detection_source: PlanModeDetectionSource;
  deliveredPlansMdHash: string | null;
  deliveredPlansMdAt: number | null;
}

export interface PlanModeTransition {
  source: PlanModeEntrySource;
  previous: PlanModeStoredState | null;
  current: PlanModeStoredState;
  active: boolean;
  entered: boolean;
  exited: boolean;
  mode: string | null;
  detection_source: PlanModeDetectionSource;
}

export function derivePlanModeTransition(input: {
  source: PlanModeEntrySource;
  detection: PlanModeDetection;
  previous: PlanModeStoredState | null;
}): PlanModeTransition {
  const active = input.detection.active;
  const sameEpisode = active && input.previous?.active === true;
  const current: PlanModeStoredState = {
    active,
    updatedAt: Date.now(),
    lastSource: input.source,
    mode: input.detection.mode,
    detection_source: input.detection.source,
    deliveredPlansMdHash: sameEpisode ? input.previous?.deliveredPlansMdHash ?? null : null,
    deliveredPlansMdAt: sameEpisode ? input.previous?.deliveredPlansMdAt ?? null : null,
  };
  return {
    source: input.source,
    previous: input.previous,
    current,
    active,
    entered: active && input.previous?.active !== true,
    exited: !active && input.previous?.active === true,
    mode: input.detection.mode,
    detection_source: input.detection.source,
  };
}

export function markPlansMdDelivered(
  transition: PlanModeTransition,
  contentHash: string,
): void {
  transition.current.deliveredPlansMdHash = contentHash;
  transition.current.deliveredPlansMdAt = Date.now();
}

export function parsePlanModeStoredState(
  raw: unknown,
): PlanModeStoredState | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<PlanModeStoredState>;
  if (typeof parsed.active !== "boolean") return null;
  return {
    active: parsed.active,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    lastSource: parsed.lastSource === "SessionStart" || parsed.lastSource === "UserPromptSubmit"
      ? parsed.lastSource
      : "UserPromptSubmit",
    mode: typeof parsed.mode === "string" ? parsed.mode : null,
    detection_source: isPlanModeDetectionSource(parsed.detection_source)
      ? parsed.detection_source
      : "none",
    deliveredPlansMdHash: typeof parsed.deliveredPlansMdHash === "string"
      ? parsed.deliveredPlansMdHash
      : null,
    deliveredPlansMdAt: typeof parsed.deliveredPlansMdAt === "number"
      ? parsed.deliveredPlansMdAt
      : null,
  };
}

function isPlanModeDetectionSource(raw: unknown): raw is PlanModeDetectionSource {
  return raw === "codex-collaboration-mode" ||
    raw === "hook-permission-mode" ||
    raw === "transcript-permission-mode" ||
    raw === "none";
}
