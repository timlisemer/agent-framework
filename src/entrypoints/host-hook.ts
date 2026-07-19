import * as fs from "fs";
import * as path from "path";
import type {
  AdapterEncoder,
  EncodedOutput,
  PlanModeDetection,
} from "../adapter/types.js";
import { activeSpec } from "../adapter/spec.js";
import { resolveHostContext } from "../utils/host-context.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import {
  mergeSessionWorkflowChanges,
  dispatchAgentFrameworkWorkflow,
  sessionWorkflowDefaults as sessionStateDefaults,
  sessionWorkflowStateFromJson,
  type SessionWorkflowState,
} from "../effects/session-workflow.js";
import {
  AGENT_FRAMEWORK_HOST_EXTENSION_ID,
  agentFrameworkHostCommand,
  agentFrameworkHostCommandData,
  agentFrameworkHostCommandImmutableDigest,
  type AgentFrameworkHostCommand,
} from "../effects/host-command.js";
import { resolveObservedPlanModeForHook } from "../utils/plan-mode-detector.js";
import { stripQuotedAndPastedContent } from "../utils/quote-detection.js";
import {
  FILE_TOOLS,
  extractFilePaths,
  isPathInDirectory,
  isPlanFile,
} from "../rules/utils.js";
import { isTextEditToolName } from "../utils/edit-tools.js";
import { extractPlanName } from "../utils/planfile.js";
import { readPlanFileContent } from "../utils/plan-source.js";
import {
  requireToolSequenceNext,
  toolContinuationRequirement,
} from "../utils/prediction-types.js";
import { scenarioProtocolSchemaDigest } from "../scenario/protocol/schema.js";
import {
  toJsonValue as jsonValue,
  type JsonValue,
} from "../scenario/protocol/common.js";
import {
  nativeTranscriptDataSchema,
  scenarioCommandSchema,
  type ScenarioCommand,
  type ScenarioCommandPayload,
} from "../scenario/protocol/commands.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import {
  isTerminalToolStatus,
  scenarioToolStatusSchema,
  type ScenarioSnapshot,
} from "../scenario/protocol/snapshot.js";
import type { ScenarioRecord } from "../scenario/protocol/records.js";
import { ScenarioRuntime } from "../scenario/runtime/runtime.js";
import { SnapshotRevisionConflictError } from "../scenario/runtime/errors.js";
import { createAgentFrameworkScenarioRuntime } from "../effects/scenario-runtime-factory.js";
import type { HostRuntimeContext } from "../effects/host-context.js";
import type {
  BaseHookInput,
  FrameworkPreToolUseHookInput,
  FrameworkPostToolUseFailureHookInput,
  FrameworkPostToolUseHookInput,
  FrameworkSessionStartHookInput,
  FrameworkStopHookInput,
  FrameworkUserPromptSubmitHookInput,
} from "../hooks/types.js";
import { VERSION } from "../version.js";
import { parsePlanModeStoredState } from "../utils/plan-mode-entry-state.js";
import {
  canonicalNativeTranscriptObservation,
  type CanonicalNativeTranscriptMetadata,
} from "./native-transcript.js";
import { canonicalHookRunId } from "./host-run-id.js";
import { isRecord } from "../utils/output.js";
import { createScenarioCommandEnvelope } from "../scenario/protocol/command-envelope.js";

export { canonicalHookRunId } from "./host-run-id.js";

export const HOST_HOOK_CAPABILITIES = {
  conversationInput: false,
  toolExecution: false,
  interactiveToolDecisions: false,
  planControl: true,
  feedbackSubmission: true,
  artifactRead: true,
  fullStateInspection: true,
  runCancellation: false,
} as const;

const NATIVE_TRANSCRIPT_ATOMIC_ATTEMPT = 1;
const NATIVE_TRANSCRIPT_IMPORT_MAX_ATTEMPTS =
  NATIVE_TRANSCRIPT_ATOMIC_ATTEMPT + 1;

async function waitForNativeTranscriptRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1 + Math.floor(attempt / 8), 8);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function nativeProjectionIsActive(value: JsonValue | undefined): boolean {
  return (
    isRecord(value) &&
    ((Array.isArray(value.messageIds) && value.messageIds.length > 0) ||
      (Array.isArray(value.toolCallIds) && value.toolCallIds.length > 0))
  );
}

function cachedWorkflowUserMessage(snapshot: ScenarioSnapshot): string {
  const workflow = sessionWorkflowStateFromJson(
    snapshot.stateSlices["session.workflow"]?.value,
  );
  return (
    workflow.currentPrediction?.userMessageFull ??
    workflow.currentPrediction?.userMessageSnippet ??
    ""
  );
}

function nativeProjectionMessageIds(value: JsonValue | undefined): Set<string> {
  if (!isRecord(value) || !Array.isArray(value.messageIds))
    return new Set<string>();
  return new Set(
    value.messageIds.filter((id): id is string => typeof id === "string"),
  );
}

