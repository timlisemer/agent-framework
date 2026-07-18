import { z } from "zod";
import {
  idSchema,
  jsonValueSchema,
  timestampSchema,
  visibilitySchema,
} from "./common.js";

export const scenarioEventTypes = [
  "command.accepted",
  "command.completed",
  "command.rejected",
  "run.started",
  "run.resumed",
  "run.closed",
  "run.cancelled",
  "capabilities.declared",
  "extension.observed",
  "message.userSubmitted",
  "message.assistantObserved",
  "message.assistantCompleted",
  "message.observed",
  "message.retired",
  "tool.requested",
  "tool.executionStarted",
  "tool.outputAppended",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "tool.retired",
  "tool.authorization.policyResolved",
  "tool.authorization.userDecisionPending",
  "tool.authorization.userDecisionSubmitted",
  "tool.authorization.userUnavailable",
  "tool.authorization.finalResolved",
  "state.sliceChanged",
  "store.diagnostic",
  "effect.requested",
  "effect.started",
  "effect.claimRenewed",
  "effect.progressed",
  "effect.completed",
  "effect.failed",
  "effect.cancelled",
  "provider.stateObserved",
  "plan.stateChanged",
  "continuation.stateChanged",
  "artifact.linked",
  "feedback.changed",
  "transcript.observed",
  "recovery.completed",
  "runtime.error",
] as const;

export const scenarioEventTypeSchema = z.enum(scenarioEventTypes);
export type ScenarioEventType = z.infer<typeof scenarioEventTypeSchema>;

export const scenarioEntityRefSchema = z.object({
  kind: z.string().min(1),
  id: idSchema,
}).strict();

export const scenarioRecordSchema = z.object({
  runId: idSchema,
  recordSeq: z.number().int().positive(),
  recordId: idSchema,
  recordedAt: timestampSchema,
  commandId: idSchema,
  correlationId: idSchema.optional(),
  causationId: idSchema.optional(),
  eventType: scenarioEventTypeSchema,
  entityRef: scenarioEntityRefSchema.optional(),
  visibility: visibilitySchema,
  payload: z.record(z.string(), jsonValueSchema),
}).strict();
export type ScenarioRecord = z.infer<typeof scenarioRecordSchema>;

export const eventBatchSchema = z.object({
  runId: idSchema,
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  baseSnapshotRevision: z.number().int().nonnegative(),
  resultingSnapshotRevision: z.number().int().positive(),
  records: z.array(scenarioRecordSchema),
}).strict().superRefine((batch, ctx) => {
  if (batch.fromSeq > batch.toSeq) {
    ctx.addIssue({ code: "custom", message: "fromSeq must be less than or equal to toSeq" });
  }
  if (batch.records.length !== batch.toSeq - batch.fromSeq + 1) {
    ctx.addIssue({ code: "custom", message: "records must exactly cover the declared sequence range" });
  }
  for (const [index, record] of batch.records.entries()) {
    if (record.runId !== batch.runId) {
      ctx.addIssue({
        code: "custom",
        path: ["records", index, "runId"],
        message: "record runId must match the batch runId",
      });
    }
    if (record.recordSeq !== batch.fromSeq + index) {
      ctx.addIssue({
        code: "custom",
        path: ["records", index, "recordSeq"],
        message: "recordSeq must match its position in the batch range",
      });
    }
  }
});
export type EventBatch = z.infer<typeof eventBatchSchema>;
