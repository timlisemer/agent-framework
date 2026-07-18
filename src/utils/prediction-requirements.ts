import { toolRequirementSchema, type ToolRequirement } from "./prediction-schema.js";

export function validateToolRequirements(
  value: unknown,
  label: string,
): asserts value is ToolRequirement[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when set`);
  }

  for (let i = 0; i < value.length; i++) {
    const parsed = toolRequirementSchema.safeParse(value[i]);
    if (parsed.success) continue;

    const issue = parsed.error.issues[0];
    if (!issue) {
      throw new Error(`${label}[${i}] is invalid`);
    }
    const suffix = issue.path.length > 0
      ? `.${issue.path.map((part) => String(part)).join(".")}`
      : "";
    throw new Error(`${label}[${i}]${suffix} is invalid: ${issue.message}`);
  }
}
