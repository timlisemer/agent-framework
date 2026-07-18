import * as fs from "fs/promises";
import * as path from "path";
import { describeRules } from "../rules/descriptors.js";
import type { PreToolRule, RuleContext, RuleStateManager } from "../rules/types.js";
import { FILE_TOOLS, extractFilePaths } from "../rules/utils.js";
import { validateClaudeMd } from "../agents/hooks/claude-md-validate.js";
import type { EditValidationToolInput } from "../agents/hooks/edit-validation.js";
import { isTextEditToolName } from "../utils/edit-tools.js";
import { getPlanModeContext } from "../utils/plan-mode-detector.js";
import { stripQuotedAndPastedContent } from "../utils/quote-detection.js";
import { registeredAdapterNames } from "../adapter/spec.js";
import {
  planSourceFromStateValue,
  validateCurrentPlanExit,
  validatePlanExitPresentation,
} from "../utils/plan-source.js";
import { synthesizePostApprovalPrediction } from "../utils/plan-approval-detector.js";
import {
  buildPendingContextInjections,
} from "../utils/context-injection-providers.js";
import {
  derivePlanModeTransition,
  parsePlanModeStoredState,
} from "../utils/plan-mode-entry-state.js";
import {
  deriveWorkflowToolRequirementsFromText,
} from "../utils/prediction-types.js";
import type { ToolPrediction } from "../utils/prediction-schema.js";
import {
  sessionWorkflowStateFromJson,
  type SessionWorkflowState as SessionState,
} from "./session-workflow.js";
import { canonicalJsonEqual } from "../scenario/protocol/canonical-json.js";
import { isRecord as isObject } from "../utils/output.js";
import {
  advanceRequiredToolsAfterAllowedTool,
  advanceRequiredToolsAfterAllowedToolSequence,
  decideRequiredWorkflowToolSequence,
  type LatestUserTurn,
} from "../utils/prediction-types.js";
import {
  isTerminalToolStatus,
  scenarioSnapshotSchema,
  type ScenarioSnapshot,
} from "../scenario/protocol/snapshot.js";
import type { RuleEvaluation } from "./rule-observability.js";
import { toJsonValue, type JsonValue } from "../scenario/protocol/common.js";
import { hostRuntimeContextSchema, type HostRuntimeContext } from "./host-context.js";
import type { ScenarioEffectExecutor, ScenarioEffectRequest, ScenarioEffectResult } from "../scenario/runtime/effects.js";
import { withTemporaryDirectory } from "../utils/temporary-directory.js";
import { throwIfAborted } from "../utils/cancellation.js";
import {
  hookRuleEffectParametersSchema,
  hookRuleEffectResultSchema,
  HOOK_RULE_EFFECT_TYPE,
  toolPolicyEffectParametersSchema,
  toolPolicyEffectResultSchema,
  TOOL_POLICY_EFFECT_TYPE,
  type ToolPolicyEffectResult,
  projectHookRuleEffect,
  projectToolPolicyEffect,
} from "./rule-pipeline-contract.js";
import {
  evaluateRuntimePreToolRules,
  evaluateRuntimeStopRules,
  evaluateRuntimeUserPromptRules,
  runtimeRuleRegistry,
  type RuntimeEvaluatorResult,
} from "./rule-evaluator.js";
import { canonicalToolHistory } from "./tool-history.js";
import { isMissingFileError } from "../utils/filesystem-errors.js";
import { runAppealWithTrace } from "../rules/appeal.js";
import { agentFrameworkStateChange } from "./state-slices.js";

export type RulePipelineEffectExecutorOptions = {
  rules?: readonly PreToolRule[];
  fallback?: ScenarioEffectExecutor;
  temporaryRoot?: string;
};

/** Executes the existing rule registry as a runtime-owned, observable effect. */
export class RulePipelineEffectExecutor implements ScenarioEffectExecutor {
  private readonly rules: PreToolRule[];

  public constructor(private readonly options: RulePipelineEffectExecutorOptions = {}) {
    this.rules = [...(options.rules ?? runtimeRuleRegistry())];
  }

