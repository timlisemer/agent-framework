import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { appendToolLog, getSessionState } from "../utils/session-store.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { appendCapture, capturePlanModeFromDetection } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { loadCurrentEpoch } from "../scenario/epoch.js";
import { activeSpec } from "../adapter/spec.js";
import { detectPlanModeForHook } from "../utils/plan-mode-detector.js";
import { requireAdapterToolContinuation } from "../utils/tool-continuation-state.js";
import type { FrameworkPostToolUseFailureHookInput } from "./types.js";

/**
 * PostToolUseFailure Hook
 *
 * Logs tool failures to the session JSONL tool log.
 */

export async function mainPostToolUseFailure(input: FrameworkPostToolUseFailureHookInput, encoder: AdapterEncoder): Promise<void> {
  // Skip interrupts
  if (input.is_interrupt) {
    const out = encoder.encodeOk("PostToolUseFailure");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const sessionDir = getAgentFrameworkSessionDir({ transcriptPath: input.transcript_path });
  const spec = activeSpec();
  const canonical = spec.canonicalizeToolCall(input.tool_name, input.tool_input);
  const planModeDetection = await detectPlanModeForHook({
    spec,
    permissionMode: input.permission_mode,
    collaborationMode: input.collaboration_mode,
    transcriptPath: input.transcript_path,
    sessionDir,
  });
  await appendToolLog(sessionDir, {
    ts: Date.now(),
    tool: canonical.toolName,
    toolUseId: input.tool_use_id,
    status: "failed",
    gate: "system",
    reason: input.error?.slice(0, 200),
    ms: 0,
  });

  await requireAdapterToolContinuation(
    sessionDir,
    spec.continuationAfterToolFailure(
      canonical,
      input.error,
      input.is_interrupt,
    ),
    {
      intent: "Retry the failed adapter continuation before workflow progress.",
      userMessage: "The adapter continuation failed and must be retried.",
    },
  );

  const state = await getSessionState(sessionDir).load().catch(() => null);
  if (state) {
    const snapshotSeq = appendStateSnapshot(sessionDir, state, input.transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "PostToolUseFailure",
      tool_use_id: input.tool_use_id,
      decision: "error",
      permission_mode: input.permission_mode ?? null,
      plan_mode: capturePlanModeFromDetection(planModeDetection),
      injection_seqs: [],
      injection_hashes: [],
      state_snapshot_seq: snapshotSeq,
    });
  }

  const out = encoder.encodeOk("PostToolUseFailure");
  await exitAfterFlush(out.exitCode, out.stdout);
}
