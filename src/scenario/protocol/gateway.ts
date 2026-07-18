import { z } from "zod";
import { artifactRefSchema } from "./artifacts.js";
import { scenarioCommandSchema, toolDecisionSchema } from "./commands.js";
import {
  idSchema,
  jsonValueSchema,
  runtimeHomeDescriptorSchema,
} from "./common.js";
import { feedbackSubmissionFields, requireStableFeedbackTarget } from "./feedback.js";
import { eventBatchSchema, scenarioRecordSchema } from "./records.js";
import { scenarioSnapshotSchema } from "./snapshot.js";

export const scenarioGatewayScopes = [
  "run.list",
  "run.read",
  "run.control",
  "tool.decide",
  "feedback.write",
  "artifact.read",
  "state.inspectSensitive",
] as const;
export type ScenarioGatewayScope = typeof scenarioGatewayScopes[number];

export const scenarioGatewayErrorCodeValues = [
  "incompatible_schema",
  "protocol_not_negotiated",
  "invalid_request",
  "runtime_error",
  "permission_denied",
  "cursor_gap",
  "snapshot_revision_conflict",
  "feedback_target_conflict",
  "gateway_error",
] as const;
export const scenarioGatewayErrorCodeSchema = z.enum(scenarioGatewayErrorCodeValues);
export type ScenarioGatewayErrorCode = z.infer<typeof scenarioGatewayErrorCodeSchema>;

export const scenarioHelloSchema = z.object({
  type: z.literal("hello"),
  client: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
  capabilities: z.array(z.string()),
  schemaDigests: z.array(z.string()),
}).strict();
export type ScenarioHello = z.infer<typeof scenarioHelloSchema>;

export const scenarioWelcomeSchema = z.object({
  type: z.literal("welcome"),
  subjectId: idSchema,
  engineVersion: z.string().min(1),
  schemaDigest: z.string().min(1),
  capabilities: z.array(z.string()),
  maximumFrameBytes: z.number().int().positive(),
  maximumArtifactBytes: z.number().int().positive(),
  visibilityScope: z.array(z.string()),
  extensionSchemas: z.array(z.object({ schemaId: z.string() }).strict()),
}).strict();

export const providerRunConfigSchema = z.object({
  model: z.string().nullable(),
  workingDir: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  continuable: z.boolean(),
  sdkRuntimeEnvironment: idSchema,
  runtimeHome: runtimeHomeDescriptorSchema,
}).strict();
export type ProviderRunConfig = z.infer<typeof providerRunConfigSchema>;

export const providerResumeTargetSchema = z.object({
  sdkRuntime: idSchema,
  nativeSessionId: idSchema,
}).strict();
export type ProviderResumeTarget = z.infer<typeof providerResumeTargetSchema>;

export const gatewayRequestPayloadSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("listRuns") }).strict(),
  z.object({
    operation: z.literal("startProviderRun"),
    config: providerRunConfigSchema,
  }).strict(),
  z.object({
    operation: z.literal("resumeProviderRun"),
    runId: idSchema,
    config: providerRunConfigSchema,
    target: providerResumeTargetSchema,
  }).strict(),
  z.object({
    operation: z.literal("sendConversationInput"),
    runId: idSchema,
    turnId: idSchema,
    input: z.string(),
  }).strict(),
  z.object({
    operation: z.literal("cancelProviderTurn"),
    runId: idSchema,
    turnId: idSchema.nullable(),
  }).strict(),
  z.object({ operation: z.literal("closeProviderRun"), runId: idSchema }).strict(),
  z.object({ operation: z.literal("attachRun"), runId: idSchema }).strict(),
  z.object({ operation: z.literal("getSnapshot"), runId: idSchema }).strict(),
  z.object({ operation: z.literal("recordsAfter"), runId: idSchema, afterSeq: z.number().int().nonnegative() }).strict(),
  z.object({ operation: z.literal("subscribe"), runId: idSchema, afterSeq: z.number().int().nonnegative() }).strict(),
  z.object({ operation: z.literal("unsubscribe"), runId: idSchema }).strict(),
  z.object({ operation: z.literal("dispatch"), command: scenarioCommandSchema }).strict(),
  z.object({
    operation: z.literal("submitToolDecision"),
    runId: idSchema,
    toolCallId: idSchema,
    decision: toolDecisionSchema,
    reason: z.string().nullable(),
    expectedSnapshotRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    operation: z.literal("submitFeedback"),
    runId: idSchema,
    ...feedbackSubmissionFields,
  }).strict(),
  z.object({ operation: z.literal("fetchArtifact"), runId: idSchema, artifact: artifactRefSchema }).strict(),
]);