  public async execute(request: ScenarioEffectRequest): Promise<ScenarioEffectResult> {
    throwIfAborted(request.signal);
    if (request.effectType === HOOK_RULE_EFFECT_TYPE) return this.executeHookRules(request);
    if (request.effectType !== TOOL_POLICY_EFFECT_TYPE) {
      if (this.options.fallback) return this.options.fallback.execute(request);
      throw new Error(`Unsupported scenario effect: ${request.effectType}`);
    }
    const execution = isObject(request.executionContext) ? request.executionContext : {};
    const parameters = toolPolicyEffectParametersSchema.parse(execution.parameters ?? request.parameters);
    return this.withCanonicalRuleExecutionContext(
      request,
      execution.snapshot ?? request.executionContext,
      "scenario-rule-effect-",
      async (executionContext) => {
        const {
          snapshot,
          hostContext,
          temporaryDir,
          transcriptPath,
          initialState,
          stateManager,
          traces,
          stages,
        } = executionContext;
        if (parameters.originCommandType === "hostPreToolUse" && !hostContext?.preTool) {
          throw new Error("hostPreToolUse requires canonical pre-tool host context");
        }
        const userMessages = snapshot.conversation
          .filter((message) => message.role === "user")
          .map((message) => message.content);
        const latestUserMessage = hostContext?.preTool?.latestUserMessage ?? userMessages.at(-1) ?? "";
        const context: RuleContext = {
          ...buildBaseRuleContext({
            snapshot,
            hostContext,
            transcriptPath,
            fallbackDirectory: temporaryDir,
            initialState,
            state: initialState,
            stateManager,
            signal: request.signal,
          }),
          hookEvent: "PreToolUse",
          toolName: parameters.name,
          rawToolName: hostContext?.preTool?.rawToolName,
          rawToolInput: hostContext?.preTool?.rawToolInput,
          toolInput: parameters.input,
          toolUseId: parameters.toolCallId,
          ...(hostContext?.preTool?.outsideRootPath
            ? { outsideRootPath: hostContext.preTool.outsideRootPath }
            : {}),
          latestUserMessage,
          latestUserTurn: latestUserTurn(
            latestUserMessage,
            initialState,
            hostContext?.preTool?.latestUserLogicText,
          ),
          recentUserMessages: hostContext?.preTool?.recentUserMessages ?? userMessages.slice(-5),
          cachedSnippetSideTaskDischarged: hostContext?.preTool?.cachedSnippetSideTaskDischarged,
          slashCommandAllowedTools: hostContext?.preTool?.slashCommandAllowedTools ?? undefined,
        };
        const batchResolution = resolveBatchPolicy(snapshot, hostContext, initialState);
        let decision = batchResolution.decision;
        if (!decision && !batchResolution.mirrored) {
          decision = await evaluateRuntimePreToolRules(this.rules, context, "PreToolUse", {
            commandId: parameters.commandId,
            onTrace: async (trace) => {
              traces.push(trace);
              await request.reportProgress?.(toJsonValue(trace));
            },
            onStage: (stage) => stages.push(stage),
          });
          throwIfAborted(request.signal);
          if (!decision) decision = await validateInstructionFiles(context, hostContext, stages);
        }
        const resolvedDecision = decision ?? {
          decision: "allow" as const,
          reason: "All checks passed",
          agent: "all-rules",
          usesLlm: false,
        };
        if (!batchResolution.mirrored) await stateManager.update((state) => {
          const next = { ...state, toolCallCount: state.toolCallCount + 1 };
          if (resolvedDecision.decision === "allow" && next.currentPrediction) {
            next.currentPrediction = batchResolution.advanceCalls
              ? advanceRequiredToolsAfterAllowedToolSequence(next.currentPrediction, batchResolution.advanceCalls)
              : advanceRequiredToolsAfterAllowedTool(next.currentPrediction, parameters.name, parameters.input);
          }
          if (resolvedDecision.decision === "allow" && hostContext?.preTool?.planExit) {
            next.previousEditIntent = state.currentEditIntent ?? null;
            next.currentEditIntent = true;
            next.editIntentTimestamp = Date.now();
            next.editIntentOverturnCount = 0;
          }
          return next;
        });
        const finalState = await stateManager.load();
        throwIfAborted(request.signal);
        const changes = workflowStateChanges(
          initialState,
          finalState,
          snapshot.stateSlices["session.workflow"] !== undefined,
        );
        const batch = hostContext?.preTool?.batch;
        if (batch && batch.position === 0 && batch.batchSize > 1) {
          changes.push(agentFrameworkStateChange({
            key: batchDecisionKey(batch.leaderId),
            schemaId: "agent-framework://state/parallel-batch-decision",
            source: "rulePipeline.evaluate",
            value: {
              decision: resolvedDecision.decision,
              reason: resolvedDecision.reason,
              agent: resolvedDecision.agent,
              batchSize: batch.batchSize,
              allIds: batch.allIds,
            },
          }));
        }
        const result = toolPolicyEffectResultSchema.parse({
          kind: "toolPolicyEvaluation",
          toolCallId: parameters.toolCallId,
          requiresUserDecision: parameters.requiresUserDecision,
          decision: resolvedDecision.decision,
          reason: resolvedDecision.reason,
          agent: resolvedDecision.agent,
          gateNote: resolvedDecision.gateNote ?? null,
          rules: describeRules(this.rules),
          evaluations: traces,
          stages,
          stateChanges: changes,
        });
        return {
          result: toJsonValue(result),
          projection: projectToolPolicyEffect(result, snapshot),
          metadata: {
            executor: "agent-framework-rule-pipeline",
            usesLlm: resolvedDecision.usesLlm ?? false,
          },
        };
      },
    );
  }

