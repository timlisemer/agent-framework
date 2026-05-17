import * as path from "path";
import { activeSpec } from "../adapter/spec.js";
import type { NativePlanFileLookupInput } from "../adapter/types.js";
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

export function formatPlanfileValidationWorkflow(planPath: string): string {
  return `Iterate on the planfile using ${activeSpec().mcpWireName("validate_plan")} for ${planPath} until it passes, then present the finished plan using <proposed_plan>.`;
}

export function appendPlanfileValidationWorkflow(reason: string, planPath?: string | null): string {
  if (!planPath) return reason;
  const workflow = formatPlanfileValidationWorkflow(planPath);
  if (reason.includes(workflow)) return reason;
  return `${reason} ${workflow}`;
}

export async function getPathToPlanfile(input: NativePlanFileLookupInput): Promise<string | null> {
  if (input.planName) validatePlanName(input.planName);
  const native = await activeSpec().findNativePlanFile(input);
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
