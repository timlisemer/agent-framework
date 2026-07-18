import { activeSpec } from "../adapter/spec.js";
import {
  toolRequirementMatches,
} from "./prediction-types.js";
import type { ToolPrediction } from "./prediction-schema.js";

export type CreatePlanfileAuthorization = "workflow" | "plan-mode";

export interface CreatePlanfileAuthorizationInput {
  toolName: string;
  rawToolName?: string;
  toolInput?: unknown;
  planMode: boolean;
  currentPrediction?: Pick<ToolPrediction, "explicitlyRequiredTools"> | null;
}

export function isCreatePlanfileTool(toolName: string, rawToolName?: string): boolean {
  if (toolName === "mcp-create_planfile" || rawToolName === "mcp-create_planfile") return true;
  const spec = activeSpec();
  return spec.recognizeMcp(toolName) === "create_planfile" ||
    (rawToolName ? spec.recognizeMcp(rawToolName) === "create_planfile" : false);
}

function createPlanfileRequiredByWorkflow(input: CreatePlanfileAuthorizationInput): boolean {
  const nextRequiredTool = input.currentPrediction?.explicitlyRequiredTools?.[0];
  return !!nextRequiredTool &&
    toolRequirementMatches(nextRequiredTool, input.toolName, input.toolInput);
}

export function createPlanfileAuthorization(
  input: CreatePlanfileAuthorizationInput,
): CreatePlanfileAuthorization | null {
  if (!isCreatePlanfileTool(input.toolName, input.rawToolName)) return null;
  if (createPlanfileRequiredByWorkflow(input)) return "workflow";
  if (input.planMode) return "plan-mode";
  return null;
}