  private async executeHookRules(request: ScenarioEffectRequest): Promise<ScenarioEffectResult> {
    throwIfAborted(request.signal);
    const execution = isObject(request.executionContext) ? request.executionContext : {};
    const parameters = hookRuleEffectParametersSchema.parse(execution.parameters ?? request.parameters);
    return this.withCanonicalRuleExecutionContext(
      request,
      execution.snapshot,
      "scenario-hook-effect-",
      async (executionContext) => {
        const {
          snapshot,
          hostContext: parsedHostContext,
          temporaryDir,
          transcriptPath,
          initialState,
          stateManager,
          traces,
          stages,
        } = executionContext;
        if (!parsedHostContext) throw new Error(`${parameters.event} requires canonical host context`);
        const hostContext = { ...parsedHostContext, transcriptPath };
        const hookStateChanges: ToolPolicyEffectResult["stateChanges"] = [];
        let decision: "allow" | "block" = "allow";
        let reason: string | null = null;
        let contextMessage: string | null = null;
        if (parameters.event === "UserPromptSubmit") {
          const promptContext = hostContext.userPrompt;
          if (!promptContext) throw new Error("UserPromptSubmit context is missing");
          const prompt = promptContext.prompt;
          if (promptContext.planExit) {
            const validation = await validateCurrentPlanExit({
              transcriptPath: hostContext.transcriptPath,
              sessionDir: hostContext.sessionDir,
              projectDir: hostContext.projectDir,
              hookName: "UserPromptSubmit",
              prompt,
              currentPlan: planSourceFromStateValue(snapshot.stateSlices["plan.current"]?.value),
            });
            throwIfAborted(request.signal);
            const persistedValidation = persistPlanValidation(
              validation,
              "rulePipeline.UserPromptSubmit",
            );
            hookStateChanges.push(...persistedValidation.stateChanges);
            if (persistedValidation.blockingReason) {
              decision = "block";
              reason = persistedValidation.blockingReason;
            } else {
              await stateManager.update((state) => ({
                ...state,
                previousEditIntent: state.currentEditIntent ?? null,
                currentEditIntent: true,
                editIntentTimestamp: Date.now(),
                editIntentOverturnCount: 0,
                respondFirstChecked: false,
                currentPrediction: synthesizePostApprovalPrediction(prompt),
                frustrationStreak: 0,
              }));
            }
          } else {
            await stateManager.update(resetForUserPromptTurn);
            const state = await stateManager.load();
            const context: RuleContext = {
              ...buildBaseRuleContext({
                snapshot,
                hostContext,
                transcriptPath: hostContext.transcriptPath,
                fallbackDirectory: temporaryDir,
                initialState,
                state,
                stateManager,
                signal: request.signal,
              }),
              hookEvent: "UserPromptSubmit",
              toolName: "",
              userPrompt: prompt,
            };
            if (promptContext.workflowOnly && promptContext.workflowInvocation) {
              await stateManager.update((current) => ({
                ...current,
                currentPrediction: synthesizeWorkflowInvocationPrediction(
                  prompt,
                  promptContext.workflowInvocation!,
                  promptContext.workflowInstructionText,
                ),
                frustrationStreak: 0,
                currentWindowSize: 2,
              }));
            } else {
              await evaluateRuntimeUserPromptRules(this.rules, context, {
                commandId: parameters.commandId,
                onTrace: async (trace) => {
                  traces.push(trace);
                  await request.reportProgress?.(toJsonValue(trace));
                },
                onStage: (stage) => stages.push(stage),
              });
              throwIfAborted(request.signal);
            }
            const transition = derivePlanModeTransition({
              source: "UserPromptSubmit",
              detection: hostContext.planModeDetection,
              previous: parsePlanModeStoredState(snapshot.stateSlices["plan.mode"]?.value),
            });
            const pending = await buildPendingContextInjections({
              projectDir: hostContext.projectDir,
              sourceEvent: "UserPromptSubmit",
              planModeTransition: transition,
            });
            throwIfAborted(request.signal);
            hookStateChanges.push(agentFrameworkStateChange({
              key: "plan.mode",
              schemaId: "agent-framework://state/plan-mode",
              value: transition.current,
              source: "rulePipeline.UserPromptSubmit",
            }));
            if (pending.length > 0) {
              const prior = snapshot.stateSlices.injections?.value;
              const injections = [
                ...(Array.isArray(prior) ? prior : []),
                ...pending.map((injection) => ({
                  ...injection,
                  event: "UserPromptSubmit",
                  recordedAt: new Date().toISOString(),
                })),
              ];
              hookStateChanges.push(agentFrameworkStateChange({
                key: "injections",
                schemaId: "agent-framework://state/injections",
                value: injections,
                source: "rulePipeline.UserPromptSubmit",
              }));
              contextMessage = pending.map((injection) => injection.message).join("\n\n");
            }
          }
        } else {
          const stopContext = hostContext.stop;
          if (!stopContext) throw new Error("Stop context is missing");
          if (!stopContext.stopBlockDisabled) {
            const assistantText = stopContext.lastAssistantMessage ??
              stopContext.latestAssistantText;
            const planExitText = stopContext.planExitText;
            if (planExitText !== null && !hostContext.planMode) {
              decision = "block";
              reason = "Proposed plan block emitted outside plan mode.";
            } else if (planExitText !== null) {
              const validation = await validatePlanExitPresentation({
                transcriptPath: hostContext.transcriptPath,
                sessionDir: hostContext.sessionDir,
                projectDir: hostContext.projectDir,
                hookName: "Stop",
                assistantText: planExitText,
              });
              throwIfAborted(request.signal);
              const persistedValidation = persistPlanValidation(validation, "rulePipeline.Stop");
              hookStateChanges.push(...persistedValidation.stateChanges);
              if (persistedValidation.blockingReason) {
                decision = "block";
                reason = persistedValidation.blockingReason;
              }
            } else if (stopContext.latestUserText !== null && assistantText !== null) {
              const state = await stateManager.load();
              const result = await evaluateRuntimeStopRules(this.rules, {
                ...buildBaseRuleContext({
                  snapshot,
                  hostContext,
                  transcriptPath: hostContext.transcriptPath,
                  fallbackDirectory: temporaryDir,
                  initialState,
                  state,
                  stateManager,
                  signal: request.signal,
                }),
                hookEvent: "Stop",
                toolName: "",
                assistantText,
                userText: stopContext.latestUserText,
                priorErrorContext: stopContext.priorErrorContext,
              }, {
                commandId: parameters.commandId,
                onTrace: async (trace) => {
                  traces.push(trace);
                  await request.reportProgress?.(toJsonValue(trace));
                },
              });
              throwIfAborted(request.signal);
              if (result.decision === "block" && result.systemMessage) {
                decision = "block";
                reason = result.systemMessage;
              }
            }
          }
        }
        const finalState = await stateManager.load();
        throwIfAborted(request.signal);
        const result = hookRuleEffectResultSchema.parse({
            kind: "hookRuleEvaluation",
            event: parameters.event,
            decision,
            reason,
            contextMessage,
            rules: describeRules(this.rules),
            evaluations: traces,
            stages,
            stateChanges: [
              ...workflowStateChanges(
                initialState,
                finalState,
                snapshot.stateSlices["session.workflow"] !== undefined,
              ),
              ...hookStateChanges,
            ],
          });
        return {
          result: toJsonValue(result),
          projection: projectHookRuleEffect(result, snapshot),
          metadata: { executor: "agent-framework-rule-pipeline", usesLlm: false },
        };
      },
    );
  }

