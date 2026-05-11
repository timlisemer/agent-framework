import * as fs from "fs";
import * as path from "path";
import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import {
  getSessionDir,
  getSessionState,
  resetActiveSubagents,
  sessionStateDefaults,
} from "../utils/session-store.js";
import type { AdapterEncoder } from "../adapter/types.js";
import { resolveHostContext } from "../utils/host-context.js";
import { detectPlanModeEntryAndBuildInjection } from "../utils/plan-mode-entry-state.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { rotateEpoch, loadCurrentEpoch } from "../scenario/epoch.js";
import { onEpochRotation } from "../scenario/lifecycle.js";

/**
 * SessionStart Hook
 *
 * Manages session lifecycle:
 * - "startup": init session-dir + state.json
 * - "resume": no-op
 * - "compact": rotate epoch + reset derived caches
 * - "clear": delete session-dir
 */

export interface SessionStartHookInput {
  source: "startup" | "resume" | "compact" | "clear";
  session_id: string;
  transcript_path: string;
  cwd?: string;
  permission_mode?: string;
}

async function maybeInjectPlansOnPlanModeEntry(
  input: SessionStartHookInput,
  encoder: AdapterEncoder,
  sessionDir: string,
): Promise<boolean> {
  const host = resolveHostContext({ cwd: input.cwd });
  const injection = await detectPlanModeEntryAndBuildInjection({
    source: "SessionStart",
    sessionDir,
    transcriptPath: input.transcript_path,
    projectDir: host.projectDir,
    permissionMode: input.permission_mode,
  });

  if (injection.message && encoder.encodeContext) {
    const out = encoder.encodeContext("SessionStart", injection.message);
    await exitAfterFlush(out.exitCode, out.stdout);
    return true;
  }

  return false;
}

export async function mainSessionStart(input: SessionStartHookInput, encoder: AdapterEncoder): Promise<void> {
  const { source, transcript_path } = input;

  // Reset subagent counter on startup -- leaked counters from crashed
  // subagents must not poison the new session
  if (source === "startup") {
    try {
      const earlySessionDir = getSessionDir(transcript_path);
      resetActiveSubagents(earlySessionDir);
    } catch {}
  }

  if (isSubagent(transcript_path)) {
    const out = encoder.encodeOk("SessionStart");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  const sessionDir = getSessionDir(transcript_path);
  const statePath = path.join(sessionDir, "state.json");

  if (source === "startup") {
    await fs.promises.mkdir(sessionDir, { recursive: true });
    if (!fs.existsSync(statePath)) {
      await getSessionState(sessionDir).save(sessionStateDefaults());
    }
    const state = await getSessionState(sessionDir).load().catch(() => sessionStateDefaults());
    const snapshotSeq = appendStateSnapshot(sessionDir, state, transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "SessionStart",
      decision: "ok",
      state_snapshot_seq: snapshotSeq,
    });
    if (await maybeInjectPlansOnPlanModeEntry(input, encoder, sessionDir)) return;
    const out = encoder.encodeOk("SessionStart");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  if (source === "clear") {
    // Delete session dir entirely — no epoch rotation (dir is being deleted).
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    const out = encoder.encodeOk("SessionStart");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  if (source === "compact") {
    // Compact: rotate epoch and reset derived caches.
    const newEpoch = rotateEpoch(sessionDir, "compact", null);
    await onEpochRotation(sessionDir, newEpoch);
    const state = await getSessionState(sessionDir).load().catch(() => sessionStateDefaults());
    const snapshotSeq = appendStateSnapshot(sessionDir, state, transcript_path);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: newEpoch.id,
      parent_capture_seq: null,
      event: "SessionStart",
      decision: "ok",
      state_snapshot_seq: snapshotSeq,
    });
    if (await maybeInjectPlansOnPlanModeEntry(input, encoder, sessionDir)) return;
    const out = encoder.encodeOk("SessionStart");
    await exitAfterFlush(out.exitCode, out.stdout);
    return;
  }

  // resume: no-op. The host agent's native compaction handles transcript continuity.
  const state = await getSessionState(sessionDir).load().catch(() => sessionStateDefaults());
  const snapshotSeq = appendStateSnapshot(sessionDir, state, transcript_path);
  const epoch = loadCurrentEpoch(sessionDir);
  appendCapture(sessionDir, {
    ts: Date.now(),
    epoch_id: epoch?.id ?? "unknown",
    parent_capture_seq: null,
    event: "SessionStart",
    decision: "ok",
    state_snapshot_seq: snapshotSeq,
  });
  if (await maybeInjectPlansOnPlanModeEntry(input, encoder, sessionDir)) return;
  const out = encoder.encodeOk("SessionStart");
  await exitAfterFlush(out.exitCode, out.stdout);
}
