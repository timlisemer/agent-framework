import { z } from "zod";
import { artifactRefSchema, redactedValueSchema } from "./artifacts.js";
import { runCapabilitiesSchema } from "./capabilities.js";
import { digestCanonicalJson } from "./digest.js";
import {
  runSourceKindValues,
  runSourceSchema,
  runtimeHomeDescriptorSchema,
  scenarioExtensionSchema,
  scenarioStoragePolicyValues,
  scenarioVisibilityValues,
} from "./common.js";
import {
  scenarioCommandSchema,
  scenarioCommandTypes,
  toolDecisionValues,
} from "./commands.js";
import {
  feedbackAuthorSchema,
  feedbackEntrySchema,
  feedbackTargetKindValues,
  feedbackTargetSchema,
  feedbackVoteValues,
} from "./feedback.js";
import {
  scenarioBackendFrameSchema,
  scenarioClientFrameSchema,
  scenarioGatewayEventSchema,
  scenarioGatewayRequestSchema,
  scenarioGatewayResponseSchema,
  scenarioGatewayOperationScopes,
  scenarioGatewayErrorCodeValues,
  scenarioGatewayScopes,
  scenarioHelloSchema,
  scenarioWelcomeSchema,
  gatewayRequestPayloadSchema,
  gatewayResponsePayloadSchema,
  providerRunConfigSchema,
  providerResumeTargetSchema,
  runDescriptorSchema,
} from "./gateway.js";
import {
  eventBatchSchema,
  scenarioEntityRefSchema,
  scenarioEventTypes,
  scenarioRecordSchema,
} from "./records.js";
import {
  MAXIMUM_ARTIFACT_BYTES,
  MAXIMUM_CLIENT_FRAME_BYTES,
} from "./limits.js";
import {
  scenarioSnapshotSchema,
  effectSnapshotSchema,
  messageSnapshotSchema,
  scenarioErrorSchema,
  scenarioEffectStatusValues,
  scenarioIdentitySchema,
  scenarioManifestSchema,
  scenarioMessageRoleValues,
  scenarioMessageStatusValues,
  scenarioRunStatusValues,
  scenarioToolStatusValues,
  stateSliceSchema,
  stateSliceStatusValues,
  toolAuthorizationSchema,
  toolCallSnapshotSchema,
  toolFinalStatusValues,
  toolPolicyStatusValues,
  toolUserDecisionStatusValues,
} from "./snapshot.js";
import { SCENARIO_PROTOCOL_SCHEMA_ID } from "./schema-id.js";

export type ScenarioProtocolSchemaBundle = ReturnType<typeof buildScenarioProtocolSchemaBundle>;

export function buildScenarioProtocolSchemaBundle() {
  return {
    $id: SCENARIO_PROTOCOL_SCHEMA_ID,
    schemas: {
      artifactRef: z.toJSONSchema(artifactRefSchema),
      backendFrame: z.toJSONSchema(scenarioBackendFrameSchema),
      capabilities: z.toJSONSchema(runCapabilitiesSchema),
      clientFrame: z.toJSONSchema(scenarioClientFrameSchema),
      command: z.toJSONSchema(scenarioCommandSchema),
      eventBatch: z.toJSONSchema(eventBatchSchema),
      feedback: z.toJSONSchema(feedbackEntrySchema),
      gatewayEvent: z.toJSONSchema(scenarioGatewayEventSchema),
      gatewayRequest: z.toJSONSchema(scenarioGatewayRequestSchema),
      gatewayResponse: z.toJSONSchema(scenarioGatewayResponseSchema),
      hello: z.toJSONSchema(scenarioHelloSchema),
      record: z.toJSONSchema(scenarioRecordSchema),
      redactedValue: z.toJSONSchema(redactedValueSchema),
      snapshot: z.toJSONSchema(scenarioSnapshotSchema),
      stateSlice: z.toJSONSchema(stateSliceSchema),
      welcome: z.toJSONSchema(scenarioWelcomeSchema),
    },
  };
}