  private async withCanonicalRuleExecutionContext<T>(
    request: ScenarioEffectRequest,
    snapshotInput: unknown,
    temporaryPrefix: string,
    callback: (context: CanonicalRuleExecutionContext) => Promise<T>,
  ): Promise<T> {
    const snapshot = scenarioSnapshotSchema.parse(snapshotInput);
    const hostContext = parseHostContext(snapshot.stateSlices["host.context"]?.value);
    return withTemporaryDirectory({
      prefix: temporaryPrefix,
      ...(this.options.temporaryRoot === undefined ? {} : { parent: this.options.temporaryRoot }),
    }, async (temporaryDir) => {
      throwIfAborted(request.signal);
      const transcriptPath = path.join(temporaryDir, "canonical-transcript.jsonl");
      await fs.writeFile(transcriptPath, canonicalTranscriptFromSnapshot(snapshot), "utf8");
      const initialState = sessionWorkflowStateFromJson(snapshot.stateSlices["session.workflow"]?.value);
      return callback({
        snapshot,
        hostContext,
        temporaryDir,
        transcriptPath,
        initialState,
        stateManager: new MemoryRuleStateManager(initialState),
        traces: [],
        stages: [],
      });
    });
  }
}

type CanonicalRuleExecutionContext = {
  snapshot: ScenarioSnapshot;
  hostContext: HostRuntimeContext | undefined;
  temporaryDir: string;
  transcriptPath: string;
  initialState: SessionState;
  stateManager: MemoryRuleStateManager;
  traces: RuleEvaluation[];
  stages: ToolPolicyEffectResult["stages"];
};

