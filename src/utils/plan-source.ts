import * as fs from "fs";
import { activeSpec } from "../adapter/spec.js";
import type { PlanSourceDescriptor } from "../adapter/types.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import type { EditValidationToolInput } from "../agents/hooks/edit-validation.js";
import { createPlanfileAndValidate } from "../agents/mcp/create-planfile.js";
import { validatePlanFileWithContract } from "../agents/mcp/validate-plan.js";
import { formatTranscriptResult, readTranscriptExact } from "./transcript.js";
import { PLAN_VALIDATE_COUNTS } from "./transcript-presets.js";
import type { TextEditToolName } from "./edit-tools.js";
import { readJson, writeJson } from "./file-io.js";
import { sessionCurrentPlanFile, sessionPlanFile } from "./paths.js";
import {
  hashPlanContent,
  readPlanValidationStatus,
} from "./plan-validation-status.js";
import {
  appendPlanfileValidationWorkflow,
  extractPlanName,
  formatSessionPlanfilesForFeedback,
  getPathToPlanfile,
  listSessionPlanfiles,
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
  const validatePlanWireName = activeSpec().mcpWireName("validate_plan");
  const createPlanfileWireName = activeSpec().mcpWireName("create_planfile");
  const planfiles = listSessionPlanfiles(sessionDir);
  const existingGuidance = planfiles.length > 0
    ? ` If this is your planfile ${planfiles.map((planfile) => `"${planfile}"`).join(", ")}, edit it directly even if plan mode is active, because planfile edits are explicitly allowed, then validate it with ${validatePlanWireName} and present the complete contents of the validated planfile inside a whole-message <proposed_plan>...</proposed_plan> block. Do not summarize it or replace it with only the plan name, planfile path, or validation status. If this is a new planning phase, initialize it with ${createPlanfileWireName}.`
    : ` If one of the existing session planfiles is the current plan, edit that planfile directly even if plan mode is active, because planfile edits are explicitly allowed, then validate it with ${validatePlanWireName} and present the complete contents of the validated planfile inside a whole-message <proposed_plan>...</proposed_plan> block. Do not summarize it or replace it with only the plan name, planfile path, or validation status.`;
  return `The presented plan must use a Plan Name matching one of the accepted session planfiles, or create a new named session planfile first. ${formatSessionPlanfilesForFeedback(sessionDir)}${existingGuidance}`;
}

function slugifyPlanName(source: string): string {
  const slug = source
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "inline-plan";
}

function derivePlanNameFromContent(content: string): string {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .find((line): line is string => Boolean(line));
  return slugifyPlanName(heading ?? "inline-plan");
}

function uniqueSessionPlanName(sessionDir: string, basePlanName: string): string {
  let planName = basePlanName;
  let suffix = 2;
  while (listSessionPlanfiles(sessionDir).includes(sessionPlanFile(sessionDir, planName)) || fs.existsSync(sessionPlanFile(sessionDir, planName))) {
    planName = `${basePlanName}-${suffix}`;
    suffix += 1;
  }
  return planName;
}

function formatPlanfileValidationFailure(reasons: readonly string[], planPath: string): string {
  return appendPlanfileValidationWorkflow(
    reasons.join("; ") || "Plan validation failed.",
    planPath,
    activeSpec().mcpWireName("validate_plan"),
  );
}

async function createFirstInlinePlanfileAndBlock(input: {
  transcriptPath: string;
  sessionDir: string;
  projectDir: string;
  extractedContent: string;
}): Promise<{ approved: false; reason: string }> {
  const planName = uniqueSessionPlanName(input.sessionDir, derivePlanNameFromContent(input.extractedContent));
  const { planPath, validation } = await createPlanfileAndValidate({
    planName,
    content: input.extractedContent,
    sessionDir: input.sessionDir,
    workingDir: input.projectDir,
    transcriptPath: input.transcriptPath,
    existingPolicy: "reject",
  });
  const validationResult = validation.status === "PASS"
    ? "Validation passed. Present the plan again with the created planfile path."
    : formatPlanfileValidationFailure(validation.reasons, planPath);
  return {
    approved: false,
    reason: `Cannot exit plan mode without a planfile path. ${missingPlanfileWorkflow(input.sessionDir)} A planfile was created for you at ${planPath}. Validation resulted in the following ${validation.status === "PASS" ? "status" : "error"}: ${validationResult}`,
  };
}

async function validateExistingPlanfileForStop(input: {
  planPath: string;
  planName: string;
  content: string;
  sessionDir?: string;
  projectDir: string;
  transcriptPath: string;
}): Promise<{ approved: boolean; reason?: string; source?: PlanSourceDescriptor }> {
  const source = { kind: "file" as const, path: input.planPath, planName: input.planName };
  const contentHash = hashPlanContent(input.content);
  const cached = input.sessionDir
    ? readPlanValidationStatus({
        sessionDir: input.sessionDir,
        planPath: input.planPath,
        contentHash,
      })
    : null;

  if (cached?.status === "pass") {
    if (input.sessionDir) writeCurrentPlanSidecar(input.sessionDir, source);
    return { approved: true, source };
  }

  const validation = await validatePlanFileWithContract({
    workingDir: input.projectDir,
    planFile: input.planPath,
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
  });
  if (validation.status === "PASS") {
    if (input.sessionDir) writeCurrentPlanSidecar(input.sessionDir, source);
    return { approved: true, source };
  }

  return {
    approved: false,
    reason: formatPlanfileValidationFailure(validation.reasons, input.planPath),
  };
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
    if (extractedContent && input.sessionDir && listSessionPlanfiles(input.sessionDir).length === 0) {
      return createFirstInlinePlanfileAndBlock({
        transcriptPath: input.transcriptPath,
        sessionDir: input.sessionDir,
        projectDir: input.projectDir,
        extractedContent,
      });
    }
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
    // For populated session planfiles, the planfile is the source of truth.
    // Stop transcript text can duplicate or drift from the validated file-backed
    // plan, so validate or trust the existing file instead of overwriting it
    // from inline <proposed_plan> content here.
    return validateExistingPlanfileForStop({
      planPath: resolvedPath,
      planName,
      content: existingContent,
      sessionDir: input.sessionDir,
      projectDir: input.projectDir,
      transcriptPath: input.transcriptPath,
    });
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
    reason: formatPlanfileValidationFailure(validation.reasons, planPath),
  };
}

export async function validatePlanEdit(input: {
  currentPlan: string | null;
  toolName: TextEditToolName;
  toolInput: EditValidationToolInput;
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
