import type { ToolRequirement } from "../../src/utils/prediction-schema.js";

export type RequirementSignature = {
  tool: string;
  input?: Record<string, string | number | boolean>;
  inputArrayLengths?: Record<string, number>;
  inputRequiredKeys?: string[];
};

type RequirementLike = Pick<ToolRequirement, "tool" | "input" | "inputArrayLengths" | "inputRequiredKeys">;

export function req(
  tool: string,
  input?: Record<string, string | number | boolean>,
  inputArrayLengths?: Record<string, number>,
  inputRequiredKeys?: string[],
): RequirementSignature {
  return {
    tool,
    ...(input ? { input } : {}),
    ...(inputArrayLengths ? { inputArrayLengths } : {}),
    ...(inputRequiredKeys ? { inputRequiredKeys } : {}),
  };
}

export function waitReq(targetCount: number): RequirementSignature {
  return req("TaskOutput", undefined, { targets: targetCount });
}

export function repeatReq(
  count: number,
  tool: string,
  input?: Record<string, string | number | boolean>,
): RequirementSignature[] {
  return Array.from({ length: count }, () => req(tool, input));
}

export function requirementSignature(requirement: RequirementLike): RequirementSignature {
  return {
    tool: requirement.tool,
    ...(requirement.input ? { input: requirement.input } : {}),
    ...(requirement.inputArrayLengths ? { inputArrayLengths: requirement.inputArrayLengths } : {}),
    ...(requirement.inputRequiredKeys ? { inputRequiredKeys: requirement.inputRequiredKeys } : {}),
  };
}

export function implementWorkflowRequirementSignatures(): RequirementSignature[] {
  return [
    req("mcp-implement", undefined, undefined, ["working_dir"]),
  ];
}

export function codexPlan3InitialAgentBatchRequirements(): RequirementSignature[] {
  return [
    ...repeatReq(3, "Agent", { subagent_type: "default" }),
    waitReq(3),
  ];
}

export function codexPlan3AfterFirstAgentRequirements(): RequirementSignature[] {
  return [
    ...repeatReq(2, "Agent", { subagent_type: "default" }),
    waitReq(3),
  ];
}

export function codexPlan3AfterAgentBatchRequirements(): RequirementSignature[] {
  return [waitReq(3)];
}
