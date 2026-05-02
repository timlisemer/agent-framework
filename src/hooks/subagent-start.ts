import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir, incrementActiveSubagents, getSessionState } from "../utils/session-store.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";

/**
 * SubagentStart Hook
 *
 * Increments the active subagent counter.
 */

export interface SubagentStartHookInput {
  agent_id: string;
  agent_type: string;
  transcript_path: string;
  session_id: string;
}

export async function mainSubagentStart(input: SubagentStartHookInput, encoder: AdapterEncoder): Promise<void> {
  const sessionDir = getSessionDir(input.transcript_path);
  incrementActiveSubagents(sessionDir, input.agent_id);

  const state = await getSessionState(sessionDir).load().catch(() => null);
  if (state) {
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "SubagentStart",
      decision: "ok",
      state_snapshot_seq: snapshotSeq,
    });
  }

  const out = encoder.encodeOk("SubagentStart");
  await exitAfterFlush(out.exitCode, out.stdout);
}