export const scenarioGatewayOperations = gatewayRequestPayloadSchema.options.map(
  (option) => option.shape.operation.value,
);
export type ScenarioGatewayOperation = typeof scenarioGatewayOperations[number];
export const scenarioGatewayOperationScopes = {
  listRuns: "run.list",
  startProviderRun: "run.control",
  resumeProviderRun: "run.control",
  sendConversationInput: "run.control",
  cancelProviderTurn: "run.control",
  closeProviderRun: "run.control",
  attachRun: "run.read",
  getSnapshot: "run.read",
  recordsAfter: "run.read",
  subscribe: "run.read",
  unsubscribe: "run.read",
  dispatch: "run.control",
  submitToolDecision: "tool.decide",
  submitFeedback: "feedback.write",
  fetchArtifact: "artifact.read",
} as const satisfies Record<ScenarioGatewayOperation, ScenarioGatewayScope>;

export const scenarioGatewayRequestSchema = z.object({
  type: z.literal("request"),
  requestId: idSchema,
  payload: gatewayRequestPayloadSchema,
}).strict().superRefine((request, ctx) => {
  if (
    request.payload.operation === "submitFeedback"
  ) {
    requireStableFeedbackTarget(request.payload, ctx, ["payload"]);
  }
});
export type ScenarioGatewayRequest = z.infer<typeof scenarioGatewayRequestSchema>;

export const runDescriptorSchema = z.object({
  runId: idSchema,
  status: z.string(),
  source: z.record(z.string(), jsonValueSchema),
  workingDir: z.string().nullable(),
  updatedAt: z.string(),
  capabilities: z.record(z.string(), z.boolean()),
}).strict();

export const gatewayResponsePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runs"), runs: z.array(runDescriptorSchema) }).strict(),
  z.object({ kind: z.literal("attached"), snapshot: scenarioSnapshotSchema, cursor: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("snapshot"), snapshot: scenarioSnapshotSchema }).strict(),
  z.object({ kind: z.literal("records"), records: z.array(scenarioRecordSchema) }).strict(),
  z.object({ kind: z.literal("accepted"), result: jsonValueSchema }).strict(),
  z.object({ kind: z.literal("artifact"), artifact: artifactRefSchema, bytesBase64: z.string() }).strict(),
  z.object({
    kind: z.literal("error"),
    code: scenarioGatewayErrorCodeSchema,
    message: z.string(),
    recoverable: z.boolean(),
  }).strict(),
]);

export const scenarioGatewayResponseSchema = z.object({
  type: z.literal("response"),
  requestId: idSchema,
  ok: z.boolean(),
  payload: gatewayResponsePayloadSchema,
}).strict();
export type ScenarioGatewayResponse = z.infer<typeof scenarioGatewayResponseSchema>;

export const scenarioGatewayEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("eventBatch"),
    batch: eventBatchSchema,
  }).strict(),
  z.object({
    type: z.literal("resyncRequired"),
    runId: idSchema,
    expectedNextSeq: z.number().int().positive(),
    receivedFromSeq: z.number().int().positive().nullable(),
    reason: z.string().min(1),
  }).strict(),
]);
export type ScenarioGatewayEvent = z.infer<typeof scenarioGatewayEventSchema>;

export const scenarioClientFrameSchema = z.union([scenarioHelloSchema, scenarioGatewayRequestSchema]);
export type ScenarioClientFrame = z.infer<typeof scenarioClientFrameSchema>;
export const scenarioBackendFrameSchema = z.union([
  scenarioWelcomeSchema,
  scenarioGatewayResponseSchema,
  scenarioGatewayEventSchema,
]);
export type ScenarioBackendFrame = z.infer<typeof scenarioBackendFrameSchema>;
