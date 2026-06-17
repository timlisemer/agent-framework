import { z } from "zod";
import type { ToolRequirement } from "./prediction-types.js";

const scalarRequirementValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const toolRequirementSchema = z.object({
  tool: z.string().min(1),
  input: z.record(z.string().min(1), scalarRequirementValueSchema).optional(),
  inputArrayLengths: z.record(z.string().min(1), z.number().int().nonnegative()).optional(),
  inputSubstrings: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

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
