import * as fs from "fs";
import * as path from "path";
import { activeSpec } from "../adapter/spec.js";
import type { PlanSourceDescriptor } from "../adapter/types.js";
import { checkPlanIntent, collectPlanValidationViolations } from "../agents/hooks/plan-validate.js";
import { formatTranscriptResult, readTranscriptExact } from "./transcript.js";
import { PLAN_VALIDATE_COUNTS } from "./transcript-presets.js";
import { readJson, writeJson } from "./file-io.js";
import { sessionCurrentPlanFile } from "./paths.js";
import {
  appendPlanfileValidationWorkflow,
  extractPlanName,
  extractPlanfileFooter,
  formatSessionPlanfilesForFeedback,
  formatPlanfileValidationWorkflow,
  getPathToPlanfile,
} from "./planfile.js";
import { comparePlanContent } from "./plan-content-compare.js";
import {
  hashPlanContent,
  readPlanValidationStatus,
} from "./plan-validation-status.js";
import { validatePlanFileWithContract } from "../agents/mcp/validate-plan.js";

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

function stripViolationPrefix(text: string): string {
  return text.replace(/^\[VIOLATION: [^\]]+\]\s*/, "");
}

function mismatchWorkflow(planPath: string): string {
  return formatPlanfileValidationWorkflow(planPath);
}

function missingPlanfileWorkflow(sessionDir?: string): string {
  return `The presented plan must use a Plan Name matching one of the accepted session planfiles, or create a new named session planfile first. ${formatSessionPlanfilesForFeedback(sessionDir)} If one of the existing session planfiles is the current plan, edit that planfile directly even if plan mode is active, because planfile edits are explicitly allowed, then validate it with ${activeSpec().mcpWireName("validate_plan")} and present the finished plan using <proposed_plan>.`;
}

function structureReasons(content: string, projectDir: string, planPath?: string): string[] {
  const findings = collectPlanValidationViolations(content, projectDir, planPath);
  return findings.allViolations.map(stripViolationPrefix);
}

function resolveFooterPath(projectDir: string, footerPath: string): string {
  return path.isAbsolute(footerPath) ? path.resolve(footerPath) : path.resolve(projectDir, footerPath);
}

async function reportInvalidExtractedProposalWithPlanfile(input: {
  extractedContent: string;
  transcriptPath: string;
  sessionDir?: string;
  projectDir: string;
  structureReasons: string[];
}): Promise<{ approved: false; reason: string }> {
  const planName = extractPlanName(input.extractedContent);
  const planPath = await getCurrentPlanfilePath({
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
    planName: planName ?? undefined,
  });
  if (!planPath) {
    return {
      approved: false,
      reason: `Extracted proposed plan is structurally invalid: ${input.structureReasons.join("; ") || "missing required plan structure."} ${missingPlanfileWorkflow(input.sessionDir)}`,
    };
  }

  const fileContent = await readPlanFileContent(planPath);
  if (!fileContent?.trim()) {
    return {
      approved: false,
      reason: appendPlanfileValidationWorkflow(
        `Extracted proposed plan is structurally invalid: ${input.structureReasons.join("; ") || "missing required plan structure."}`,
        planPath,
      ),
    };
  }

  const contentHash = hashPlanContent(fileContent);
  const status = input.sessionDir
    ? readPlanValidationStatus({
      sessionDir: input.sessionDir,
      planPath,
      contentHash,
    })
    : null;
  const statusText = status ? status.status : "no recorded pass/fail status";
  const statusInstruction = status?.status === "pass"
    ? "If this is the current plan, do not shrink or reduce details when presenting it in <proposed_plan>; present the same plan as the planfile."
    : `If this is the current plan, ${formatPlanfileValidationWorkflow(planPath)}`;
  return {
    approved: false,
    reason: [
      `Extracted proposed plan is structurally invalid: ${input.structureReasons.join("; ") || "missing required plan structure."}`,
      `A populated planfile already exists at ${planPath}.`,
      `Last known validation status for that exact content: ${statusText}.`,
      statusInstruction,
      `If it is not the current plan, create a new named session planfile first. ${missingPlanfileWorkflow(input.sessionDir)}`,
    ].join(" "),
  };
}

