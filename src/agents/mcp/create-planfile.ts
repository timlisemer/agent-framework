import * as fs from "fs";
import * as path from "path";
import { activeSpec, mcpWireNameForText } from "../../adapter/spec.js";
import { appendPlanfileValidationWorkflow, getPathToPlanfile } from "../../utils/planfile.js";
import { writeCurrentPlanSidecar } from "../../utils/plan-source.js";
import { getAgentFrameworkSessionDir } from "../../utils/paths.js";
import { validatePlanFileWithContract } from "./validate-plan.js";

export interface CreatePlanfileInput {
  planName: string;
  content: string;
}

function normalizePlanContent(planName: string, planPath: string, content: string): string {
  let body = content.trim();
  body = body.replace(/^\s*Plan Name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*\n+/i, "");
  body = body.replace(/\n+\s*Planfile Path:\s*.+\s*\n\s*Plan Name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/i, "");
  return `Plan Name: ${planName}\n\n${body.trim()}\n\nPlanfile Path: ${planPath}\nPlan Name: ${planName}\n`;
}

export async function runCreatePlanfileAgent(input: CreatePlanfileInput): Promise<string> {
  const sessionDir = getAgentFrameworkSessionDir();
  const planPath = await getPathToPlanfile({
    transcriptPath: "",
    sessionDir,
    planName: input.planName,
  }, (lookup) => activeSpec().findNativePlanFile(lookup));
  if (!planPath) {
    throw new Error(`Could not resolve planfile path for plan_name ${input.planName}`);
  }
  const validatePlanWireName = mcpWireNameForText("validate_plan", input.content);
  if (fs.existsSync(planPath)) {
    throw new Error(appendPlanfileValidationWorkflow(
      `Planfile already exists for plan_name ${input.planName}: ${planPath}. Do not call create_planfile again for this plan; edit the existing planfile directly.`,
      planPath,
      validatePlanWireName,
    ));
  }

  await fs.promises.mkdir(path.dirname(planPath), { recursive: true });
  await fs.promises.writeFile(planPath, normalizePlanContent(input.planName, planPath, input.content), "utf-8");
  const validation = await validatePlanFileWithContract({
    workingDir: process.cwd(),
    planFile: planPath,
    sessionDir,
  });
  if (validation.status === "PASS") {
    writeCurrentPlanSidecar(sessionDir, { kind: "file", path: planPath, planName: input.planName });
  }

  const reasons = validation.reasons.length > 0 ? validation.reasons.join("\n") : "(none)";
  const failureReminder = validation.status === "FAIL"
    ? `\n\n${appendPlanfileValidationWorkflow("Do not call create_planfile again for this plan; edit the created planfile directly.", planPath, validatePlanWireName)}`
    : "";
  return `Created planfile: ${planPath}

## Results
- Status: ${validation.status}

## Reasons
${reasons}${failureReminder}`;
}
