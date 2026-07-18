import { z } from "zod";
import { artifactRefSchema } from "./artifacts.js";
import { runCapabilitiesSchema } from "./capabilities.js";
import {
  idSchema,
  jsonValueSchema,
  runSourceSchema,
  runtimeHomeDescriptorSchema,
  scenarioStoragePolicySchema,
  sha256DigestSchema,
  timestampSchema,
  visibilitySchema,
} from "./common.js";
import { feedbackEntrySchema } from "./feedback.js";

export const stateSliceStatusValues = [
  "uninitialized",
  "loaded",
  "defaulted",
  "validated",
  "expired",
  "recovered",
  "corrupt",
  "writePending",
  "writeFailed",
  "lockContended",
  "lockDegraded",
] as const;
export const stateSliceStatusSchema = z.enum(stateSliceStatusValues);
export type StateSliceStatus = z.infer<typeof stateSliceStatusSchema>;

export const stateSliceSchema = z.object({
  key: z.string().min(1),
  schemaId: z.string().min(1),
  revision: z.number().int().positive(),
  status: stateSliceStatusSchema,
  source: z.string().min(1),
  updatedAt: timestampSchema,
  visibility: visibilitySchema,
  value: jsonValueSchema,
  diagnostics: z.array(z.string()),
}).strict();
export type StateSlice = z.infer<typeof stateSliceSchema>;

/** State-slice fields shared by commands and rule-effect mutations. */
export const stateSliceMutationSchema = stateSliceSchema.omit({
  revision: true,
  updatedAt: true,
}).strict();
export type StateSliceMutation = z.infer<typeof stateSliceMutationSchema>;

export const scenarioMessageStatusValues = ["streaming", "completed", "failed"] as const;
export const scenarioMessageRoleValues = ["user", "assistant", "system", "synthetic"] as const;
export type ScenarioMessageStatus = typeof scenarioMessageStatusValues[number];
export const scenarioMessageStatusSchema = z.enum(scenarioMessageStatusValues);
export const terminalMessageStatusValues = ["completed", "failed"] as const satisfies readonly ScenarioMessageStatus[];
export function isTerminalMessageStatus(status: ScenarioMessageStatus): boolean {
  return terminalMessageStatusValues.includes(status as typeof terminalMessageStatusValues[number]);
}

export const messageSnapshotSchema = z.object({
  id: idSchema,
  turnId: idSchema.nullable(),
  role: z.enum(scenarioMessageRoleValues),
  content: z.string(),
  contentDigest: sha256DigestSchema,
  status: scenarioMessageStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  recordSeq: z.number().int().positive(),
  usage: jsonValueSchema.optional(),
}).strict();
export type MessageSnapshot = z.infer<typeof messageSnapshotSchema>;

export const toolPolicyStatusValues = ["pending", "allowed", "denied", "failed", "notEnforced"] as const;
export const toolUserDecisionStatusValues = ["notRequired", "pending", "approved", "denied", "unavailable"] as const;
export const toolFinalStatusValues = ["pending", "allowed", "denied", "cancelled", "failed", "observed"] as const;
export const toolAuthorizationSchema = z.object({
  policy: z.enum(toolPolicyStatusValues),
  user: z.enum(toolUserDecisionStatusValues),
  final: z.enum(toolFinalStatusValues),
  reason: z.string().nullable(),
}).strict();
export type ToolAuthorization = z.infer<typeof toolAuthorizationSchema>;

export const scenarioToolStatusValues = [
  "requested",
  "waiting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "denied",
] as const;
export type ScenarioToolStatus = typeof scenarioToolStatusValues[number];
export const scenarioToolStatusSchema = z.enum(scenarioToolStatusValues);
export const terminalToolStatusValues = [
  "completed",
  "failed",
  "cancelled",
  "denied",
] as const satisfies readonly ScenarioToolStatus[];
export function isTerminalToolStatus(status: ScenarioToolStatus): boolean {
  return terminalToolStatusValues.includes(status as typeof terminalToolStatusValues[number]);
}

