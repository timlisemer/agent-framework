import { z } from "zod";
import { runCapabilitiesSchema } from "./capabilities.js";
import {
  idSchema,
  jsonValueSchema,
  runSourceSchema,
  runtimeHomeDescriptorSchema,
  scenarioStoragePolicySchema,
  sha256DigestSchema,
  timestampSchema,
} from "./common.js";
import {
  feedbackAuthorSchema,
  feedbackSubmissionFields,
  requireStableFeedbackTarget,
} from "./feedback.js";
import { scenarioEffectProjectionSchema } from "./effects.js";
import {
  scenarioMessageStatusSchema,
  scenarioToolStatusSchema,
  stateSliceMutationSchema,
} from "./snapshot.js";

export const toolDecisionValues = ["approve", "deny"] as const;
export const toolDecisionSchema = z.enum(toolDecisionValues);
export type ToolDecision = z.infer<typeof toolDecisionSchema>;

const startRunPayloadSchema = z.object({
  type: z.literal("startRun"),
  workingDir: z.string().nullable(),
  projectDir: z.string().nullable(),
  capabilities: runCapabilitiesSchema,
  storagePolicy: scenarioStoragePolicySchema,
  runtimeHome: runtimeHomeDescriptorSchema,
  engineVersion: z.string().min(1),
  schemaDigest: z.string().min(1),
  configuration: z.record(z.string(), jsonValueSchema),
}).strict();

const messagePayloadSchema = z.object({
  type: z.enum(["userMessageSubmitted", "assistantMessageObserved", "assistantMessageCompleted"]),
  messageId: idSchema,
  turnId: idSchema.nullable(),
  content: z.string(),
  contentDigest: sha256DigestSchema,
  usage: jsonValueSchema.optional(),
}).strict();

const toolObservationFieldsSchema = z.object({
  toolCallId: idSchema,
  turnId: idSchema.nullable(),
  name: z.string().min(1),
  input: jsonValueSchema,
  inputDigest: sha256DigestSchema,
}).strict();

const toolRequestedPayloadSchema = toolObservationFieldsSchema.extend({
  type: z.literal("toolRequested"),
  requiresUserDecision: z.boolean().default(false),
}).strict();

const toolExecutionObservedPayloadSchema = toolObservationFieldsSchema.extend({
  type: z.literal("toolExecutionObserved"),
}).strict();

const toolLifecyclePayloadSchema = z.object({
  type: z.enum([
    "toolExecutionStarted",
    "toolOutputAppended",
    "toolCompleted",
    "toolFailed",
    "toolCancelled",
  ]),
  toolCallId: idSchema,
  output: jsonValueSchema.optional(),
  error: z.string().optional(),
}).strict();

const stateSlicePayloadSchema = stateSliceMutationSchema.extend({
  type: z.literal("stateSliceChanged"),
}).strict();

const extensionCommandPayloadSchema = z.object({
  type: z.literal("extensionCommand"),
  extensionId: idSchema,
  data: jsonValueSchema,
}).strict();

const feedbackPayloadSchema = z.object({
  type: z.literal("submitFeedback"),
  ...feedbackSubmissionFields,
  author: feedbackAuthorSchema,
}).strict().superRefine((payload, ctx) => requireStableFeedbackTarget(payload, ctx));

const requestEffectPayloadSchema = z.object({
  type: z.literal("requestEffect"),
  effectId: idSchema,
  effectType: z.string().min(1),
  parameters: jsonValueSchema.optional(),
}).strict();

const effectStartedPayloadSchema = z.object({
  type: z.literal("effectStarted"),
  effectId: idSchema,
  effectType: z.string().min(1),
  claimId: idSchema,
  previousClaimId: idSchema.optional(),
}).strict();

const effectClaimRenewedPayloadSchema = z.object({
  type: z.literal("effectClaimRenewed"),
  effectId: idSchema,
  effectType: z.string().min(1),
  claimId: idSchema,
}).strict();