function nativePromptOccurrenceCount(
  snapshot: ScenarioSnapshot,
  promptDigest: string | null,
): number {
  if (promptDigest === null) return 0;
  const activeMessageIds = nativeProjectionMessageIds(
    snapshot.stateSlices["transcript.native"]?.value,
  );
  return snapshot.conversation.filter(
    (message) =>
      activeMessageIds.has(message.id) &&
      message.role === "user" &&
      message.contentDigest === promptDigest,
  ).length;
}

function metadataForLockedWorkflow(
  metadata: CanonicalNativeTranscriptMetadata,
  preparedCachedUserMessage: string,
  lockedCachedUserMessage: string,
): CanonicalNativeTranscriptMetadata {
  return preparedCachedUserMessage === lockedCachedUserMessage
    ? metadata
    : { ...metadata, cachedSnippetSideTaskDischarged: false };
}

function resolveObservedPromptMessageId(input: {
  view: { snapshot: ScenarioSnapshot; records: readonly ScenarioRecord[] };
  candidateId: JsonValue | undefined;
  promptDigest: string | null;
  nativeOccurrenceCount: number;
  priorOccurrenceCount: number;
}): string | undefined {
  if (typeof input.candidateId !== "string") return undefined;
  const candidateIsActive = input.view.snapshot.conversation.some(
    (message) =>
      message.id === input.candidateId &&
      message.role === "user" &&
      message.contentDigest === input.promptDigest,
  );
  if (!candidateIsActive) return undefined;
  const candidateWasSubmitted = input.view.records.some(
    (record) =>
      record.eventType === "extension.observed" &&
      record.payload.extensionId === AGENT_FRAMEWORK_HOST_EXTENSION_ID &&
      record.payload.event === "UserPromptSubmit" &&
      record.payload.messageId === input.candidateId,
  );
  return input.nativeOccurrenceCount !== input.priorOccurrenceCount ||
    !candidateWasSubmitted
    ? input.candidateId
    : undefined;
}

export type HostHookCommandContext = {
  runId: string;
  adapter: string;
  nativeSessionId: string;
};

export function createHostHookScenarioCommand(
  context: HostHookCommandContext,
  payload: ScenarioCommandPayload,
  options: {
    commandId?: string;
    recordedAt?: string;
    expectedSnapshotRevision?: number;
  } = {},
): ScenarioCommand {
  return createScenarioCommandEnvelope({
    runId: context.runId,
    source: {
      kind: "hostHook",
      adapter: context.adapter,
      nativeSessionId: context.nativeSessionId,
    },
    ...options,
    payload,
  });
}

export function createHostHookStartCommand(
  context: HostHookCommandContext & {
    workingDir: string | null;
    projectDir: string | null;
  },
  options: { commandId?: string; recordedAt?: string } = {},
): ScenarioCommand {
  return createHostHookScenarioCommand(
    context,
    {
    type: "startRun",
    workingDir: context.workingDir,
    projectDir: context.projectDir,
    capabilities: HOST_HOOK_CAPABILITIES,
    storagePolicy: "durable",
    runtimeHome: { kind: "native", configuration: {} },
    engineVersion: VERSION,
    schemaDigest: scenarioProtocolSchemaDigest(),
    configuration: {
      adapter: context.adapter,
      nonInteractiveToolFallback: "deny",
      rulePipeline: "shared",
    },
    },
    options,
  );
}

export type HostHookDispatchOptions = {
  runtime?: ScenarioRuntime;
  /** Test/composition override equivalent to AGENT_FRAMEWORK_SCENARIO_RUN_ID. */
  scenarioRunId?: string;
};

export async function dispatchPreToolUse(
  input: FrameworkPreToolUseHookInput,
  encoder: AdapterEncoder,
  options: HostHookDispatchOptions = {},
): Promise<EncodedOutput> {
  const result = await dispatchPreToolUseResult(input, options);
  if (result.status === "allowed") return encoder.encodePreToolUseAllow();
  return encoder.encodePreToolUseDeny(
    result.reason ?? "Scenario runtime denied the tool call",
  );
}

/** Canonical PreToolUse entry point for non-hook boundaries such as MCP. */
export async function dispatchPreToolUseResult(
  input: FrameworkPreToolUseHookInput,
  options: HostHookDispatchOptions = {},
) {
  const boundary = await openHookBoundary(input, options);
  const canonical = boundary.spec.canonicalizeToolCall(
    input.tool_name,
    input.tool_input,
  );
  const state = await workflowState(boundary);
  const context = await preToolContext(
    input,
    boundary,
    canonical.toolName,
    canonical.toolInput,
  );
  return boundary.dispatch({
    type: "hostPreToolUse",
    workflow: jsonValue(state),
    context: jsonValue(context),
    toolCallId: input.tool_use_id,
    turnId: null,
    name: canonical.toolName,
    input: jsonValue(canonical.toolInput),
    inputDigest: digestScenarioValue(jsonValue(canonical.toolInput)),
    requiresUserDecision: false,
  });
}