type BatchResolution = {
  decision: RuntimeEvaluatorResult | null;
  mirrored: boolean;
  advanceCalls?: Array<{ toolName: string; toolInput: unknown }>;
};

function resolveBatchPolicy(
  snapshot: ReturnType<typeof scenarioSnapshotSchema.parse>,
  hostContext: HostRuntimeContext | undefined,
  state: SessionState,
): BatchResolution {
  const batch = hostContext?.preTool?.batch;
  if (!batch) return { decision: null, mirrored: false };
  if (batch.position > 0) {
    const cached = snapshot.stateSlices[batchDecisionKey(batch.leaderId)]?.value;
    if (isObject(cached) && (cached.decision === "allow" || cached.decision === "deny")) {
      return {
        decision: {
          decision: cached.decision,
          agent: typeof cached.agent === "string" ? cached.agent : "batch-sibling",
          reason: cached.decision === "deny"
            ? `Error in parallel tool call: ${typeof cached.reason === "string" ? cached.reason : "batch leader denied"}`
            : typeof cached.reason === "string" ? cached.reason : "Batch leader allowed",
          usesLlm: false,
        },
        mirrored: true,
      };
    }
  }
  const calls = batch.position === 0
    ? batch.calls
    : batch.calls.filter((call) => call.toolCallId === batch.allIds[batch.position]);
  if (batch.position === 0) {
    const continuationBoundary = calls.findIndex((call) => call.mayRequireContinuation);
    if (continuationBoundary >= 0 && continuationBoundary < calls.length - 1) {
      return {
        decision: {
          decision: "deny",
          agent: "prediction-block",
          reason: `${calls[continuationBoundary].name} may require an adapter continuation and must complete before later parallel tools run.`,
          usesLlm: false,
        },
        mirrored: false,
      };
    }
  }
  if ((state.currentPrediction?.explicitlyRequiredTools?.length ?? 0) > 0 && state.currentPrediction) {
    const predictionCalls = calls.map((call) => ({ toolName: call.name, toolInput: call.input }));
    const sequence = decideRequiredWorkflowToolSequence(state.currentPrediction, predictionCalls);
    if (sequence.decision === "deny") {
      return {
        decision: {
          decision: "deny",
          agent: "prediction-block",
          reason: sequence.reason ?? "Workflow batch violates required tool order.",
          usesLlm: false,
        },
        mirrored: false,
      };
    }
    return { decision: null, mirrored: false, advanceCalls: predictionCalls };
  }
  return { decision: null, mirrored: false };
}

