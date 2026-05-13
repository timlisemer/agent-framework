import * as fs from "fs";
import * as path from "path";
import type { PlanModeDetection, PlanModeDetectionSource } from "../adapter/types.js";
import { sessionPlanModeEventsFile, sessionPlanModeStateFile } from "./paths.js";

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

export interface PlanModeEntryInput {
  source: PlanModeEntrySource;
  sessionDir: string;
  detection: PlanModeDetection;
}

export async function computePlanModeTransition(
  input: PlanModeEntryInput,
): Promise<PlanModeTransition> {
  const previous = await readPlanModeEntryState(sessionPlanModeStateFile(input.sessionDir));
  const active = input.detection.active;
  const sameEpisode = active && previous?.active === true;
  const current: PlanModeStoredState = {
    active,
    updatedAt: Date.now(),
    lastSource: input.source,
    mode: input.detection.mode,
    detection_source: input.detection.source,
    deliveredPlansMdHash: sameEpisode ? previous.deliveredPlansMdHash : null,
    deliveredPlansMdAt: sameEpisode ? previous.deliveredPlansMdAt : null,
  };

  return {
    source: input.source,
    previous,
    current,
    active,
    entered: active && previous?.active !== true,
    exited: !active && previous?.active === true,
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

export async function commitPlanModeTransition(
  sessionDir: string,
  transition: PlanModeTransition,
): Promise<void> {
  const statePath = sessionPlanModeStateFile(sessionDir);
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(
    statePath,
    `${JSON.stringify(transition.current, null, 2)}\n`,
    "utf-8",
  );

  if (!transition.entered && !transition.exited) return;

  const eventPath = sessionPlanModeEventsFile(sessionDir);
  await fs.promises.mkdir(path.dirname(eventPath), { recursive: true });
  await fs.promises.appendFile(
    eventPath,
    JSON.stringify({
      ts: Date.now(),
      event: transition.entered ? "entered" : "exited",
      source: transition.source,
      mode: transition.mode,
      detection_source: transition.detection_source,
      previous: transition.previous,
      current: transition.current,
      entered: transition.entered,
      exited: transition.exited,
    }) + "\n",
    "utf-8",
  );
}

export async function readPlanModeStoredState(
  sessionDir: string,
): Promise<PlanModeStoredState | null> {
  return readPlanModeEntryState(sessionPlanModeStateFile(sessionDir));
}

async function readPlanModeEntryState(
  statePath: string,
): Promise<PlanModeStoredState | null> {
  try {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PlanModeStoredState>;
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
  } catch {
    return null;
  }
}

function isPlanModeDetectionSource(raw: unknown): raw is PlanModeDetectionSource {
  return raw === "codex-collaboration-mode" ||
    raw === "hook-permission-mode" ||
    raw === "transcript-permission-mode" ||
    raw === "none";
}
