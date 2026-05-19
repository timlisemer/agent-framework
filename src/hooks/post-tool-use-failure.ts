import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { appendToolLog, getSessionState } from "../utils/session-store.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";
import { activeSpec } from "../adapter/spec.js";
import { detectPlanModeForHook } from "../utils/plan-mode-detector.js";

/**
 * PostToolUseFailure Hook
 *
 * Logs tool failures to the session JSONL tool log.
 */

export interface PostToolUseFailureHookInput {
  tool_name: string;
  error: string;
  is_interrupt: boolean;
  transcript_path: string;
  permission_mode?: string;
  collaboration_mode?: string;
}

export async function mainPostToolUseFailure(input: PostToolUseFailureHookInput, encoder: AdapterEncoder): Promise<void> {
  // Skip interrupts
  if (input.is_interrupt) {
    const out = encoder.encodeOk("PostToolUseFailure");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const sessionDir = getAgentFrameworkSessionDir({ transcriptPath: input.transcript_path });
  const spec = activeSpec();
  const planModeDetection = await detectPlanModeForHook({
    spec,
    permissionMode: input.permission_mode,
    collaborationMode: input.collaboration_mode,
    transcriptPath: input.transcript_path,
    sessionDir,
  });
  await appendToolLog(sessionDir, {
    ts: Date.now(),
    tool: input.tool_name,
    status: "failed",
    gate: "system",
    reason: input.error?.slice(0, 200),
    ms: 0,
  });

  const state = await getSessionState(sessionDir).load().catch(() => null);
  if (state) {
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "PostToolUseFailure",
      decision: "error",
      permission_mode: input.permission_mode ?? null,
      plan_mode: {
        active: planModeDetection.active,
        mode: planModeDetection.mode,
        source: planModeDetection.source,
      },
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
  }

  const out = encoder.encodeOk("PostToolUseFailure");
  await exitAfterFlush(out.exitCode, out.stdout);
}