function batchDecisionKey(leaderId: string): string {
  return `host.batchDecision.${leaderId}`;
}

class MemoryRuleStateManager implements RuleStateManager<SessionState> {
  public constructor(private value: SessionState) {}

  public async load(): Promise<SessionState> {
    return structuredClone(this.value);
  }

  public async update(update: (value: SessionState) => SessionState): Promise<void> {
    this.value = update(structuredClone(this.value));
  }
}

function planModeFromSnapshot(value: JsonValue | undefined): boolean {
  return isObject(value) && value.active === true;
}

type PlanExitValidation = Awaited<ReturnType<typeof validateCurrentPlanExit>>;

function persistPlanValidation(
  validation: PlanExitValidation,
  source: "rulePipeline.UserPromptSubmit" | "rulePipeline.Stop",
): {
  stateChanges: ToolPolicyEffectResult["stateChanges"];
  blockingReason: string | null;
} {
  const failureReason = validation.reason ?? "Plan validation failed";
  const stateChanges: ToolPolicyEffectResult["stateChanges"] = [agentFrameworkStateChange({
    key: "plan.validation",
    schemaId: "agent-framework://state/plan-validation",
    value: validation.approved
      ? { status: "pass", source: validation.source ?? null, contentHash: validation.contentHash ?? null }
      : { status: "fail", reason: failureReason },
    source,
  })];
  if (validation.approved && validation.source?.kind === "file") {
    stateChanges.push(agentFrameworkStateChange({
      key: "plan.current",
      schemaId: "agent-framework://state/current-plan",
      value: validation.source,
      source,
    }));
  }
  return {
    stateChanges,
    blockingReason: validation.approved
      ? null
      : validation.reason
        ? `Plan validation failed: ${validation.reason}`
        : failureReason,
  };
}

function latestUserTurn(
  text: string,
  state: SessionState,
  logicText?: string,
): LatestUserTurn | undefined {
  if (!text) return undefined;
  const cached = state.currentPrediction?.userMessageFull ?? state.currentPrediction?.userMessageSnippet ?? "";
  return {
    rawText: text,
    logicText: logicText ?? stripQuotedAndPastedContent(text),
    displaySnippet: text.slice(0, 200),
    matchesCachedPrediction: cached.length > 0 && (text.includes(cached) || cached.includes(text)),
  };
}