export const toolCallSnapshotSchema = z.object({
  id: idSchema,
  turnId: idSchema.nullable(),
  name: z.string().min(1),
  input: jsonValueSchema,
  inputDigest: sha256DigestSchema,
  feedbackDigest: sha256DigestSchema,
  status: scenarioToolStatusSchema,
  authorization: toolAuthorizationSchema,
  output: z.array(jsonValueSchema),
  error: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  recordSeq: z.number().int().positive(),
}).strict();
export type ToolCallSnapshot = z.infer<typeof toolCallSnapshotSchema>;

export const scenarioEffectStatusValues = ["requested", "started", "completed", "failed", "cancelled"] as const;
export type ScenarioEffectStatus = typeof scenarioEffectStatusValues[number];
export const scenarioEffectStatusSchema = z.enum(scenarioEffectStatusValues);
export const pendingEffectStatusValues = ["requested", "started"] as const satisfies readonly ScenarioEffectStatus[];
export function isPendingEffectStatus(status: ScenarioEffectStatus): boolean {
  return pendingEffectStatusValues.includes(status as typeof pendingEffectStatusValues[number]);
}

export const effectSnapshotSchema = z.object({
  effectId: idSchema,
  effectType: z.string().min(1),
  claimId: idSchema.nullable(),
  status: scenarioEffectStatusSchema,
  parameters: jsonValueSchema,
  result: jsonValueSchema.optional(),
  error: z.string().nullable(),
  requestedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  claimRenewedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  metadata: z.record(z.string(), jsonValueSchema),
}).strict();

export const scenarioRunStatusValues = ["created", "running", "waiting", "closed", "cancelled", "failed"] as const;
export type ScenarioRunStatus = typeof scenarioRunStatusValues[number];
export const scenarioRunStatusSchema = z.enum(scenarioRunStatusValues);
export const terminalRunStatusValues = ["closed", "cancelled", "failed"] as const satisfies readonly ScenarioRunStatus[];
export function isTerminalRunStatus(status: ScenarioRunStatus): boolean {
  return terminalRunStatusValues.includes(status as typeof terminalRunStatusValues[number]);
}

export const scenarioIdentitySchema = z.object({
    sourceKind: z.string().min(1),
    workingDir: z.string().nullable(),
    projectDir: z.string().nullable(),
    engineVersion: z.string().min(1),
    schemaDigest: z.string().min(1),
}).strict();
export const scenarioManifestSchema = z.object({
    source: runSourceSchema,
    adapter: z.string().nullable(),
    provider: z.string().nullable(),
    nativeSessionIds: z.array(z.string()),
    storagePolicy: scenarioStoragePolicySchema,
    runtimeHome: runtimeHomeDescriptorSchema,
    configuration: z.record(z.string(), jsonValueSchema),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
}).strict();
export const runtimeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean(),
  metadata: z.record(z.string(), jsonValueSchema),
}).strict();
export const scenarioErrorSchema = runtimeErrorSchema.extend({
  recordedAt: timestampSchema,
}).strict();

export const scenarioSnapshotSchema = z.object({
  runId: idSchema,
  identity: scenarioIdentitySchema,
  manifest: scenarioManifestSchema,
  status: scenarioRunStatusSchema,
  capabilities: runCapabilitiesSchema,
  revision: z.number().int().nonnegative(),
  lastRecordSeq: z.number().int().nonnegative(),
  conversation: z.array(messageSnapshotSchema),
  toolCalls: z.array(toolCallSnapshotSchema),
  stateSlices: z.record(z.string(), stateSliceSchema),
  effects: z.array(effectSnapshotSchema),
  providerState: z.record(z.string(), jsonValueSchema),
  plan: z.record(z.string(), jsonValueSchema),
  continuation: z.record(z.string(), jsonValueSchema),
  artifacts: z.array(artifactRefSchema),
  feedback: z.record(z.string(), feedbackEntrySchema),
  errors: z.array(scenarioErrorSchema),
  recoveryDiagnostics: z.array(z.string()),
  commandResults: z.record(z.string(), jsonValueSchema),
}).strict();
export type ScenarioSnapshot = z.infer<typeof scenarioSnapshotSchema>;
