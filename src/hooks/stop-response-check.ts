import { setTranscriptPath } from "../utils/execution-context.js";
import { writeTool } from "../utils/synthetic.js";
import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir, getSessionState } from "../utils/session-store.js";
import { isPlanModeActive, isPlanModeFromInput, getPlanModeContext } from "../utils/plan-mode-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { readTranscriptExact } from "../utils/transcript.js";
import { FIRST_RESPONSE_STOP_COUNTS } from "../utils/transcript-presets.js";
import { evaluateRulesForStop, ALL_RULES } from "../rules/index.js";
import { getMostRecentMessage } from "../rules/response-align-stop.js";
import type { RuleContext } from "../rules/types.js";
import type { AdapterEncoder } from "../adapter/types.js";
import type { FrameworkStopHookInput } from "./types.js";
import { resolveHostContext } from "../utils/host-context.js";
import { activeSpec } from "../adapter/spec.js";
import { validateCurrentPlanExit, writeCurrentPlanSidecar } from "../utils/plan-source.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { detectEpochChange, rotateEpoch, loadCurrentEpoch } from "../scenario/epoch.js";
import { onEpochRotation } from "../scenario/lifecycle.js";

/**
 * Stop Hook: Response Check
 *
 * This hook runs when the AI stops (text-only response, no tool calls).
 * Bootstraps the rule pipeline for Stop-eligible rules (responseAlignStopRule).
 */

export async function mainStop(input: FrameworkStopHookInput, encoder: AdapterEncoder): Promise<void> {
  const host = resolveHostContext(input);
  setTranscriptPath(input.transcript_path);
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
  const state = await stateManager.load();

  const planMode =
    input.permission_mode !== undefined
      ? isPlanModeFromInput(input)
      : isPlanModeActive(input.transcript_path);

  const tx = await readTranscriptExact(input.transcript_path, FIRST_RESPONSE_STOP_COUNTS);
  const assistantText = input.last_assistant_message ??
    (tx.assistant.length > 0 ? getMostRecentMessage(tx.assistant).content : null);
  const spec = activeSpec();
  if (spec.isPlanExit({ event: "Stop", assistantText })) {
    const validation = await validateCurrentPlanExit({
      transcriptPath: input.transcript_path,
      sessionDir,
      projectDir: host.projectDir,
      hookName: "Stop",
      assistantText,
    });
    const epoch = loadCurrentEpoch(sessionDir);
    if (!validation.approved) {
      const reason = `Plan validation failed: ${validation.reason}`;
      await writeTool(input.transcript_path, input.session_id, "plan-validate", reason);
      const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
      appendCapture(sessionDir, {
        ts: Date.now(),
        epoch_id: epoch?.id ?? "unknown",
        parent_capture_seq: null,
        event: "Stop",
        decision: "block",
        permission_mode: input.permission_mode ?? null,
        injection_seqs: [],
        injection_hashes: [],
        state_snapshot_seq: snapshotSeq,
      });
      const out = encoder.encodeStopBlock(reason);
      await exitAfterFlush(out.exitCode, out.stdout);
      return;
    }
    if (validation.source?.kind === "inline") {
      writeCurrentPlanSidecar(sessionDir, validation.source);
    }
  }

  if (tx.user.length === 0 || tx.assistant.length === 0) {
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "Stop",
      decision: "pass",
      permission_mode: input.permission_mode ?? null,
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
    const out = encoder.encodeStopPass();
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const ctx: RuleContext = {
    hookEvent: "Stop",
    toolName: "",
    projectDir: host.projectDir,
    host,
    transcriptPath: input.transcript_path,
    sessionDir,
    sessionId: input.session_id,
    state,
    stateManager,
    planMode,
    planModeCtx: getPlanModeContext(planMode),
    subagent: isSubagent(input.transcript_path),
    assistantText: assistantText ?? getMostRecentMessage(tx.assistant).content,
    userText: getMostRecentMessage(tx.user).content,
  };

  const result = await evaluateRulesForStop(ALL_RULES, ctx);

  const epoch = loadCurrentEpoch(sessionDir);

  if (result.decision === "block" && result.systemMessage) {
    await writeTool(input.transcript_path, input.session_id, "response-align-stop", result.systemMessage);
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "Stop",
      decision: "block",
      permission_mode: input.permission_mode ?? null,
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
    const out = encoder.encodeStopBlock(result.systemMessage);
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
  appendCapture(sessionDir, {
    ts: Date.now(),
    epoch_id: epoch?.id ?? "unknown",
    parent_capture_seq: null,
    event: "Stop",
    decision: "pass",
    permission_mode: input.permission_mode ?? null,
    injection_seqs: [],
    injection_hashes: [],
    state_snapshot_seq: snapshotSeq,
  });
  const out = encoder.encodeStopPass();
  await exitAfterFlush(out.exitCode, out.stdout);
}
