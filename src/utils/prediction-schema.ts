import { z } from "zod";

export const moodSchema = z.enum(["angry", "frustrated", "neutral", "satisfied", "happy"]);
export type Mood = z.infer<typeof moodSchema>;

export const trustSchema = z.enum(["low", "normal", "high"]);
export type Trust = z.infer<typeof trustSchema>;

const scalarRequirementValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const toolRequirementSchema = z.object({
  tool: z.string().min(1),
  input: z.record(z.string().min(1), scalarRequirementValueSchema).optional(),
  inputArrayLengths: z.record(z.string().min(1), z.number().int().nonnegative()).optional(),
  inputRequiredKeys: z.array(z.string()).optional(),
  inputSubstrings: z.array(z.string()).optional(),
  reason: z.string().optional(),
}).strict().superRefine((requirement, ctx) => {
  if (requirement.tool === "Read" && (requirement.inputSubstrings?.length ?? 0) > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["inputSubstrings"],
      message: "Read requirements must express exact targets with path or file_path inputs",
    });
  }
});
export type ToolRequirement = z.infer<typeof toolRequirementSchema>;

export const toolPredictionSchema = z.object({
  mood: moodSchema,
  trust: trustSchema,
  intent: z.string(),
  blockedIntent: z.string(),
  explicitlyAllowedTools: z.array(z.string()),
  explicitlyRequiredTools: z.array(toolRequirementSchema).optional(),
  nonBlockingTools: z.array(toolRequirementSchema).optional(),
  explicitlyBlockedSubstrings: z.array(z.object({
    tool: z.string(),
    targetSubstring: z.string().optional(),
    reason: z.string(),
  }).strict()),
  blockAllTools: z.boolean().optional(),
  userMessageFull: z.string().optional(),
  userMessageSnippet: z.string(),
  timestamp: z.number().finite(),
  contextSwitch: z.enum(["yes", "no"]).optional(),
  questionIsStalling: z.enum(["yes", "no", "n/a"]).optional(),
  hasExplicitOverride: z.boolean().optional(),
}).strict();
export type ToolPrediction = z.infer<typeof toolPredictionSchema>;