export async function dispatchUserPromptSubmit(
  input: FrameworkUserPromptSubmitHookInput,
  encoder: AdapterEncoder,
  options: HostHookDispatchOptions = {},
): Promise<EncodedOutput> {
  const boundary = await openHookBoundary(input, options);
  const contentDigest = digestScenarioValue(input.prompt);
  const state = await workflowState(boundary);
  const workflowInvocation = boundary.spec.recognizeWorkflowInvocation(
    input.prompt,
  );
  const context: HostRuntimeContext = {
    ...baseHostContext(input, boundary),
    userPrompt: {
      prompt: input.prompt,
      workflowInvocation: workflowInvocation ?? null,
      workflowInstructionText: workflowInvocation
        ? boundary.spec.workflowInstructionText(
            workflowInvocation,
            boundary.host,
          )
        : null,
      workflowOnly: Boolean(
        workflowInvocation &&
        boundary.spec.isWorkflowInvocationOnly(input.prompt),
      ),
      planExit: boundary.spec.isPlanExit({
        event: "UserPromptSubmit",
        prompt: input.prompt,
      }),
    },
  };
  const result = await boundary.dispatch({
    type: "hostUserPromptSubmitted",
    workflow: jsonValue(state),
    context: jsonValue(context),
    messageId: boundary.userPromptMessageId(),
    prompt: input.prompt,
    contentDigest,
  });
  if (result.status === "failed") {
    throw new Error(result.reason ?? "UserPromptSubmit runtime effect failed");
  }
  if (result.status === "denied") {
    const reason =
      result.reason ?? "User prompt was blocked by the scenario runtime";
    return encoder.encodeUserPromptSubmitBlock
      ? encoder.encodeUserPromptSubmitBlock(reason)
      : encoder.encodeContext("UserPromptSubmit", reason);
  }
  const contextMessage = result.data?.contextMessage;
  return typeof contextMessage === "string"
    ? encoder.encodeContext("UserPromptSubmit", contextMessage)
    : encoder.encodeOk("UserPromptSubmit");
}

export async function dispatchStop(
  input: FrameworkStopHookInput,
  encoder: AdapterEncoder,
  options: HostHookDispatchOptions = {},
): Promise<EncodedOutput> {
  const boundary = await openHookBoundary(input, options);
  const state = await workflowState(boundary);
  const transcript = boundary.transcriptMetadata.stop;
  const assistantTextCandidates = transcript.assistantTextCandidates;
  const planExitText =
    [input.last_assistant_message ?? null, ...assistantTextCandidates].find(
      (candidate) =>
        boundary.spec.isPlanExit({ event: "Stop", assistantText: candidate }),
    ) ?? null;
  const context: HostRuntimeContext = {
    ...baseHostContext(input, boundary),
    stop: {
      lastAssistantMessage: input.last_assistant_message ?? null,
      assistantTextCandidates,
      latestAssistantText: transcript.latestAssistantText,
      latestUserText: transcript.latestUserText,
      priorErrorContext: transcript.priorErrorContext.map((entry) => ({
        ...entry,
        provenance: [...entry.provenance],
      })),
      planExitText,
      stopBlockDisabled:
        process.env.AGENT_FRAMEWORK_DISABLE_STOP_BLOCK === "1" &&
        process.env.AGENT_FRAMEWORK_RUNTIME_PROFILE === "internalWrite",
    },
  };
  const result = await boundary.dispatch({
    type: "hostStopped",
    workflow: jsonValue(state),
    context: jsonValue(context),
    lastAssistantMessage: input.last_assistant_message ?? null,
  });
  if (result.status === "failed")
    throw new Error(result.reason ?? "Stop runtime effect failed");
  return result.status === "stopBlocked"
    ? encoder.encodeStopBlock(
        result.reason ?? "Stop was blocked by the scenario runtime",
      )
    : encoder.encodeStopPass();
}

export async function dispatchPostToolUse(
  input: FrameworkPostToolUseHookInput,
  encoder: AdapterEncoder,
  options: HostHookDispatchOptions = {},
): Promise<EncodedOutput> {
  return dispatchPostToolOutcome(input, encoder, "completed", null, options);
}

export async function dispatchPostToolUseFailure(
  input: FrameworkPostToolUseFailureHookInput,
  encoder: AdapterEncoder,
  options: HostHookDispatchOptions = {},
): Promise<EncodedOutput> {
  return dispatchPostToolOutcome(
    input,
    encoder,
    input.is_interrupt ? "cancelled" : "failed",
    input.error,
    options,
  );
}

export async function dispatchSessionStart(
  input: FrameworkSessionStartHookInput,
  encoder: AdapterEncoder,
  options: HostHookDispatchOptions = {},
): Promise<EncodedOutput> {
  const boundary = await openHookBoundary(input, options);
  const workflow =
    input.source === "compact" || input.source === "clear"
    ? sessionStateDefaults()
    : await workflowState(boundary);
  const result = await boundary.dispatch({
    type: "hostSessionStarted",
    source: input.source,
    workflow: jsonValue(workflow),
    context: jsonValue(baseHostContext(input, boundary)),
  });
  if (result.status === "failed")
    throw new Error(result.reason ?? "SessionStart runtime command failed");
  return encoder.encodeOk("SessionStart");
}