function parseHostContext(value: JsonValue | undefined): HostRuntimeContext | undefined {
  const parsed = hostRuntimeContextSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function buildBaseRuleContext(input: {
  snapshot: ScenarioSnapshot;
  hostContext: HostRuntimeContext | undefined;
  transcriptPath: string;
  fallbackDirectory: string;
  initialState: SessionState;
  state: SessionState;
  stateManager: RuleStateManager<SessionState>;
  signal?: AbortSignal;
}): RuleContext {
  const planMode = input.hostContext?.planMode ??
    planModeFromSnapshot(input.snapshot.stateSlices["plan.mode"]?.value);
  const adapter = input.hostContext?.adapter ?? input.snapshot.manifest.adapter;
  return {
    toolName: "",
    ...(adapter !== null && adapter !== undefined && registeredAdapterNames().includes(adapter)
      ? { adapter }
      : {}),
    projectDir: input.hostContext?.projectDir ?? input.snapshot.identity.projectDir ??
      input.snapshot.identity.workingDir ?? input.fallbackDirectory,
    ...(input.hostContext?.host ? { host: input.hostContext.host } : {}),
    transcriptPath: input.transcriptPath,
    sessionDir: input.hostContext?.sessionDir ?? input.fallbackDirectory,
    sessionId: input.hostContext?.nativeSessionId ?? input.snapshot.runId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    state: input.state,
    stateManager: input.stateManager,
    toolHistory: canonicalToolHistory(input.snapshot),
    reasoningHistory: canonicalReasoningHistory(
      input.snapshot,
      input.initialState.gateReasoningResetAt,
    ),
    currentPlan: planSourceFromStateValue(input.snapshot.stateSlices["plan.current"]?.value),
    planMode,
    planModeCtx: getPlanModeContext(planMode),
  };
}

async function validateInstructionFiles(
  context: RuleContext,
  hostContext: HostRuntimeContext | undefined,
  stages: ToolPolicyEffectResult["stages"],
): Promise<RuntimeEvaluatorResult | null> {
  if (!hostContext?.host || !FILE_TOOLS.includes(context.toolName) ||
    !isTextEditToolName(context.toolName)) return null;
  const filePaths = extractFilePaths(context.toolName, context.toolInput);
  const instructionFiles = new Set(hostContext.host.instructionFiles.map((file) => path.resolve(file)));
  const matches = filePaths
    .map((file) => path.resolve(context.projectDir, file))
    .filter((file) => instructionFiles.has(file));
  let validationOverturned = false;
  let overturnedGateNote: string | undefined;
  for (const filePath of matches) {
    let currentContent: string | null = null;
    try {
      currentContent = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const validation = await validateClaudeMd(
      currentContent,
      context.toolName,
      context.toolInput as EditValidationToolInput,
      context.projectDir,
      "PreToolUse",
      context.signal,
    );
    if (!validation.approved) {
      const reason = `${path.basename(filePath)} validation failed: ${validation.reason ?? "validation failed"}`;
      const ruleId = "agent-framework.rule.claude-md-validate";
      const appeal = await runAppealWithTrace({
        context,
        hookName: "PreToolUse",
        ruleId,
        reason,
        blockedBy: "claude-md-validate",
        onStage: (stage) => stages.push(stage),
      });
      if (appeal.overturned) {
        validationOverturned = true;
        overturnedGateNote = appeal.gateNote;
        continue;
      }
      return {
        decision: "deny",
        agent: "claude-md-validate",
        reason,
        ...(appeal.gateNote === undefined ? {} : { gateNote: appeal.gateNote }),
        usesLlm: true,
      };
    }
  }
  if (validationOverturned) {
    return {
      decision: "allow",
      agent: "tool-appeal",
      reason: "Instruction-file validation denial was overturned",
      ...(overturnedGateNote === undefined ? {} : { gateNote: overturnedGateNote }),
      usesLlm: true,
    };
  }
  if (matches.length > 0 && matches.length === filePaths.length) {
    return {
      decision: "allow",
      agent: "claude-md-validate",
      reason: `${matches.map((file) => path.basename(file)).join(", ")} validation passed`,
      usesLlm: true,
    };
  }
  return null;
}

/** Build a canonical workflow mutation, ignoring object insertion-order differences. */
export function workflowStateChanges(
  initial: SessionState,
  final: SessionState,
  existed: boolean,
): ToolPolicyEffectResult["stateChanges"] {
  const initialValue = toJsonValue(initial);
  const finalValue = toJsonValue(final);
  if (existed && canonicalJsonEqual(initialValue, finalValue)) return [];
  return [agentFrameworkStateChange({
    key: "session.workflow",
    schemaId: "agent-framework://state/session-workflow",
    status: existed ? "validated" : "defaulted",
    source: "rulePipeline.evaluate",
    value: finalValue,
    baseValue: initialValue,
  })];
}

function resetForUserPromptTurn(state: SessionState): SessionState {
  return {
    ...state,
    previousEditIntent: state.currentEditIntent ?? null,
    currentEditIntent: null,
    editIntentTimestamp: Date.now(),
    editIntentOverturnCount: 0,
    respondFirstChecked: false,
    driftState: {},
    driftReductionCredits: {},
    lastProcessedPlanApprovalToolUseId: null,
    lastUserMessageTimestamp: Date.now(),
  };
}

function synthesizeWorkflowInvocationPrediction(
  prompt: string,
  workflow: string,
  instructionText: string | null,
): ToolPrediction {
  const prefix = `[workflow invoked: ${workflow}] `;
  const snippet = prefix + prompt.slice(0, Math.max(0, 200 - prefix.length));
  const requirements = instructionText
    ? deriveWorkflowToolRequirementsFromText(instructionText)
    : { explicitlyRequiredTools: [], nonBlockingTools: [] };
  return {
    mood: "neutral",
    trust: "normal",
    intent: `User invoked the ${workflow} workflow. Complete that workflow and report its result.`,
    blockedIntent: "",
    explicitlyAllowedTools: [],
    explicitlyRequiredTools: requirements.explicitlyRequiredTools,
    nonBlockingTools: requirements.nonBlockingTools,
    explicitlyBlockedSubstrings: [],
    blockAllTools: false,
    hasExplicitOverride: false,
    contextSwitch: "yes",
    questionIsStalling: "n/a",
    userMessageFull: prefix + prompt,
    userMessageSnippet: snippet,
    timestamp: Date.now(),
  };
}

export function canonicalTranscriptFromSnapshot(
  snapshot: ReturnType<typeof scenarioSnapshotSchema.parse>,
): string {
  const rows: Array<{ sequence: number; value: Record<string, unknown> }> = snapshot.conversation.map(
    (message, index) => ({
      sequence: message.recordSeq,
      value: {
        type: message.role === "user" ? "user" : "assistant",
        uuid: message.id,
        timestamp: message.createdAt,
        isMeta: message.role === "synthetic" || message.role === "system",
        message: {
          role: message.role === "user" ? "user" : "assistant",
          content: message.content,
        },
        index,
      },
    }),
  );
  for (const tool of snapshot.toolCalls) {
    rows.push({
      sequence: tool.recordSeq,
      value: {
        type: "assistant",
        uuid: `tool-request:${tool.id}`,
        timestamp: tool.createdAt,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: tool.id, name: tool.name, input: tool.input }],
        },
      },
    });
    if (isTerminalToolStatus(tool.status)) {
      rows.push({
        sequence: tool.recordSeq + 0.5,
        value: {
          type: "user",
          uuid: `tool-result:${tool.id}`,
          timestamp: tool.completedAt ?? tool.updatedAt,
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: tool.id,
              is_error: tool.status === "failed" || tool.status === "denied",
              content: tool.output,
            }],
          },
        },
      });
    }
  }
  rows.sort((left, right) => left.sequence - right.sequence);
  return `${rows.map((row) => JSON.stringify(row.value)).join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

function canonicalReasoningHistory(
  snapshot: ReturnType<typeof scenarioSnapshotSchema.parse>,
  resetAt: number,
): string {
  const value = snapshot.stateSlices["gate.reasoning"]?.value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const recordedAt = typeof entry.recordedAt === "string" ? Date.parse(entry.recordedAt) : 0;
    if (recordedAt < resetAt) return [];
    return [JSON.stringify(entry)];
  }).join("\n");
}
