import { z } from "zod";
import { jsonValueSchema, visibilitySchema } from "./common.js";
import { scenarioEntityRefSchema, scenarioEventTypeSchema } from "./records.js";
import { stateSliceMutationSchema } from "./snapshot.js";

/** A trusted executor-owned semantic record projected by a completed effect. */
export const scenarioEffectProjectionRecordSchema = z.object({
  eventType: scenarioEventTypeSchema,
  entityRef: scenarioEntityRefSchema.optional(),
  visibility: visibilitySchema.optional(),
  payload: z.record(z.string(), jsonValueSchema),
  dedupeByEventAndEntity: z.boolean().optional(),
}).strict();
export type ScenarioEffectProjectionRecord = z.infer<typeof scenarioEffectProjectionRecordSchema>;

/** A generic state mutation applied against the latest committed snapshot. */
export const scenarioEffectStateChangeSchema = stateSliceMutationSchema.extend({
  baseValue: jsonValueSchema.optional(),
}).strict();
export type ScenarioEffectStateChange = z.infer<typeof scenarioEffectStateChangeSchema>;

/** Generic effect output interpreted by the Scenario runtime without knowing the effect kind. */
export const scenarioEffectProjectionSchema = z.object({
  records: z.array(scenarioEffectProjectionRecordSchema).default([]),
  stateChanges: z.array(scenarioEffectStateChangeSchema).default([]),
  terminalResult: jsonValueSchema,
}).strict();
export type ScenarioEffectProjection = z.infer<typeof scenarioEffectProjectionSchema>;
