import { z } from "zod";
import { jsonValueSchema } from "../protocol/common.js";
import { scenarioCommandSchema } from "../protocol/commands.js";
import { scenarioRecordSchema } from "../protocol/records.js";
import { scenarioSnapshotSchema } from "../protocol/snapshot.js";
import { scenarioProtocolSchemaDigest } from "../protocol/schema.js";
import { scenarioNameSchema } from "../name.js";
import { scenarioTerminalStatusSchema } from "../runtime/results.js";

const currentScenarioProtocolDigest = scenarioProtocolSchemaDigest();

export const fixtureEffectOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    result: jsonValueSchema,
    metadata: z.record(z.string(), jsonValueSchema).optional(),
  }).strict(),
  z.object({
    outcome: z.literal("failed"),
    error: z.string().min(1),
  }).strict(),
  z.object({
    outcome: z.literal("cancelled"),
    reason: z.string().min(1),
  }).strict(),
]);
export type FixtureEffectOutcome = z.infer<typeof fixtureEffectOutcomeSchema>;

export const fixtureEffectPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("deterministic"),
    outcomes: z.record(z.string(), fixtureEffectOutcomeSchema),
    rejectUnexpected: z.boolean().default(true),
    allowUndeclaredToolPolicy: z.boolean().default(false),
  }).strict(),
  z.object({ mode: z.literal("live") }).strict(),
]);
export type FixtureEffectPolicy = z.infer<typeof fixtureEffectPolicySchema>;

const recordExpectationSchema = z.object({
  kind: z.literal("record"),
  eventType: scenarioRecordSchema.shape.eventType.optional(),
  commandId: z.string().min(1).optional(),
  entityKind: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  payloadContains: z.record(z.string(), jsonValueSchema).optional(),
  count: z.number().int().nonnegative().default(1),
}).strict();

const snapshotExpectationSchema = z.object({
  kind: z.literal("snapshot"),
  path: z.string().min(1),
  equals: jsonValueSchema,
}).strict();

const snapshotOneOfExpectationSchema = z.object({
  kind: z.literal("snapshotOneOf"),
  path: z.string().min(1),
  values: z.array(jsonValueSchema).min(1),
}).strict();

const snapshotStringContainsExpectationSchema = z.object({
  kind: z.literal("snapshotStringContains"),
  path: z.string().min(1),
  value: z.string().min(1),
}).strict();

const snapshotArrayMinLengthExpectationSchema = z.object({
  kind: z.literal("snapshotArrayMinLength"),
  path: z.string().min(1),
  minLength: z.number().int().nonnegative(),
}).strict();

const commandExpectationSchema = z.object({
  kind: z.literal("commandResult"),
  commandId: z.string().min(1),
  status: scenarioTerminalStatusSchema,
  reasonContains: z.string().min(1).optional(),
}).strict();

const absentRecordExpectationSchema = z.object({
  kind: z.literal("absentRecord"),
  eventType: scenarioRecordSchema.shape.eventType,
}).strict();

export const fixtureExpectationSchema = z.discriminatedUnion("kind", [
  recordExpectationSchema,
  snapshotExpectationSchema,
  snapshotOneOfExpectationSchema,
  snapshotStringContainsExpectationSchema,
  snapshotArrayMinLengthExpectationSchema,
  commandExpectationSchema,
  absentRecordExpectationSchema,
]);
export type FixtureExpectation = z.infer<typeof fixtureExpectationSchema>;

export const scenarioFixtureSchema = z.object({
  name: scenarioNameSchema,
  description: z.string().optional(),
  initialRun: z.object({
    startCommand: scenarioCommandSchema,
    snapshot: scenarioSnapshotSchema.optional(),
    seedRecords: z.array(scenarioRecordSchema).default([]),
  }).strict(),
  commands: z.array(scenarioCommandSchema),
  effects: fixtureEffectPolicySchema,
  expectations: z.array(fixtureExpectationSchema),
}).strict().superRefine((fixture, ctx) => {
  const { startCommand, snapshot, seedRecords } = fixture.initialRun;
  if (startCommand.payload.type !== "startRun") {
    ctx.addIssue({ code: "custom", path: ["initialRun", "startCommand", "payload"], message: "must be startRun" });
  } else if (startCommand.payload.schemaDigest !== currentScenarioProtocolDigest) {
    ctx.addIssue({
      code: "custom",
      path: ["initialRun", "startCommand", "payload", "schemaDigest"],
      message: `must equal the current Scenario protocol digest ${currentScenarioProtocolDigest}`,
    });
  }
  if (startCommand.source.kind !== "scenarioFixture") {
    ctx.addIssue({ code: "custom", path: ["initialRun", "startCommand", "source", "kind"], message: "must be scenarioFixture" });
  }
  const runId = startCommand.runId;
  for (const [index, command] of fixture.commands.entries()) {
    if (command.runId !== runId) {
      ctx.addIssue({ code: "custom", path: ["commands", index, "runId"], message: "must match startCommand.runId" });
    }
    if (command.payload.type === "startRun") {
      ctx.addIssue({ code: "custom", path: ["commands", index, "payload"], message: "startRun belongs in initialRun" });
    }
  }
  if (snapshot || seedRecords.length > 0) {
    if (snapshot) {
      if (snapshot.runId !== runId) {
        ctx.addIssue({ code: "custom", path: ["initialRun", "snapshot", "runId"], message: "must match startCommand.runId" });
      }
      if (snapshot.lastRecordSeq !== seedRecords.length) {
        ctx.addIssue({
          code: "custom",
          path: ["initialRun", "snapshot", "lastRecordSeq"],
          message: "must equal seedRecords.length",
        });
      }
    }
    for (const [index, record] of seedRecords.entries()) {
      if (record.runId !== runId) {
        ctx.addIssue({ code: "custom", path: ["initialRun", "seedRecords", index, "runId"], message: "must match startCommand.runId" });
      }
      if (record.recordSeq !== index + 1) {
        ctx.addIssue({ code: "custom", path: ["initialRun", "seedRecords", index, "recordSeq"], message: `must equal ${index + 1}` });
      }
    }
  }
});
export type ScenarioFixture = z.infer<typeof scenarioFixtureSchema>;

export type FixtureExpectationResult = {
  expectation: FixtureExpectation;
  pass: boolean;
  message: string;
};

export type ScenarioFixtureReport = {
  fixtureName: string;
  runId: string;
  pass: boolean;
  commandResults: Record<string, unknown>;
  expectationResults: FixtureExpectationResult[];
  finalSnapshot: z.infer<typeof scenarioSnapshotSchema>;
  records: Array<z.infer<typeof scenarioRecordSchema>>;
};