async function dispatchPostToolOutcome(
  input: FrameworkPostToolUseHookInput | FrameworkPostToolUseFailureHookInput,
  encoder: AdapterEncoder,
  outcome: "completed" | "failed" | "cancelled",
  error: string | null,
  options: HostHookDispatchOptions = {},
): Promise<EncodedOutput> {
  const boundary = await openHookBoundary(input, options);
  const canonical = boundary.spec.canonicalizeToolCall(
    input.tool_name,
    input.tool_input,
  );
  const initialState = await workflowState(boundary);
  const continuation =
    outcome === "completed"
    ? boundary.spec.continuationAfterToolResult(
        canonical,
        "tool_response" in input ? input.tool_response : undefined,
      )
      : boundary.spec.continuationAfterToolFailure(
          canonical,
          error ?? "",
          outcome === "cancelled",
        );
  const requirement = toolContinuationRequirement(continuation);
  const workflow = requirement
    ? {
        ...initialState,
        currentPrediction: requireToolSequenceNext(
          initialState.currentPrediction,
          [requirement],
          outcome === "completed"
            ? {
                intent: `Wait for the yielded ${canonical.toolName} call to finish.`,
                userMessage: `The ${canonical.toolName} call yielded and must finish before workflow progress continues.`,
              }
            : {
                intent:
                  "Retry the failed adapter continuation before workflow progress.",
                userMessage:
                  "The adapter continuation failed and must be retried.",
              },
        ),
      }
    : initialState;
  const currentPlan =
    outcome === "completed"
      ? await currentPlanAfterTool(
          boundary.sessionDir,
          canonical.toolName,
          canonical.toolInput,
        )
    : undefined;
  const canonicalInput = jsonValue(canonical.toolInput);
  const inputDigest = digestScenarioValue(canonicalInput);
  const toolCallId =
    input.tool_use_id ??
    boundary.postToolCallId(canonical.toolName, inputDigest);
  const context: HostRuntimeContext = {
    ...baseHostContext(input, boundary),
    postTool: {
      rawToolName: input.tool_name,
      rawToolInput: jsonValue(input.tool_input),
    },
  };
  const result = await boundary.dispatch({
    type: "hostPostToolUse",
    workflow: jsonValue(workflow),
    context: jsonValue(context),
    toolCallId,
    name: canonical.toolName,
    input: canonicalInput,
    inputDigest,
    outcome,
    ...(outcome === "completed" && "tool_response" in input
      ? { output: jsonValue(input.tool_response) }
      : {}),
    error,
    ...(currentPlan === undefined
      ? {}
      : { currentPlan: jsonValue(currentPlan) }),
  });
  if (result.status === "failed")
    throw new Error(result.reason ?? "PostToolUse runtime command failed");
  return encoder.encodeOk(
    outcome === "completed" ? "PostToolUse" : "PostToolUseFailure",
  );
}

async function currentPlanAfterTool(
  sessionDir: string,
  toolName: string,
  toolInput: unknown,
): Promise<{ kind: "file"; path: string; planName: string } | undefined> {
  if (!isTextEditToolName(toolName)) return undefined;
  for (const filePath of extractFilePaths(toolName, toolInput)) {
    if (!isPlanFile(filePath, sessionDir)) continue;
    const content = await readPlanFileContent(filePath);
    if (!content?.trim()) continue;
    return {
      kind: "file",
      path: filePath,
      planName: extractPlanName(content) ?? path.basename(filePath, ".md"),
    };
  }
  return undefined;
}

type HookBoundary = Awaited<ReturnType<typeof openHookBoundary>>;

