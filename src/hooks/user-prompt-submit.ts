import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, getSessionState } from "../utils/session-store.js";
import { isPlanModeActive, isPlanModeFromInput, getPlanModeContext } from "../utils/plan-mode-detector.js";
import { evaluateRulesForUserPromptSubmit, ALL_RULES } from "../rules/index.js";
import type { RuleContext } from "../rules/types.js";
import type { AdapterEncoder } from "../adapter/types.js";
import type { FrameworkUserPromptSubmitHookInput } from "./types.js";
import { resolveHostContext } from "../utils/host-context.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { detectEpochChange, rotateEpoch, loadCurrentEpoch } from "../scenario/epoch.js";
import { onEpochRotation, onUserPromptTurn } from "../scenario/lifecycle.js";
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

  if (isSubagent(input.transcript_path)) {
    const out = encoder.encodeOk("UserPromptSubmit");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const sessionDir = getSessionDir(input.transcript_path);

  // Detect epoch change (transcript rewind) and reset derived caches when needed.
  const epochChange = detectEpochChange(sessionDir, input.transcript_path);
  if (epochChange.rotated) {
    const newEpoch = rotateEpoch(
      sessionDir,
      epochChange.reason!,
      epochChange.anchorUuid ?? null,
    );
    await onEpochRotation(sessionDir, newEpoch);
  }

  const stateManager = getSessionState(sessionDir);
  const spec = activeSpec();
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
    if (validation.source?.kind === "inline") {
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

  const planMode =
    input.permission_mode !== undefined
      ? isPlanModeFromInput(input)
      : isPlanModeActive(input.transcript_path);

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
    subagent: false,
  };

  const workflowInvocation = spec.recognizeWorkflowInvocation(input.prompt);
  if (workflowInvocation === null) {
    await evaluateRulesForUserPromptSubmit(ALL_RULES, ctx);
  }

  const transition = await computePlanModeTransition({
    source: "UserPromptSubmit",
    sessionDir,
    transcriptPath: input.transcript_path,
    permissionMode: input.permission_mode,
  });
  await commitPlanModeTransition(sessionDir, transition);
  const pendingInjections = await buildPendingContextInjections({
    projectDir,
    sourceEvent: "UserPromptSubmit",
    planModeTransition: transition,
  });
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
    plan_mode: {
      permission_mode: transition.permission_mode,
      detection_source: transition.detection_source,
      previous: transition.previous,
      current: transition.current,
      active: transition.active,
      entered: transition.entered,
      exited: transition.exited,
    },
    injection_seqs: injectionRecords.map((record) => record.seq),
    injection_hashes: injectionRecords.map((record) => record.message_hash),
    state_snapshot_seq: snapshotSeq,
  });

  const out = injectionRecords.length > 0
    ? encoder.encodeContext("UserPromptSubmit", combineInjectionMessages(injectionRecords))
    : encoder.encodeOk("UserPromptSubmit");
  await exitAfterFlush(out.exitCode, out.stdout);
}