const effectResultPayloadSchema = z.object({
  type: z.literal("effectResultSupplied"),
  effectId: idSchema,
  claimId: idSchema,
  result: jsonValueSchema.optional(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
  projection: scenarioEffectProjectionSchema.optional(),
}).strict();

const effectFailedPayloadSchema = z.object({
  type: z.literal("effectFailed"),
  effectId: idSchema,
  effectType: z.string().min(1),
  claimId: idSchema,
  error: z.string().min(1),
}).strict();

const effectCancelledPayloadSchema = z.object({
  type: z.literal("effectCancelled"),
  effectId: idSchema,
  effectType: z.string().min(1),
  claimId: idSchema,
  reason: z.string().min(1),
}).strict();

const effectProgressPayloadSchema = z.object({
  type: z.literal("effectProgressed"),
  effectId: idSchema,
  claimId: idSchema,
  progress: jsonValueSchema,
}).strict();

export const nativeTranscriptDataSchema = z.object({
  digest: sha256DigestSchema.optional(),
  messages: z.array(z.object({
    id: idSchema,
    turnId: idSchema.nullable(),
    role: z.enum(["user", "assistant", "system", "synthetic"]),
    content: z.string(),
    contentDigest: sha256DigestSchema,
    status: scenarioMessageStatusSchema,
    usage: jsonValueSchema.optional(),
  }).strict()).default([]),
  tools: z.array(z.object({
    id: idSchema,
    turnId: idSchema.nullable(),
    name: z.string().min(1),
    input: jsonValueSchema,
    inputDigest: sha256DigestSchema,
    status: scenarioToolStatusSchema,
    output: z.array(jsonValueSchema).default([]),
    error: z.string().nullable().default(null),
  }).strict()).default([]),
}).strict();
export type NativeTranscriptData = z.infer<typeof nativeTranscriptDataSchema>;

const nativeTranscriptObservedPayloadSchema = z.object({
  type: z.literal("nativeTranscriptObserved"),
  data: nativeTranscriptDataSchema.optional(),
}).strict();

const genericPayloadSchema = z.object({
  type: z.enum([
    "resumeRun",
    "closeRun",
    "cancelRun",
    "providerStateObserved",
    "planStateChanged",
    "continuationStateChanged",
    "runtimeErrorObserved",
  ]),
  data: jsonValueSchema.optional(),
}).strict();

const toolDecisionPayloadSchema = z.object({
  type: z.literal("toolDecisionSubmitted"),
  toolCallId: idSchema,
  decision: toolDecisionSchema,
  reason: z.string().nullable(),
}).strict();

export const scenarioCommandPayloadSchema = z.discriminatedUnion("type", [
  startRunPayloadSchema,
  messagePayloadSchema,
  toolRequestedPayloadSchema,
  toolExecutionObservedPayloadSchema,
  extensionCommandPayloadSchema,
  toolLifecyclePayloadSchema,
  stateSlicePayloadSchema,
  feedbackPayloadSchema,
  requestEffectPayloadSchema,
  effectStartedPayloadSchema,
  effectClaimRenewedPayloadSchema,
  effectResultPayloadSchema,
  effectFailedPayloadSchema,
  effectCancelledPayloadSchema,
  effectProgressPayloadSchema,
  nativeTranscriptObservedPayloadSchema,
  genericPayloadSchema,
  toolDecisionPayloadSchema,
]);
export type ScenarioCommandPayload = z.infer<typeof scenarioCommandPayloadSchema>;

/** Effect-outbox lifecycle commands, derived from their authoritative schemas. */
export const scenarioEffectLifecycleCommandTypes = [
  ...effectStartedPayloadSchema.shape.type.values,
  ...effectClaimRenewedPayloadSchema.shape.type.values,
  ...effectResultPayloadSchema.shape.type.values,
  ...effectFailedPayloadSchema.shape.type.values,
  ...effectCancelledPayloadSchema.shape.type.values,
  ...effectProgressPayloadSchema.shape.type.values,
] as const satisfies readonly ScenarioCommandPayload["type"][];

const scenarioEffectLifecycleCommandTypeSet: ReadonlySet<string> =
  new Set(scenarioEffectLifecycleCommandTypes);

export function isScenarioEffectLifecycleCommand(
  payload: ScenarioCommandPayload,
): payload is Extract<
  ScenarioCommandPayload,
  { type: typeof scenarioEffectLifecycleCommandTypes[number] }
> {
  return scenarioEffectLifecycleCommandTypeSet.has(payload.type);
}

/** Canonical command vocabulary, derived from the accepted payload schema. */
export const scenarioCommandTypes = scenarioCommandPayloadSchema.options.flatMap(
  (option) => option.shape.type instanceof z.ZodLiteral
    ? [...option.shape.type.values]
    : option.shape.type.options,
) as ScenarioCommandPayload["type"][];

export const scenarioCommandSchema = z.object({
  commandId: idSchema,
  runId: idSchema,
  source: runSourceSchema,
  recordedAt: timestampSchema,
  expectedSnapshotRevision: z.number().int().nonnegative().optional(),
  correlationId: idSchema.optional(),
  causationId: idSchema.optional(),
  payload: scenarioCommandPayloadSchema,
}).strict();
export type ScenarioCommand = z.infer<typeof scenarioCommandSchema>;
