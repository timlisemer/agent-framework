import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir, decrementActiveSubagents, getSessionState } from "../utils/session-store.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";

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
}

export async function mainSubagentStop(input: SubagentStopHookInput, encoder: AdapterEncoder): Promise<void> {
  const sessionDir = getSessionDir(input.transcript_path);
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
      state_snapshot_seq: snapshotSeq,
    });
  }

  const out = encoder.encodeOk("SubagentStop");
  await exitAfterFlush(out.exitCode, out.stdout);
}
