import * as fs from "fs";
import { activeSpec } from "../adapter/spec.js";
import type { PlanSourceDescriptor } from "../adapter/types.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import { formatTranscriptResult, readTranscriptExact } from "./transcript.js";
import { PLAN_VALIDATE_COUNTS } from "./transcript-presets.js";
import { readJson, writeJson } from "./file-io.js";
import { sessionCurrentPlanFile } from "./paths.js";
import { getPathToPlanfile } from "./planfile.js";
import { extractPlanName } from "./planfile.js";

export interface CurrentPlanLookupInput {
  transcriptPath: string;
  sessionDir?: string;
  assistantText?: string | null;
  prompt?: string;
}

export function readStoredCurrentPlan(sessionDir: string): PlanSourceDescriptor | null {
  try {
    const parsed = readJson<PlanSourceDescriptor>(sessionCurrentPlanFile(sessionDir));
    if (parsed.kind === "file" && typeof parsed.path === "string") return parsed;
  } catch {
    return null;
  }
  return null;
}

export function writeCurrentPlanSidecar(
  sessionDir: string,
  descriptor: PlanSourceDescriptor,
): void {
  writeJson(sessionCurrentPlanFile(sessionDir), descriptor);
}

export async function readPlanFileContent(planPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(planPath, "utf-8");
  } catch {
    return null;
  }
}

export async function readCurrentPlan(
  input: CurrentPlanLookupInput,
): Promise<PlanSourceDescriptor | null> {
  const spec = activeSpec();
  const fresh = await spec.findCurrentPlanSource({
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
    assistantText: input.assistantText,
    prompt: input.prompt,
  });
  if (fresh) return fresh;
  return input.sessionDir ? readStoredCurrentPlan(input.sessionDir) : null;
}

export async function readCurrentPlanContent(
  input: CurrentPlanLookupInput,
): Promise<string | null> {
  const source = await readCurrentPlan(input);
  if (!source) return null;

  return readPlanFileContent(source.path);
}

export async function getCurrentPlanfilePath(input: CurrentPlanLookupInput & { planName?: string }): Promise<string | null> {
  const pathToPlanfile = await getPathToPlanfile({
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
    planName: input.planName,
  });
  if (pathToPlanfile) return pathToPlanfile;
  const stored = input.sessionDir ? readStoredCurrentPlan(input.sessionDir) : null;
  return stored?.path ?? null;
}

export async function validateCurrentPlanExit(input: {
  transcriptPath: string;
  sessionDir?: string;
  projectDir: string;
  hookName: string;
  assistantText?: string | null;
  prompt?: string;
}): Promise<{ approved: boolean; reason?: string; source?: PlanSourceDescriptor }> {
  const pathToPlanfile = await getCurrentPlanfilePath(input);
  if (!pathToPlanfile) return { approved: false, reason: "Cannot exit plan mode without a plan." };

  const content = await readPlanFileContent(pathToPlanfile) ?? "";
  if (!content.trim()) return { approved: false, reason: "Cannot exit plan mode without a plan." };

  const planResult = await readTranscriptExact(input.transcriptPath, PLAN_VALIDATE_COUNTS);
  const conversationContext = formatTranscriptResult(planResult);
  const result = await checkPlanIntent(
    null,
    "Write",
    { content },
    conversationContext,
    input.projectDir,
    input.hookName,
    "exit",
    pathToPlanfile,
  );
  return { ...result, source: { kind: "file", path: pathToPlanfile, planName: extractPlanName(content) ?? undefined } };
}

export async function validatePlanEdit(input: {
  currentPlan: string | null;
  toolName: "Write" | "Edit";
  toolInput: { content?: string; old_string?: string; new_string?: string };
  transcriptPath: string;
  projectDir: string;
  hookName: string;
  mode?: "edit" | "exit";
  planFilePath?: string;
}): Promise<{ approved: boolean; reason?: string }> {
  const planResult = await readTranscriptExact(input.transcriptPath, PLAN_VALIDATE_COUNTS);
  const conversationContext = formatTranscriptResult(planResult);
  return checkPlanIntent(
    input.currentPlan,
    input.toolName,
    input.toolInput,
    conversationContext,
    input.projectDir,
    input.hookName,
    input.mode ?? "edit",
    input.planFilePath,
  );
}
