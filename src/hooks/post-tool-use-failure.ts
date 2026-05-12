import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, appendToolLog, getSessionState } from "../utils/session-store.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";

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
}

export async function mainPostToolUseFailure(input: PostToolUseFailureHookInput, encoder: AdapterEncoder): Promise<void> {
  // Skip subagents and interrupts
  if (isSubagent(input.transcript_path) || input.is_interrupt) {
    const out = encoder.encodeOk("PostToolUseFailure");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const sessionDir = getSessionDir(input.transcript_path);
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
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
  }

  const out = encoder.encodeOk("PostToolUseFailure");
  await exitAfterFlush(out.exitCode, out.stdout);
}
