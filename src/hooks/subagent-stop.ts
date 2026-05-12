import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir, decrementActiveSubagents, getSessionState } from "../utils/session-store.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";
import { activeSpec } from "../adapter/spec.js";

/**
 * SubagentStop Hook
 *
 * Decrements the active subagent counter.
 */

export interface SubagentStopHookInput {
  agent_id: string;
  agent_transcript_path: string;
  transcript_path: string;
  session_id: string;
  stop_hook_active: boolean;
  permission_mode?: string;
}

export async function mainSubagentStop(input: SubagentStopHookInput, encoder: AdapterEncoder): Promise<void> {
  const sessionDir = getSessionDir(input.transcript_path);
  const planModeDetection = activeSpec().detectPlanMode({
    permissionMode: input.permission_mode,
    transcriptPath: input.transcript_path,
  });
  try {
    decrementActiveSubagents(sessionDir, input.agent_id);
  } catch (err) {
    console.error("[subagent-stop] decrement failed:", err);
  }

  const state = await getSessionState(sessionDir).load().catch(() => null);
  if (state) {
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "SubagentStop",
      decision: "ok",
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

  const out = encoder.encodeOk("SubagentStop");
  await exitAfterFlush(out.exitCode, out.stdout);
}
