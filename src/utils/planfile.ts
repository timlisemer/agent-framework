import * as fs from "fs";
import * as path from "path";
import type { NativePlanFileLookup, NativePlanFileLookupInput } from "../adapter/types.js";
import { sessionPlanFile, sessionPlansDir } from "./paths.js";

export const PLAN_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validatePlanName(planName: string): string {
  if (!PLAN_NAME_RE.test(planName)) {
    throw new Error(`Invalid plan name: ${planName}`);
  }
  return planName;
}

export function extractPlanName(plan: string): string | null {
  const firstNonEmpty = plan.split(/\r?\n/).find((line) => line.trim().length > 0);
  const match = firstNonEmpty?.match(/^Plan Name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/);
  return match?.[1] ?? null;
}

export function extractPlanfileFooter(plan: string): { planFilePath: string; planName: string } | null {
  const nonEmpty = plan.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (nonEmpty.length < 2) return null;
  const pathMatch = nonEmpty[nonEmpty.length - 2]?.match(/^Planfile Path:\s*(.+)\s*$/);
  const nameMatch = nonEmpty[nonEmpty.length - 1]?.match(/^Plan Name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/);
  if (!pathMatch || !nameMatch) return null;
  return { planFilePath: pathMatch[1], planName: nameMatch[1] };
}

export function formatPlanfileValidationWorkflow(
  planPath: string,
  validatePlanWireName: string,
): string {
  return `Iterate on the planfile using ${validatePlanWireName} for ${planPath} until it passes; edit that planfile directly even if plan mode is active, because the named planfile is the planning surface, this is the required remediation path, not an implementation edit, and planfile edits are explicitly allowed. Then present the complete contents of the validated planfile inside a whole-message <proposed_plan>...</proposed_plan> block. Do not summarize it or replace it with only the plan name, planfile path, or validation status.`;
}

export function appendPlanfileValidationWorkflow(reason: string, planPath?: string | null, validatePlanWireName?: string): string {
  if (!planPath) return reason;
  if (!validatePlanWireName) return reason;
  const workflow = formatPlanfileValidationWorkflow(planPath, validatePlanWireName);
  if (reason.includes(workflow)) return reason;
  return `${reason} ${workflow}`;
}

export function listSessionPlanfiles(sessionDir?: string): string[] {
  if (!sessionDir) return [];
  const plansDir = sessionPlansDir(sessionDir);
  try {
    return fs.readdirSync(plansDir)
      .filter((entry) => entry.endsWith(".md") && PLAN_NAME_RE.test(entry.slice(0, -3)))
      .map((entry) => path.join(plansDir, entry))
      .sort();
  } catch {
    return [];
  }
}

export function formatSessionPlanfilesForFeedback(sessionDir?: string): string {
  if (!sessionDir) return "No session plans directory is available for this hook invocation.";
  const plansDir = sessionPlansDir(sessionDir);
  const planfiles = listSessionPlanfiles(sessionDir);
  const listed = planfiles.length > 0 ? planfiles.join(", ") : "(none)";
  return `Session planfiles directory: ${plansDir}. Existing session planfiles accepted for this session: ${listed}.`;
}

export async function getPathToPlanfile(
  input: NativePlanFileLookupInput,
  findNativePlanFile?: NativePlanFileLookup,
): Promise<string | null> {
  if (input.planName) validatePlanName(input.planName);
  const native = await findNativePlanFile?.(input);
  if (native) return native;

  if (!input.sessionDir || !input.planName) return null;
  const planPath = sessionPlanFile(input.sessionDir, input.planName);
  if (!isSessionPlanfilePath(planPath, input.sessionDir)) {
    throw new Error(`Invalid session planfile path: ${planPath}`);
  }
  return planPath;
}

export function isSessionPlanfilePath(filePath: string, sessionDir: string): boolean {
  const resolved = path.resolve(filePath);
  const plansDir = sessionPlansDir(sessionDir);
  const plansDirResolved = path.resolve(plansDir);
  if (!(resolved.startsWith(plansDirResolved + path.sep) || resolved === plansDirResolved)) return false;
  const base = path.basename(resolved);
  return base.endsWith(".md") && PLAN_NAME_RE.test(base.slice(0, -3));
}
