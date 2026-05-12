import * as fs from "fs";
import { activeSpec } from "../adapter/spec.js";
import type { PlanSourceDescriptor } from "../adapter/types.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import { formatTranscriptResult, readTranscriptExact } from "./transcript.js";
import { PLAN_VALIDATE_COUNTS } from "./transcript-presets.js";
import { readJson, writeJson } from "./file-io.js";
import { sessionCurrentPlanFile } from "./paths.js";

export interface CurrentPlanLookupInput {
  transcriptPath: string;
  sessionDir?: string;
  assistantText?: string | null;
  prompt?: string;
}

export function readStoredCurrentPlan(sessionDir: string): PlanSourceDescriptor | null {
  try {
    const parsed = readJson<PlanSourceDescriptor>(sessionCurrentPlanFile(sessionDir));
    if (parsed.kind === "inline" && typeof parsed.content === "string") return parsed;
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

  if (source.kind === "inline") return source.content;

  try {
    return await fs.promises.readFile(source.path, "utf-8");
  } catch {
    return null;
  }
}

export async function validateCurrentPlanExit(input: {
  transcriptPath: string;
  sessionDir?: string;
  projectDir: string;
  hookName: string;
  assistantText?: string | null;
  prompt?: string;
}): Promise<{ approved: boolean; reason?: string; source?: PlanSourceDescriptor }> {
  const source = await readCurrentPlan(input);
  if (!source) return { approved: false, reason: "Cannot exit plan mode without a plan." };

  const content = source.kind === "inline"
    ? source.content
    : await fs.promises.readFile(source.path, "utf-8").catch(() => "");
  if (!content.trim()) return { approved: false, reason: "Cannot exit plan mode without a plan." };

  const planResult = await readTranscriptExact(input.transcriptPath, PLAN_VALIDATE_COUNTS);
  const conversationContext = formatTranscriptResult(planResult);
  const result = await checkPlanIntent(
    null,
    "Write",
    { content },
    conversationContext,
    input.transcriptPath,
    input.projectDir,
    input.hookName,
    "exit",
  );
  return { ...result, source };
}

export async function validatePlanEdit(input: {
  currentPlan: string | null;
  toolName: "Write" | "Edit";
  toolInput: { content?: string; old_string?: string; new_string?: string };
  transcriptPath: string;
  projectDir: string;
  hookName: string;
  mode?: "edit" | "exit";
}): Promise<{ approved: boolean; reason?: string }> {
  const planResult = await readTranscriptExact(input.transcriptPath, PLAN_VALIDATE_COUNTS);
  const conversationContext = formatTranscriptResult(planResult);
  return checkPlanIntent(
    input.currentPlan,
    input.toolName,
    input.toolInput,
    conversationContext,
    input.transcriptPath,
    input.projectDir,
    input.hookName,
    input.mode ?? "edit",
  );
}
