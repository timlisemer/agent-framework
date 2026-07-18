import { z } from "zod";
import { jsonValueSchema } from "../protocol/common.js";

export const scenarioTerminalStatusValues = [
  "accepted",
  "allowed",
  "denied",
  "userDecisionRequired",
  "contextReturned",
  "stopBlocked",
  "cancelled",
  "failed",
] as const;

export const scenarioTerminalStatusSchema = z.enum(scenarioTerminalStatusValues);
export type ScenarioTerminalStatus = z.infer<typeof scenarioTerminalStatusSchema>;

export const scenarioTerminalResultSchema = z.object({
  status: scenarioTerminalStatusSchema,
  reason: z.string().optional(),
  data: z.record(z.string(), jsonValueSchema).optional(),
}).strict();
export type ScenarioTerminalResult = z.infer<typeof scenarioTerminalResultSchema>;
