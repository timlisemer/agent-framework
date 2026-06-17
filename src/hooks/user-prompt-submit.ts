import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionState } from "../utils/session-store.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import { getPlanModeContext } from "../utils/plan-mode-detector.js";
import { evaluateRulesForUserPromptSubmit, ALL_RULES } from "../rules/index.js";
import type { RuleContext } from "../rules/types.js";
import type { AdapterEncoder } from "../adapter/types.js";
import type { FrameworkUserPromptSubmitHookInput } from "./types.js";
import { resolveHostContext } from "../utils/host-context.js";
import {
  appendCapture,
  capturePlanModeFromDetection,
  capturePlanModeFromTransition,
} from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";
import { onUserPromptTurn, rotateEpochIfNeeded } from "../scenario/lifecycle.js";
import { activeSpec } from "../adapter/spec.js";
import { validateCurrentPlanExit, writeCurrentPlanSidecar } from "../utils/plan-source.js";
import { clearGateReasoning } from "../utils/gate-reasoning-cache.js";
import { synthesizePostApprovalPrediction } from "../utils/plan-approval-detector.js";
import {
  commitPlanModeTransition,
  computePlanModeTransition,
} from "../utils/plan-mode-entry-state.js";
import { buildPendingContextInjections } from "../utils/context-injection-providers.js";
import { appendSessionInjections, combineInjectionMessages } from "../utils/session-injections.js";
import {
  deriveWorkflowToolRequirementsFromText,
  type ToolPrediction,
} from "../utils/prediction-types.js";

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

/**
 * UserPromptSubmit Hook
 *
 * Fires when the user submits a prompt. Bootstraps the rule pipeline for
 * UserPromptSubmit-eligible rules (currently sentimentRule). Rules run purely
 * for side-effects (e.g., writing state.currentPrediction).
 */

export async function mainUserPromptSubmit(input: FrameworkUserPromptSubmitHookInput, encoder: AdapterEncoder): Promise<void> {
  const host = resolveHostContext(input);
  const projectDir = host.projectDir;

  const sessionDir = getAgentFrameworkSessionDir({ transcriptPath: input.transcript_path });

  await rotateEpochIfNeeded(sessionDir, input.transcript_path);

  const stateManager = getSessionState(sessionDir);
  const spec = activeSpec();
  const planModeDetection = spec.detectPlanMode({
    permissionMode: input.permission_mode,
    collaborationMode: input.collaboration_mode,
    transcriptPath: input.transcript_path,
  });
  if (spec.isPlanExit({ event: "UserPromptSubmit", prompt: input.prompt })) {
    const state = await stateManager.load();
    const validation = await validateCurrentPlanExit({
      transcriptPath: input.transcript_path,
      sessionDir,
      projectDir,
      hookName: "UserPromptSubmit",
      prompt: input.prompt,
    });
    const epoch = loadCurrentEpoch(sessionDir);
    if (!validation.approved) {
      const reason = `Plan validation failed: ${validation.reason}`;
      const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
      appendCapture(sessionDir, {
        ts: Date.now(),
        epoch_id: epoch?.id ?? "unknown",
        parent_capture_seq: null,
        event: "UserPromptSubmit",
        decision: "block",
        permission_mode: input.permission_mode ?? null,
        plan_mode: capturePlanModeFromDetection(planModeDetection),
        injection_seqs: [],
        injection_hashes: [],
        state_snapshot_seq: snapshotSeq,
      });
      const out = encoder.encodeUserPromptSubmitBlock
        ? encoder.encodeUserPromptSubmitBlock(reason)
        : encoder.encodeContext("UserPromptSubmit", reason);
      await exitAfterFlush(out.exitCode, out.stdout);
      return;
    }
    if (validation.source?.kind === "file") {
      writeCurrentPlanSidecar(sessionDir, validation.source);
    }
    await stateManager.update((s) => ({
      ...s,
      previousEditIntent: s.currentEditIntent ?? null,
      currentEditIntent: true,
      editIntentTimestamp: Date.now(),
      editIntentOverturnCount: 0,
      respondFirstChecked: false,
      currentPrediction: synthesizePostApprovalPrediction(input.prompt),
      frustrationStreak: 0,
    }));
    await clearGateReasoning(sessionDir);

    const latestState = await stateManager.load().catch(() => state);
    const snapshotSeq = appendStateSnapshot(sessionDir, latestState, input.transcript_path);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "UserPromptSubmit",
      decision: "ok",
      permission_mode: input.permission_mode ?? null,
      plan_mode: capturePlanModeFromDetection(planModeDetection),
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
    const out = encoder.encodeOk("UserPromptSubmit");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  await onUserPromptTurn(sessionDir);
  const state = await stateManager.load();

  const planMode = planModeDetection.active;

  const ctx: RuleContext = {
    hookEvent: "UserPromptSubmit",
    toolName: "",
    userPrompt: input.prompt,
    projectDir,
    host,
    transcriptPath: input.transcript_path,
    sessionDir,
    sessionId: input.session_id,
    state,
    stateManager,
    planMode,
    planModeCtx: getPlanModeContext(planMode),
  };

  const workflowInvocation = spec.recognizeWorkflowInvocation(input.prompt);
  if (spec.isWorkflowInvocationOnly(input.prompt) && workflowInvocation) {
    const instructionText = spec.workflowInstructionText(workflowInvocation, host);
    await stateManager.update((s) => ({
      ...s,
      currentPrediction: synthesizeWorkflowInvocationPrediction(
        input.prompt,
        workflowInvocation,
        instructionText,
      ),
      frustrationStreak: 0,
      currentWindowSize: 2,
    }));
  } else {
    await evaluateRulesForUserPromptSubmit(ALL_RULES, ctx);
  }

  const transition = await computePlanModeTransition({
    source: "UserPromptSubmit",
    sessionDir,
    detection: planModeDetection,
  });
  const pendingInjections = await buildPendingContextInjections({
    projectDir,
    sourceEvent: "UserPromptSubmit",
    planModeTransition: transition,
  });
  await commitPlanModeTransition(sessionDir, transition);
  const injectionRecords = appendSessionInjections(
    sessionDir,
    "UserPromptSubmit",
    pendingInjections,
  );

  const latestState = await stateManager.load().catch(() => state);
  const snapshotSeq = appendStateSnapshot(sessionDir, latestState, input.transcript_path);
  const epoch = loadCurrentEpoch(sessionDir);
  appendCapture(sessionDir, {
    ts: Date.now(),
    epoch_id: epoch?.id ?? "unknown",
    parent_capture_seq: null,
    event: "UserPromptSubmit",
    decision: "ok",
    permission_mode: input.permission_mode ?? null,
    plan_mode: capturePlanModeFromTransition(transition),
    injection_seqs: injectionRecords.map((record) => record.seq),
    injection_hashes: injectionRecords.map((record) => record.message_hash),
    state_snapshot_seq: snapshotSeq,
  });

  const out = injectionRecords.length > 0
    ? encoder.encodeContext("UserPromptSubmit", combineInjectionMessages(injectionRecords))
    : encoder.encodeOk("UserPromptSubmit");
  await exitAfterFlush(out.exitCode, out.stdout);
}