async function openHookBoundary(
  input: BaseHookInput,
  options: HostHookDispatchOptions = {},
): Promise<{
  spec: ReturnType<typeof activeSpec>;
  runtime: ScenarioRuntime;
  runId: string;
  sessionDir: string;
  host: ReturnType<typeof resolveHostContext>;
  planMode: boolean;
  planModeDetection: PlanModeDetection;
  transcriptMetadata: CanonicalNativeTranscriptMetadata;
  userPromptMessageId(): string;
  postToolCallId(name: string, inputDigest: string): string;
  readWorkflow(): Promise<SessionWorkflowState>;
  dispatch(
    payload: AgentFrameworkHostCommand,
  ): Promise<Awaited<ReturnType<ScenarioRuntime["dispatch"]>>>;
}> {
  const spec = activeSpec();
  const host = resolveHostContext(input);
  const sessionDir = getAgentFrameworkSessionDir({
    transcriptPath: input.transcript_path,
  });
  await fs.promises.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const scenarioRunId =
    options.scenarioRunId ?? process.env.AGENT_FRAMEWORK_SCENARIO_RUN_ID;
  const runId =
    scenarioRunId || canonicalHookRunId(spec.name, input.transcript_path);
  const runtime = options.runtime ?? createAgentFrameworkScenarioRuntime();
  let workflowBaseline: {
    state: SessionWorkflowState;
    revision: number;
  } | null = null;
  const commandContext = {
    runId,
    adapter: spec.name,
    nativeSessionId: input.session_id,
  };
  const command = <Payload extends ScenarioCommandPayload>(
    payload: Payload,
    expectedSnapshotRevision?: number,
    commandId?: string,
  ): ScenarioCommand & { payload: Payload } =>
    createHostHookScenarioCommand(commandContext, payload, {
      expectedSnapshotRevision,
      commandId,
    }) as ScenarioCommand & { payload: Payload };
  if (scenarioRunId) {
    const providerSnapshot = await runtime.snapshot(runId);
    if (
      providerSnapshot.status !== "running" ||
      providerSnapshot.manifest.source.kind !== "providerSdk" ||
      providerSnapshot.manifest.adapter !== spec.name
    ) {
      throw new Error(
        `Managed hook run binding does not identify an active ${spec.name} provider run: ${runId}`,
      );
    }
  } else {
    await runtime.ensureRunStarted(
      createHostHookStartCommand({
      ...commandContext,
      workingDir: input.cwd ?? null,
      projectDir: host.projectDir,
      }),
    );
  }
  const inputPrompt =
    "prompt" in input && typeof input.prompt === "string" ? input.prompt : null;
  const promptDigest =
    inputPrompt === null ? null : digestScenarioValue(inputPrompt);
  const providedPromptDeliveryId =
    inputPrompt === null ? null : (input.delivery_id ?? null);
  if (
    providedPromptDeliveryId !== null &&
    providedPromptDeliveryId.length === 0
  ) {
    throw new Error("UserPromptSubmit delivery_id must not be empty");
  }
  let importedView: Awaited<
    ReturnType<ScenarioRuntime["canonicalView"]>
  > | null = null;
  let importedMetadata: CanonicalNativeTranscriptMetadata | null = null;
  let observedPromptMessageId: string | undefined;
  const atomicHistoryFilter = (record: ScenarioRecord): boolean => {
    if (inputPrompt === null) return false;
    if (
      providedPromptDeliveryId !== null &&
      record.eventType === "command.accepted" &&
      record.commandId ===
        hostBoundaryCommandId("hostUserPromptSubmitted", {
          source: "hostDelivery",
          id: providedPromptDeliveryId,
        })
    ) {
      return true;
    }
    return (
      record.eventType === "extension.observed" &&
      record.payload.extensionId === AGENT_FRAMEWORK_HOST_EXTENSION_ID &&
      record.payload.event === "UserPromptSubmit"
    );
  };
  const readNativeTranscript = async (snapshot: ScenarioSnapshot) => {
    const cachedUserMessage = cachedWorkflowUserMessage(snapshot);
    const toolUseId =
      "tool_use_id" in input && typeof input.tool_use_id === "string"
      ? input.tool_use_id
      : undefined;
    const observation = await canonicalNativeTranscriptObservation({
      adapterName: spec.name,
      transcriptPath: input.transcript_path,
      permissionMode: input.permission_mode,
      collaborationMode: input.collaboration_mode,
      ...(cachedUserMessage ? { cachedUserMessage } : {}),
      ...(toolUseId === undefined ? {} : { toolUseId }),
    });
    const data = observation.data as Record<string, JsonValue>;
    if (Array.isArray(data.tools)) {
      data.tools = data.tools.filter((tool) => {
        if (!isRecord(tool)) return false;
        if ("tool_use_id" in input && tool.id === input.tool_use_id)
          return false;
        const status = scenarioToolStatusSchema.safeParse(tool.status);
        return status.success && isTerminalToolStatus(status.data);
      });
    }
    return { cachedUserMessage, observation, data };
  };
  for (
    let attempt = 0;
    attempt < NATIVE_TRANSCRIPT_IMPORT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const existingSnapshot = await runtime.snapshot(runId);
    const {
      cachedUserMessage,
      observation: nativeTranscript,
      data: nativeData,
    } = await readNativeTranscript(existingSnapshot);
    const priorNativeState =
      existingSnapshot.stateSlices["transcript.native"]?.value;
    const activeNativeProjection = nativeProjectionIsActive(priorNativeState);
    if (nativeTranscript.availability === "missing") {
      if (attempt >= NATIVE_TRANSCRIPT_ATOMIC_ATTEMPT) {
        let lockedCachedUserMessage = "";
        const locked = await runtime.dispatchNativeTranscriptFromLatestSnapshot(
          runId,
          (lockedSnapshot) => {
            const lockedNativeState =
              lockedSnapshot.stateSlices["transcript.native"]?.value;
            if (nativeProjectionIsActive(lockedNativeState)) {
              throw new Error(
                "Native transcript is unavailable while canonical native history is active",
              );
            }
            lockedCachedUserMessage = cachedWorkflowUserMessage(lockedSnapshot);
            return null;
          },
          atomicHistoryFilter,
        );
        importedView = { snapshot: locked.snapshot, records: locked.records };
        importedMetadata = metadataForLockedWorkflow(
          nativeTranscript.metadata,
          cachedUserMessage,
          lockedCachedUserMessage,
        );
        observedPromptMessageId = undefined;
        break;
      }
      if (activeNativeProjection) {
        throw new Error(
          "Native transcript is unavailable while canonical native history is active",
        );
      }
      const currentView = await runtime.canonicalView(runId);
      if (currentView.snapshot.revision !== existingSnapshot.revision) {
        await waitForNativeTranscriptRetry(attempt);
        continue;
      }
      const committedCachedUserMessage = cachedWorkflowUserMessage(
        currentView.snapshot,
      );
      if (committedCachedUserMessage !== cachedUserMessage) {
        await waitForNativeTranscriptRetry(attempt);
        continue;
      }
      importedView = currentView;
      importedMetadata = nativeTranscript.metadata;
      observedPromptMessageId = undefined;
      break;
    }
    let priorNativePromptOccurrences = nativePromptOccurrenceCount(
      existingSnapshot,
      promptDigest,
    );
    const nativePromptOccurrences =
      promptDigest === null || !Array.isArray(nativeData.messages)
      ? []
        : nativeData.messages.filter(
            (message): message is Record<string, JsonValue> =>
          isRecord(message) &&
              message.role === "user" &&
              message.contentDigest === promptDigest &&
              message.content === inputPrompt,
        );
    const observedPromptMessageIdCandidate = nativePromptOccurrences.at(-1)?.id;
    const nativeDigest = digestScenarioValue(nativeData);
    const preparedNativeData = nativeTranscriptDataSchema.parse(
      jsonValue({
            ...nativeData,
            digest: nativeDigest,
      }),
    );
    const priorImport =
      existingSnapshot.stateSlices["transcript.native"]?.value;
    if (attempt >= NATIVE_TRANSCRIPT_ATOMIC_ATTEMPT) {
      let lockedCachedUserMessage = "";
      const committedImport =
        await runtime.dispatchNativeTranscriptFromLatestSnapshot(
        runId,
        (lockedSnapshot) => {
          lockedCachedUserMessage = cachedWorkflowUserMessage(lockedSnapshot);

          const lockedPrior =
            lockedSnapshot.stateSlices["transcript.native"]?.value;
          priorNativePromptOccurrences = nativePromptOccurrenceCount(
            lockedSnapshot,
            promptDigest,
          );
          if (isRecord(lockedPrior) && lockedPrior.digest === nativeDigest)
            return null;
          return command(
            {
              type: "nativeTranscriptObserved",
              data: preparedNativeData,
            },
            lockedSnapshot.revision,
          );
        },
        atomicHistoryFilter,
      );
      const committedState =
        committedImport.snapshot.stateSlices["transcript.native"]?.value;
      if (!isRecord(committedState) || committedState.digest !== nativeDigest) {
        throw new Error(
          "Atomic native transcript import committed an unexpected digest",
        );
      }
      importedView = {
        snapshot: committedImport.snapshot,
        records: committedImport.records,
      };
      importedMetadata = metadataForLockedWorkflow(
        nativeTranscript.metadata,
        cachedUserMessage,
        lockedCachedUserMessage,
      );
      observedPromptMessageId = resolveObservedPromptMessageId({
        view: importedView,
        candidateId: observedPromptMessageIdCandidate,
        promptDigest,
        nativeOccurrenceCount: nativePromptOccurrences.length,
        priorOccurrenceCount: priorNativePromptOccurrences,
      });
      break;
    } else if (!isRecord(priorImport) || priorImport.digest !== nativeDigest) {
      try {
        await runtime.dispatch(
          command(
            {
              type: "nativeTranscriptObserved",
              data: preparedNativeData,
            },
            existingSnapshot.revision,
          ),
        );
      } catch (error) {
        if (error instanceof SnapshotRevisionConflictError) {
          const conflictView = await runtime.canonicalView(runId);
          const conflictNativeState =
            conflictView.snapshot.stateSlices["transcript.native"]?.value;
          if (
            isRecord(conflictNativeState) &&
            conflictNativeState.digest === nativeDigest
          ) {
            importedView = conflictView;
          } else {
            await waitForNativeTranscriptRetry(attempt);
            continue;
          }
        } else {
          throw error;
        }
      }
    }
    importedView ??= await runtime.canonicalView(runId);
    const committedNativeState =
      importedView.snapshot.stateSlices["transcript.native"]?.value;
    if (
      !isRecord(committedNativeState) ||
      committedNativeState.digest !== nativeDigest
    ) {
      importedView = null;
      await waitForNativeTranscriptRetry(attempt);
      continue;
    }
    const committedCachedUserMessage = cachedWorkflowUserMessage(
      importedView.snapshot,
    );
    if (committedCachedUserMessage !== cachedUserMessage) {
      importedView = null;
      await waitForNativeTranscriptRetry(attempt);
      continue;
    }
    importedMetadata = nativeTranscript.metadata;
    observedPromptMessageId = resolveObservedPromptMessageId({
      view: importedView,
      candidateId: observedPromptMessageIdCandidate,
      promptDigest,
      nativeOccurrenceCount: nativePromptOccurrences.length,
      priorOccurrenceCount: priorNativePromptOccurrences,
    });
    break;
  }
  if (!importedView || !importedMetadata) {
    throw new Error(
      "Native transcript import did not converge after repeated revision conflicts",
    );
  }
  const importedSnapshot = importedView.snapshot;
  const committedNativeState =
    importedSnapshot.stateSlices["transcript.native"]?.value;
  const nativeTranscriptIdentity =
    isRecord(committedNativeState) &&
      typeof committedNativeState.digest === "string"
    ? committedNativeState.digest
    : digestScenarioValue({ availability: "missing", runId });
  const promptOccurrence =
    inputPrompt === null
    ? null
    : providedPromptDeliveryId !== null
      ? { source: "hostDelivery", id: providedPromptDeliveryId }
      : typeof observedPromptMessageId === "string"
        ? { source: "nativeMessage", id: observedPromptMessageId }
        : null;
  if (inputPrompt !== null && promptOccurrence === null) {
    throw new Error(
      "UserPromptSubmit lacks a stable delivery_id or newly observed native message occurrence",
    );
  }
  const promptCommandId =
    promptOccurrence === null
    ? null
    : hostBoundaryCommandId("hostUserPromptSubmitted", promptOccurrence);
  if (providedPromptDeliveryId !== null && promptCommandId !== null) {
    const accepted = importedView.records.find(
      (record) =>
        record.commandId === promptCommandId &&
        record.eventType === "command.accepted",
    );
    if (accepted) {
      const storedCommand = scenarioCommandSchema.parse(
        accepted.payload.command,
      );
      const storedHostCommand = agentFrameworkHostCommandData(
        storedCommand.payload,
      );
      if (storedHostCommand?.type === "hostUserPromptSubmitted") {
        observedPromptMessageId = storedHostCommand.observedMessageId;
      }
    }
  }
  const planModeDetection = resolveObservedPlanModeForHook(
    importedMetadata.planModeDetection,
    parsePlanModeStoredState(importedSnapshot.stateSlices["plan.mode"]?.value),
  );
  const planMode = planModeDetection.active;
  workflowBaseline = {
    state: sessionWorkflowStateFromJson(
      importedSnapshot.stateSlices["session.workflow"]?.value,
    ),
    revision: importedSnapshot.revision,
  };
  const readWorkflow = async (): Promise<SessionWorkflowState> => {
    return workflowBaseline!.state;
  };
  const boundaryCommandId = (payload: AgentFrameworkHostCommand): string => {
    const occurrence =
      payload.type === "hostPreToolUse" || payload.type === "hostPostToolUse"
      ? { type: payload.type, toolCallId: payload.toolCallId }
      : payload.type === "hostUserPromptSubmitted"
        ? null
        : payload.type === "hostSessionStarted"
            ? {
                type: payload.type,
                nativeTranscriptIdentity,
                source: payload.source,
              }
          : { type: payload.type, nativeTranscriptIdentity };
    if (payload.type === "hostUserPromptSubmitted") {
      if (promptCommandId === null)
        throw new Error("UserPromptSubmit occurrence identity is unavailable");
      return promptCommandId;
    }
    return hostBoundaryCommandId(payload.type, occurrence!);
  };
  const dispatchCanonical = async (
    payload: AgentFrameworkHostCommand,
    expectedSnapshotRevision?: number,
  ) => {
    const commandId = boundaryCommandId(payload);
    const currentView = await runtime.canonicalView(runId);
    const accepted = currentView.records.find(
      (record) =>
        record.commandId === commandId &&
        record.eventType === "command.accepted",
    );
    if (accepted) {
      const storedCommand = scenarioCommandSchema.parse(
        accepted.payload.command,
      );
      const storedHostCommand = agentFrameworkHostCommandData(
        storedCommand.payload,
      );
      if (
        storedHostCommand === null ||
        agentFrameworkHostCommandImmutableDigest(storedHostCommand) !==
          agentFrameworkHostCommandImmutableDigest(payload)
      ) {
        throw new Error(`Command ID collision: ${commandId}`);
      }
      return runtime.dispatch(storedCommand);
    }
    return runtime.dispatch(
      command(
      agentFrameworkHostCommand(payload),
      expectedSnapshotRevision,
      commandId,
      ),
    );
  };
  const dispatch = async (payload: AgentFrameworkHostCommand) => {
    const reconciledPayload =
      payload.type === "hostUserPromptSubmitted" &&
      typeof observedPromptMessageId === "string" &&
      payload.contentDigest === promptDigest
      ? { ...payload, observedMessageId: observedPromptMessageId }
      : payload;
    const workflowPayload = hasWorkflowPayload(reconciledPayload)
      ? reconciledPayload
      : null;
    const baseline = workflowPayload ? workflowBaseline : null;
    if (!baseline || !workflowPayload) {
      return dispatchCanonical(reconciledPayload);
    }
    const incoming = sessionWorkflowStateFromJson(workflowPayload.workflow);
    return dispatchAgentFrameworkWorkflow({
      runtime,
      runId,
      baseline,
      prepare: ({ baseline: initial, current }) =>
        mergeSessionWorkflowChanges(initial, incoming, current),
      dispatch: (workflow, expectedSnapshotRevision) =>
        dispatchCanonical(
        {
          ...workflowPayload,
          workflow: jsonValue(workflow),
        } as AgentFrameworkHostCommand,
        expectedSnapshotRevision,
      ),
    });
  };
  return {
    spec,
    runtime,
    runId,
    sessionDir,
    host,
    planMode,
    planModeDetection,
    transcriptMetadata: importedMetadata,
    userPromptMessageId: () => {
      if (promptCommandId === null)
        throw new Error("UserPromptSubmit occurrence identity is unavailable");
      return `${promptCommandId}:message`;
    },
    postToolCallId: (name, inputDigest) => {
      const matching = importedSnapshot.toolCalls.filter(
        (tool) => tool.name === name && tool.inputDigest === inputDigest,
      );
      const nonterminal = matching.filter(
        (tool) => !isTerminalToolStatus(tool.status),
      );
      const canonical =
        nonterminal.length === 1
        ? nonterminal[0]
          : nonterminal.length === 0
            ? matching.at(-1)
            : undefined;
      return (
        canonical?.id ??
        `host-tool:${digestScenarioValue({ nativeTranscriptIdentity, name, inputDigest }).slice("sha256:".length)}`
      );
    },
    readWorkflow,
    dispatch,
  };
}

