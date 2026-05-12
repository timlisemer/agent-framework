import * as fs from "fs";
import * as path from "path";
import { isPlanModeActive, isPlanModeFromInput } from "./plan-mode-detector.js";
import { sessionPlanModeEventsFile, sessionPlanModeStateFile } from "./paths.js";

export type PlanModeEntrySource = "SessionStart" | "UserPromptSubmit";
export type PlanModeDetectionSource = "hook-input" | "transcript-tail";

export interface PlanModeStoredState {
  active: boolean;
  updatedAt: number;
  lastSource: PlanModeEntrySource;
  permission_mode: string | null;
  detection_source: PlanModeDetectionSource;
}

export interface PlanModeTransition {
  source: PlanModeEntrySource;
  previous: PlanModeStoredState | null;
  current: PlanModeStoredState;
  active: boolean;
  entered: boolean;
  exited: boolean;
  permission_mode: string | null;
  detection_source: PlanModeDetectionSource;
}

export interface PlanModeEntryInput {
  source: PlanModeEntrySource;
  sessionDir: string;
  transcriptPath: string;
  permissionMode?: string;
}

export async function computePlanModeTransition(
  input: PlanModeEntryInput,
): Promise<PlanModeTransition> {
  const previous = await readPlanModeEntryState(sessionPlanModeStateFile(input.sessionDir));
  const detectionSource: PlanModeDetectionSource =
    input.permissionMode !== undefined ? "hook-input" : "transcript-tail";
  const active = input.permissionMode !== undefined
    ? isPlanModeFromInput({ permission_mode: input.permissionMode })
    : isPlanModeActive(input.transcriptPath);
  const permissionMode = input.permissionMode ?? null;
  const current: PlanModeStoredState = {
    active,
    updatedAt: Date.now(),
    lastSource: input.source,
    permission_mode: permissionMode,
    detection_source: detectionSource,
  };

  return {
    source: input.source,
    previous,
    current,
    active,
    entered: active && previous?.active !== true,
    exited: !active && previous?.active === true,
    permission_mode: permissionMode,
    detection_source: detectionSource,
  };
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
      permission_mode: transition.permission_mode,
      detection_source: transition.detection_source,
      previous: transition.previous,
      current: transition.current,
      entered: transition.entered,
      exited: transition.exited,
    }) + "\n",
    "utf-8",
  );
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
      permission_mode: typeof parsed.permission_mode === "string" ? parsed.permission_mode : null,
      detection_source: parsed.detection_source === "hook-input" || parsed.detection_source === "transcript-tail"
        ? parsed.detection_source
        : "transcript-tail",
    };
  } catch {
    return null;
  }
}