export function buildScenarioProtocolManifest() {
  return {
    schemaId: SCENARIO_PROTOCOL_SCHEMA_ID,
    limits: {
      maximumClientFrameBytes: MAXIMUM_CLIENT_FRAME_BYTES,
      maximumArtifactBytes: MAXIMUM_ARTIFACT_BYTES,
    },
    enumValues: {
      commandType: scenarioCommandTypes,
      recordType: scenarioEventTypes,
      stateSliceStatus: stateSliceStatusValues,
      effectStatus: scenarioEffectStatusValues,
      visibility: scenarioVisibilityValues,
      runSourceKind: runSourceKindValues,
      storagePolicy: scenarioStoragePolicyValues,
      toolDecision: toolDecisionValues,
      scenarioGatewayErrorCode: scenarioGatewayErrorCodeValues,
      scenarioRunStatus: scenarioRunStatusValues,
      scenarioMessageRole: scenarioMessageRoleValues,
      scenarioMessageStatus: scenarioMessageStatusValues,
      toolPolicyStatus: toolPolicyStatusValues,
      toolUserDecisionStatus: toolUserDecisionStatusValues,
      toolFinalStatus: toolFinalStatusValues,
      scenarioToolStatus: scenarioToolStatusValues,
      feedbackTargetKind: feedbackTargetKindValues,
      feedbackVote: feedbackVoteValues,
    },
    structFields: {
      artifactRef: Object.keys(artifactRefSchema.shape),
      redactedValue: Object.keys(redactedValueSchema.shape),
      scenarioExtension: Object.keys(scenarioExtensionSchema.shape),
      runSource: Object.keys(runSourceSchema.shape),
      runtimeHomeDescriptor: Object.keys(runtimeHomeDescriptorSchema.shape),
      providerResumeTarget: Object.keys(providerResumeTargetSchema.shape),
      providerRunConfig: Object.keys(providerRunConfigSchema.shape),
      clientIdentity: Object.keys(scenarioHelloSchema.shape.client.shape),
      extensionSchemaDescriptor: Object.keys(scenarioWelcomeSchema.shape.extensionSchemas.element.shape),
      scenarioHello: Object.keys(scenarioHelloSchema.shape),
      scenarioWelcome: Object.keys(scenarioWelcomeSchema.shape),
      scenarioGatewayRequest: Object.keys(scenarioGatewayRequestSchema.shape),
      scenarioRunDescriptor: Object.keys(runDescriptorSchema.shape),
      scenarioGatewayResponse: Object.keys(scenarioGatewayResponseSchema.shape),
      stateSlice: Object.keys(stateSliceSchema.shape),
      scenarioIdentity: Object.keys(scenarioIdentitySchema.shape),
      scenarioManifest: Object.keys(scenarioManifestSchema.shape),
      scenarioMessage: Object.keys(messageSnapshotSchema.shape),
      toolAuthorization: Object.keys(toolAuthorizationSchema.shape),
      scenarioToolCall: Object.keys(toolCallSnapshotSchema.shape),
      feedbackTarget: Object.keys(feedbackTargetSchema.shape),
      feedbackAuthor: Object.keys(feedbackAuthorSchema.shape),
      feedbackEntry: Object.keys(feedbackEntrySchema.shape),
      scenarioError: Object.keys(scenarioErrorSchema.shape),
      scenarioEntityRef: Object.keys(scenarioEntityRefSchema.shape),
      scenarioRecord: Object.keys(scenarioRecordSchema.shape),
      eventBatch: Object.keys(eventBatchSchema.shape),
      runCapabilities: Object.keys(runCapabilitiesSchema.shape),
      scenarioEffect: Object.keys(effectSnapshotSchema.shape),
      scenarioSnapshot: Object.keys(scenarioSnapshotSchema.shape),
    },
    gatewayScopes: scenarioGatewayScopes,
    gatewayOperationScopes: scenarioGatewayOperationScopes,
    gatewayContract: {
      strict: true,
      requestVariants: Object.fromEntries(gatewayRequestPayloadSchema.options.map((option) => [
        option.shape.operation.value,
        Object.keys(option.shape),
      ])),
      responseVariants: Object.fromEntries(gatewayResponsePayloadSchema.options.map((option) => [
        option.shape.kind.value,
        Object.keys(option.shape),
      ])),
      eventVariants: Object.fromEntries(scenarioGatewayEventSchema.options.map((option) => [
        option.shape.type.value,
        Object.keys(option.shape),
      ])),
      clientFrameVariants: {
        hello: Object.keys(scenarioHelloSchema.shape),
        request: Object.keys(scenarioGatewayRequestSchema.shape),
      },
      backendFrameVariants: {
        welcome: Object.keys(scenarioWelcomeSchema.shape),
        response: Object.keys(scenarioGatewayResponseSchema.shape),
        ...Object.fromEntries(scenarioGatewayEventSchema.options.map((option) => [
          option.shape.type.value,
          Object.keys(option.shape),
        ])),
      },
    },
  };
}

export function scenarioProtocolSchemaDigest(bundle = buildScenarioProtocolSchemaBundle()): string {
  return digestCanonicalJson(bundle);
}
