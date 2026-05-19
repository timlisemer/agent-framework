import * as fs from "fs";
import * as path from "path";
import { activeSpec, mcpWireNameForText } from "../../adapter/spec.js";
import { appendPlanfileValidationWorkflow, getPathToPlanfile } from "../../utils/planfile.js";
import { getAgentFrameworkSessionDir, sessionCurrentPlanFile } from "../../utils/paths.js";
import { writeJson } from "../../utils/file-io.js";
import { validatePlanFileWithContract, type PlanValidationRunResult } from "./validate-plan.js";

export interface CreatePlanfileInput {
  planName: string;
  content: string;
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

function writeCurrentPlanSidecar(sessionDir: string, planPath: string, planName: string): void {
  writeJson(sessionCurrentPlanFile(sessionDir), { kind: "file", path: planPath, planName });
}

export async function createPlanfileAndValidate(
  input: CreatePlanfileAndValidateInput,
): Promise<CreatePlanfileAndValidateResult> {
  const planPath = await getPathToPlanfile({
    transcriptPath: input.transcriptPath ?? "",
    sessionDir: input.sessionDir,
    planName: input.planName,
  }, (lookup) => activeSpec().findNativePlanFile(lookup));
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
    try {
      previousContent = await fs.promises.readFile(planPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  await fs.promises.mkdir(path.dirname(planPath), { recursive: true });
  await fs.promises.writeFile(planPath, normalizePlanContent(input.planName, planPath, input.content), "utf-8");
  const validation = await validatePlanFileWithContract({
    workingDir: input.workingDir,
    planFile: planPath,
    transcriptPath: input.transcriptPath,
    sessionDir: input.sessionDir,
  });
  if (validation.status === "FAIL" && previousContent?.trim()) {
    await fs.promises.writeFile(planPath, previousContent, "utf-8");
  }

  return { planPath, validation };
}

export async function runCreatePlanfileAgent(input: CreatePlanfileInput): Promise<string> {
  const sessionDir = getAgentFrameworkSessionDir();
  const { planPath, validation } = await createPlanfileAndValidate({
    ...input,
    sessionDir,
    workingDir: process.cwd(),
    existingPolicy: "reject",
  });
  if (validation.status === "PASS") {
    writeCurrentPlanSidecar(sessionDir, planPath, input.planName);
  }

  const validatePlanWireName = mcpWireNameForText("validate_plan", input.content);
  const reasons = validation.reasons.length > 0 ? validation.reasons.join("\n") : "(none)";
  const failureReminder = validation.status === "FAIL"
    ? `\n\n${appendPlanfileValidationWorkflow("Do not call create_planfile again for this plan; edit the created planfile directly.", planPath, validatePlanWireName)}`
    : "";
  const validationDetails = validation.status === "PASS" && validation.reasons.length === 0
    ? `## Instructions
Now present the finished plan using <proposed_plan>.`
    : `## Reasons
${reasons}${failureReminder}`;
  return `Created planfile: ${planPath}

## Results
- Status: ${validation.status}

${validationDetails}`;
}
