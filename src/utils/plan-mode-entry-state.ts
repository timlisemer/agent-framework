import * as fs from "fs";
import * as path from "path";
import { isPlanModeActive, isPlanModeFromInput } from "./plan-mode-detector.js";
import { sessionPlanModeStateFile } from "./paths.js";

export type PlanModeEntrySource = "SessionStart" | "UserPromptSubmit";

interface PlanModeEntryState {
  active: boolean;
  updatedAt: number;
  lastSource: PlanModeEntrySource;
}

export interface PlanModeEntryInput {
  source: PlanModeEntrySource;
  sessionDir: string;
  transcriptPath: string;
  projectDir: string;
  permissionMode?: string;
}

export interface PlanModeEntryResult {
  active: boolean;
  entered: boolean;
  message?: string;
}

export async function detectPlanModeEntryAndBuildInjection(
  input: PlanModeEntryInput,
): Promise<PlanModeEntryResult> {
  const statePath = sessionPlanModeStateFile(input.sessionDir);
  const previous = await readPlanModeEntryState(statePath);

  const active = input.permissionMode !== undefined
    ? isPlanModeFromInput({ permission_mode: input.permissionMode })
    : isPlanModeActive(input.transcriptPath);

  const entered = active && previous?.active !== true;

  await writePlanModeEntryState(statePath, {
    active,
    updatedAt: Date.now(),
    lastSource: input.source,
  });

  if (!entered) {
    return { active, entered: false };
  }

  const plansPath = path.join(input.projectDir, "PLANS.md");
  const plansContent = await fs.promises.readFile(plansPath, "utf-8").catch(() => "");

  if (!plansContent.trim()) {
    return { active, entered: true };
  }

  return {
    active,
    entered: true,
    message: buildPlanModeInjectionMessage(plansContent),
  };
}

async function readPlanModeEntryState(
  statePath: string,
): Promise<PlanModeEntryState | null> {
  try {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PlanModeEntryState>;
    if (typeof parsed.active !== "boolean") return null;
    return {
      active: parsed.active,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      lastSource: parsed.lastSource === "SessionStart" || parsed.lastSource === "UserPromptSubmit"
        ? parsed.lastSource
        : "UserPromptSubmit",
    };
  } catch {
    return null;
  }
}

async function writePlanModeEntryState(
  statePath: string,
  state: PlanModeEntryState,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function buildPlanModeInjectionMessage(plansContent: string): string {
  return [
    "The session just entered plan mode. Follow this repository planning contract for all planning and <proposed_plan> output.",
    "",
    plansContent.trim(),
  ].join("\n");
}
