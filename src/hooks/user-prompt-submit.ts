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
import { detectPlanModeEntryAndBuildInjection } from "../utils/plan-mode-entry-state.js";

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

  const workflowInvocation = activeSpec().recognizeWorkflowInvocation(input.prompt);
  if (workflowInvocation === null) {
    await evaluateRulesForUserPromptSubmit(ALL_RULES, ctx);
  }

  const latestState = await stateManager.load().catch(() => state);
  const snapshotSeq = appendStateSnapshot(sessionDir, latestState, input.transcript_path);
  const epoch = loadCurrentEpoch(sessionDir);
  appendCapture(sessionDir, {
    ts: Date.now(),
    epoch_id: epoch?.id ?? "unknown",
    parent_capture_seq: null,
    event: "UserPromptSubmit",
    decision: "ok",
    state_snapshot_seq: snapshotSeq,
  });

  const injection = await detectPlanModeEntryAndBuildInjection({
    source: "UserPromptSubmit",
    sessionDir,
    transcriptPath: input.transcript_path,
    projectDir,
    permissionMode: input.permission_mode,
  });

  const out = injection.message && encoder.encodeContext
    ? encoder.encodeContext("UserPromptSubmit", injection.message)
    : encoder.encodeOk("UserPromptSubmit");
  await exitAfterFlush(out.exitCode, out.stdout);
}
