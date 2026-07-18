import * as fs from "fs";
import * as path from "path";
import { activeSpec, mcpWireNameForText } from "../../adapter/spec.js";
import { appendPlanfileValidationWorkflow, getPathToPlanfile } from "../../utils/planfile.js";
import { getAgentFrameworkSessionDir } from "../../utils/paths.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import { isMissingFileError } from "../../utils/filesystem-errors.js";
import {
  formatPlanValidationPassInstructions,
  validatePlanFileWithContract,
  type PlanValidationRunResult,
} from "./validate-plan.js";

export interface CreatePlanfileInput {
  planName: string;
  content: string;
  continueWorkflow?: boolean;
}

export type ExistingPlanfilePolicy = "reject" | "overwrite";

export interface CreatePlanfileAndValidateInput extends CreatePlanfileInput {
  sessionDir?: string;
  workingDir: string;
  transcriptPath?: string;
  existingPolicy: ExistingPlanfilePolicy;
}

export interface CreatePlanfileAndValidateResult {
  planPath: string;
  validation: PlanValidationRunResult;
}

function normalizePlanContent(planName: string, planPath: string, content: string): string {
  let body = content.trim();
  body = body.replace(/^\s*Plan Name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*\n+/i, "");
  body = body.replace(/\n+\s*Planfile Path:\s*.+\s*\n\s*Plan Name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/i, "");
  return `Plan Name: ${planName}\n\n${body.trim()}\n\nPlanfile Path: ${planPath}\nPlan Name: ${planName}\n`;
}

export async function createPlanfileAndValidate(
  input: CreatePlanfileAndValidateInput,
  options: CancellationOptions = {},
): Promise<CreatePlanfileAndValidateResult> {
  throwIfAborted(options.signal);
  const planPath = await getPathToPlanfile({
    transcriptPath: input.transcriptPath ?? "",
    sessionDir: input.sessionDir,
    planName: input.planName,
  }, (lookup) => activeSpec().findNativePlanFile(lookup));
  throwIfAborted(options.signal);
  if (!planPath) {
    throw new Error(`Could not resolve planfile path for plan_name ${input.planName}`);
  }
  const validatePlanWireName = mcpWireNameForText("validate_plan", input.content);
  if (input.existingPolicy === "reject" && fs.existsSync(planPath)) {
    throw new Error(appendPlanfileValidationWorkflow(
      `Planfile already exists for plan_name ${input.planName}: ${planPath}. Do not call create_planfile again for this plan; edit the existing planfile directly.`,
      planPath,
      validatePlanWireName,
    ));
  }
  let previousContent: string | null = null;
  if (input.existingPolicy === "overwrite") {
    throwIfAborted(options.signal);
    try {
      previousContent = await fs.promises.readFile(planPath, "utf-8");
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  throwIfAborted(options.signal);
  await fs.promises.mkdir(path.dirname(planPath), { recursive: true });
  throwIfAborted(options.signal);
  await fs.promises.writeFile(planPath, normalizePlanContent(input.planName, planPath, input.content), "utf-8");
  throwIfAborted(options.signal);
  const validation = await validatePlanFileWithContract({
    workingDir: input.workingDir,
    planFile: planPath,
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
  }, options);
  throwIfAborted(options.signal);
  if (validation.status === "FAIL" && previousContent?.trim()) {
    await fs.promises.writeFile(planPath, previousContent, "utf-8");
  }

  return { planPath, validation };
}

export async function runCreatePlanfileAgent(
  input: CreatePlanfileInput,
  options: CancellationOptions = {},
): Promise<string> {
  throwIfAborted(options.signal);
  const sessionDir = getAgentFrameworkSessionDir();
  const { planPath, validation } = await createPlanfileAndValidate({
    ...input,
    sessionDir,
    workingDir: process.cwd(),
    existingPolicy: "reject",
  }, options);
  throwIfAborted(options.signal);
  const validatePlanWireName = mcpWireNameForText("validate_plan", input.content);
  const reasons = validation.reasons.length > 0 ? validation.reasons.join("\n") : "(none)";
  const failureReminder = validation.status === "FAIL"
    ? `\n\n${appendPlanfileValidationWorkflow("Do not call create_planfile again for this plan; edit the created planfile directly.", planPath, validatePlanWireName)}`
    : "";
  const validationDetails = validation.status === "PASS" && validation.reasons.length === 0
    ? `## Instructions
${formatPlanValidationPassInstructions(input.continueWorkflow)}`
    : `## Reasons
${reasons}${failureReminder}`;
  return `Created planfile: ${planPath}

## Results
- Status: ${validation.status}

${validationDetails}`;
}