function hostBoundaryCommandId(
  type: AgentFrameworkHostCommand["type"],
  occurrence: unknown,
): string {
  return `host:${type}:${digestScenarioValue(jsonValue({ type, occurrence })).slice("sha256:".length)}`;
}

function hasWorkflowPayload(
  payload: AgentFrameworkHostCommand,
): payload is AgentFrameworkHostCommand & { workflow: JsonValue } {
  return "workflow" in payload;
}

function baseHostContext(
  input: BaseHookInput,
  boundary: HookBoundary,
): HostRuntimeContext {
  return {
    adapter: boundary.spec.name,
    nativeSessionId: input.session_id,
    transcriptPath: input.transcript_path,
    sessionDir: boundary.sessionDir,
    projectDir: boundary.host.projectDir,
    workingDir: input.cwd ?? null,
    permissionMode: input.permission_mode ?? null,
    collaborationMode: input.collaboration_mode ?? null,
    planMode: boundary.planMode,
    planModeDetection: boundary.planModeDetection,
    host: boundary.host,
  };
}

async function preToolContext(
  input: FrameworkPreToolUseHookInput,
  boundary: HookBoundary,
  toolName: string,
  toolInput: unknown,
): Promise<HostRuntimeContext> {
  let outsideRootPath: string | null = null;
  if (FILE_TOOLS.includes(toolName)) {
    for (const raw of extractFilePaths(toolName, toolInput)) {
      const absolute = path.isAbsolute(raw)
        ? raw
        : path.resolve(boundary.host.projectDir, raw);
      if (
        !isPathInDirectory(absolute, boundary.host.projectDir) &&
        !isPlanFile(absolute, boundary.sessionDir)
      ) {
        outsideRootPath = absolute;
        break;
      }
    }
  }
  const recentUserMessages = boundary.transcriptMetadata.recentUserMessages;
  const latestUserMessage = recentUserMessages.at(-1) ?? "";
  const latestUserLogicText = stripQuotedAndPastedContent(latestUserMessage);
  const cachedSnippetSideTaskDischarged =
    boundary.transcriptMetadata.cachedSnippetSideTaskDischarged;
  const slashCommandAllowedTools =
    boundary.transcriptMetadata.slashCommandAllowedTools;
  const batchInfo = boundary.transcriptMetadata.parallelBatch;
  const batch = batchInfo
    ? {
        leaderId: batchInfo.leaderId,
        position: batchInfo.position,
        batchSize: batchInfo.batchSize,
        allIds: batchInfo.allIds,
        calls: batchInfo.members.map((member) => {
          const memberCanonical =
            member.toolUseId === input.tool_use_id
            ? { toolName, toolInput }
              : boundary.spec.canonicalizeToolCall(
                  member.toolName,
                  member.toolInput,
                );
          return {
            toolCallId: member.toolUseId,
            name: memberCanonical.toolName,
            input: jsonValue(memberCanonical.toolInput),
            mayRequireContinuation:
              boundary.spec.toolResultMayRequireContinuation(memberCanonical),
          };
        }),
      }
    : null;
  return {
    ...baseHostContext(input, boundary),
    preTool: {
      rawToolName: input.tool_name,
      rawToolInput: jsonValue(input.tool_input),
      outsideRootPath,
      latestUserMessage,
      latestUserLogicText,
      recentUserMessages,
      cachedSnippetSideTaskDischarged,
      slashCommandAllowedTools: slashCommandAllowedTools
        ? [...slashCommandAllowedTools]
        : null,
      planExit: boundary.spec.isPlanExit({
        event: "PreToolUse",
        canonicalToolName: toolName,
        rawToolName: input.tool_name,
        toolInput,
      }),
      batch,
    },
  };
}

async function workflowState(
  boundary: HookBoundary,
): Promise<SessionWorkflowState> {
  return boundary.readWorkflow();
}
