import { z } from "zod";

export const PRIOR_ERROR_SOURCES = [
  "stop-feedback",
  "plan-validation",
  "tool-denial",
  "tool-failure",
] as const;

export const PRIOR_ERROR_PROVENANCE = ["transcript", "tool-log"] as const;

export const priorErrorContextSchema = z.object({
  source: z.enum(PRIOR_ERROR_SOURCES),
  provenance: z.array(z.enum(PRIOR_ERROR_PROVENANCE)),
  gate: z.string().optional(),
  tool: z.string().optional(),
  toolUseId: z.string().optional(),
  text: z.string(),
  index: z.number().int().optional(),
  ts: z.number().optional(),
  isError: z.boolean().optional(),
}).strict();

export type PriorErrorSource = z.infer<typeof priorErrorContextSchema>["source"];
export type PriorErrorContext = z.infer<typeof priorErrorContextSchema>;