async function runSharedValidation(input: {
  planPath: string;
  transcriptPath: string;
  sessionDir?: string;
  projectDir: string;
}) {
  return validatePlanFileWithContract({
    workingDir: input.projectDir,
    planFile: input.planPath,
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
  });
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
  if (!extractedContent) return validateCurrentPlanExit(input);

  const extractedPlanName = extractPlanName(extractedContent);
  const extractedStructureReasons = structureReasons(extractedContent, input.projectDir);
  if (extractedStructureReasons.length > 0) {
    if (!extractedPlanName) {
      return {
        approved: false,
        reason: `Extracted proposed plan is structurally invalid: ${extractedStructureReasons.join("; ")} ${missingPlanfileWorkflow(input.sessionDir)}`,
      };
    }
    return reportInvalidExtractedProposalWithPlanfile({
      extractedContent,
      transcriptPath: input.transcriptPath,
      sessionDir: input.sessionDir,
      projectDir: input.projectDir,
      structureReasons: extractedStructureReasons,
    });
  }

  const planName = extractedPlanName!;
  const resolvedPath = await getCurrentPlanfilePath({
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
    planName,
  });
  if (!resolvedPath) {
    return { approved: false, reason: `Cannot exit plan mode without a planfile path for Plan Name "${planName}". ${missingPlanfileWorkflow(input.sessionDir)}` };
  }

  const footer = extractPlanfileFooter(extractedContent);
  if (!footer) {
    return { approved: false, reason: appendPlanfileValidationWorkflow("Extracted proposed plan is structurally invalid: missing Planfile Path footer.", resolvedPath) };
  }
  if (footer.planName !== planName) {
    return { approved: false, reason: appendPlanfileValidationWorkflow("Extracted proposed plan footer Plan Name does not match the plan name.", resolvedPath) };
  }

  const footerPath = resolveFooterPath(input.projectDir, footer.planFilePath);
  if (footerPath !== path.resolve(resolvedPath)) {
    return {
      approved: false,
      reason: `Extracted proposed plan Planfile Path footer must match the resolved current planfile path. Footer path: ${footerPath}. Resolved path: ${path.resolve(resolvedPath)}. ${missingPlanfileWorkflow(input.sessionDir)}`,
    };
  }

  let existingContent: string | null = null;
  let exists = false;
  try {
    existingContent = await fs.promises.readFile(resolvedPath, "utf-8");
    exists = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        approved: false,
        reason: appendPlanfileValidationWorkflow(`The matching planfile at ${resolvedPath} is unreadable. Repair it before presenting <proposed_plan>.`, resolvedPath),
      };
    }
  }

  if (!exists) {
    await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.promises.writeFile(resolvedPath, extractedContent + "\n", "utf-8");
    const validation = await runSharedValidation({
      planPath: resolvedPath,
      transcriptPath: input.transcriptPath,
      sessionDir: input.sessionDir,
      projectDir: input.projectDir,
    });
    if (validation.status === "PASS") {
      const source = { kind: "file" as const, path: resolvedPath, planName };
      if (input.sessionDir) writeCurrentPlanSidecar(input.sessionDir, source);
      return { approved: true, source };
    }
    return {
      approved: false,
      reason: `${appendPlanfileValidationWorkflow(validation.reasons.join("; ") || "Plan validation failed.", resolvedPath)} Only present <proposed_plan> after ${activeSpec().mcpWireName("validate_plan")} passes.`,
    };
  }

  if (!existingContent?.trim()) {
    return {
      approved: false,
      reason: appendPlanfileValidationWorkflow(`The matching planfile at ${resolvedPath} is empty. Populate it before presenting <proposed_plan>.`, resolvedPath),
    };
  }

  const comparison = comparePlanContent(extractedContent, existingContent);
  if (!comparison.equal) {
    const detail = comparison.tooLong
      ? "The extracted proposed plan is a different or heavily changed plan."
      : `Raw diff:\n${comparison.rawDiff}`;
    return {
      approved: false,
      reason: `${detail}\n${mismatchWorkflow(resolvedPath)}`,
    };
  }

  const contentHash = hashPlanContent(existingContent);
  const recorded = input.sessionDir
    ? readPlanValidationStatus({ sessionDir: input.sessionDir, planPath: resolvedPath, contentHash })
    : null;

  if (recorded?.status === "pass") {
    const source = { kind: "file" as const, path: resolvedPath, planName };
    if (input.sessionDir) writeCurrentPlanSidecar(input.sessionDir, source);
    return { approved: true, source };
  }

  if (recorded?.status === "fail") {
    return {
      approved: false,
      reason: `The exact current planfile content previously failed validation. ${formatPlanfileValidationWorkflow(resolvedPath)} Do not present the plan using <proposed_plan> unless ${activeSpec().mcpWireName("validate_plan")} has passed for that exact planfile content.`,
    };
  }

  const validation = await runSharedValidation({
    planPath: resolvedPath,
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
    projectDir: input.projectDir,
  });
  if (validation.status === "PASS") {
    const source = { kind: "file" as const, path: resolvedPath, planName };
    if (input.sessionDir) writeCurrentPlanSidecar(input.sessionDir, source);
    return { approved: true, source };
  }
  return {
    approved: false,
    reason: `${appendPlanfileValidationWorkflow(validation.reasons.join("; ") || "Plan validation failed.", resolvedPath)} Do not present the plan using <proposed_plan> unless ${activeSpec().mcpWireName("validate_plan")} has passed for that exact planfile content.`,
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
