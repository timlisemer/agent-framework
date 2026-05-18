import * as fs from "fs";
import { activeSpec } from "../adapter/spec.js";
import type { PlanSourceDescriptor } from "../adapter/types.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import { createPlanfileAndValidate } from "../agents/mcp/create-planfile.js";
import { formatTranscriptResult, readTranscriptExact } from "./transcript.js";
import { PLAN_VALIDATE_COUNTS } from "./transcript-presets.js";
import { readJson, writeJson } from "./file-io.js";
import { sessionCurrentPlanFile } from "./paths.js";
import {
  appendPlanfileValidationWorkflow,
  extractPlanName,
  formatSessionPlanfilesForFeedback,
  getPathToPlanfile,
} from "./planfile.js";

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
  const planName = input.assistantText ? extractPlanName(input.assistantText) ?? undefined : undefined;
  const pathToPlanfile = await getPathToPlanfile({
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
    planName,
  }, (lookup) => activeSpec().findNativePlanFile(lookup));
  if (pathToPlanfile) {
    return { kind: "file", path: pathToPlanfile, planName };
  }
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
  }, (lookup) => activeSpec().findNativePlanFile(lookup));
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

  return { approved: true, source: { kind: "file", path: pathToPlanfile, planName: extractPlanName(content) ?? undefined } };
}

function missingPlanfileWorkflow(sessionDir?: string): string {
  return `The presented plan must use a Plan Name matching one of the accepted session planfiles, or create a new named session planfile first. ${formatSessionPlanfilesForFeedback(sessionDir)} If one of the existing session planfiles is the current plan, edit that planfile directly even if plan mode is active, because planfile edits are explicitly allowed, then validate it with ${activeSpec().mcpWireName("validate_plan")} and present the finished plan using <proposed_plan>.`;
}

export async function validatePlanExitPresentation(input: {
  transcriptPath: string;
  sessionDir?: string;
  projectDir: string;
  hookName: string;
  assistantText?: string | null;
}): Promise<{ approved: boolean; reason?: string; source?: PlanSourceDescriptor }> {
  void input.hookName;
  const spec = activeSpec();
  const extractedContent = spec.extractStopProposedPlan(input.assistantText);
  const planName = extractedContent ? extractPlanName(extractedContent) ?? undefined : undefined;
  if (!extractedContent || !planName) {
    return { approved: false, reason: `Cannot exit plan mode without a planfile path. ${missingPlanfileWorkflow(input.sessionDir)}` };
  }
  const resolvedPath = await getCurrentPlanfilePath({
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
    planName,
  });
  if (!resolvedPath) {
    return { approved: false, reason: `Cannot exit plan mode without a planfile path. ${missingPlanfileWorkflow(input.sessionDir)}` };
  }

  let existingContent: string | null = null;
  try {
    existingContent = await fs.promises.readFile(resolvedPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        approved: false,
        reason: appendPlanfileValidationWorkflow(
          `The matching planfile at ${resolvedPath} is unreadable. Repair it before presenting <proposed_plan>.`,
          resolvedPath,
          activeSpec().mcpWireName("validate_plan"),
        ),
      };
    }
  }

  if (existingContent?.trim()) {
    const existingPlanName = extractPlanName(existingContent) ?? undefined;
    if (planName && existingPlanName && existingPlanName !== planName) {
      return {
        approved: false,
        reason: appendPlanfileValidationWorkflow(
          `The located planfile at ${resolvedPath} is for "${existingPlanName}", but the presented plan is "${planName}". Present or validate the matching planfile before exiting plan mode.`,
          resolvedPath,
          activeSpec().mcpWireName("validate_plan"),
        ),
      };
    }
  }

  const { planPath, validation } = await createPlanfileAndValidate({
    planName,
    content: extractedContent,
    sessionDir: input.sessionDir,
    workingDir: input.projectDir,
    transcriptPath: input.transcriptPath,
    existingPolicy: "overwrite",
  });
  if (validation.status === "PASS") {
    const updatedContent = await readPlanFileContent(planPath);
    if (updatedContent?.trim()) {
      const source = { kind: "file" as const, path: planPath, planName: extractPlanName(updatedContent) ?? planName };
      if (input.sessionDir) writeCurrentPlanSidecar(input.sessionDir, source);
      return { approved: true, source };
    }
    return {
      approved: false,
      reason: appendPlanfileValidationWorkflow(
        `The matching planfile at ${planPath} is still empty after plan validation.`,
        planPath,
        activeSpec().mcpWireName("validate_plan"),
      ),
    };
  }
  return {
    approved: false,
    reason: validation.reasons.join("; ") || "Plan validation failed.",
  };
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
