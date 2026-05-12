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
import {
  commitPlanModeTransition,
  computePlanModeTransition,
  type PlanModeTransition,
} from "../utils/plan-mode-entry-state.js";
import { buildPendingContextInjections } from "../utils/context-injection-providers.js";
import { appendSessionInjections, combineInjectionMessages, type SessionInjectionRecord } from "../utils/session-injections.js";
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

async function computeSessionStartPlanMode(
  input: SessionStartHookInput,
  sessionDir: string,
): Promise<{ transition: PlanModeTransition; records: SessionInjectionRecord[] }> {
  const host = resolveHostContext({ cwd: input.cwd });
  const transition = await computePlanModeTransition({
    source: "SessionStart",
    sessionDir,
    transcriptPath: input.transcript_path,
    permissionMode: input.permission_mode,
  });
  await commitPlanModeTransition(sessionDir, transition);
  const pending = await buildPendingContextInjections({
    projectDir: host.projectDir,
    sourceEvent: "SessionStart",
    planModeTransition: transition,
  });
  const records = appendSessionInjections(sessionDir, "SessionStart", pending);
  return { transition, records };
}

async function exitSessionStart(
  encoder: AdapterEncoder,
  records: SessionInjectionRecord[],
): Promise<void> {
  const out = records.length > 0
    ? encoder.encodeContext("SessionStart", combineInjectionMessages(records))
    : encoder.encodeOk("SessionStart");
  await exitAfterFlush(out.exitCode, out.stdout);
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
    const { transition, records } = await computeSessionStartPlanMode(input, sessionDir);
    const state = await getSessionState(sessionDir).load().catch(() => sessionStateDefaults());
    const snapshotSeq = appendStateSnapshot(sessionDir, state, transcript_path);
    const epoch = loadCurrentEpoch(sessionDir);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: epoch?.id ?? "unknown",
      parent_capture_seq: null,
      event: "SessionStart",
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
      injection_seqs: records.map((record) => record.seq),
      injection_hashes: records.map((record) => record.message_hash),
      state_snapshot_seq: snapshotSeq,
    });
    await exitSessionStart(encoder, records);
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
    const { transition, records } = await computeSessionStartPlanMode(input, sessionDir);
    const state = await getSessionState(sessionDir).load().catch(() => sessionStateDefaults());
    const snapshotSeq = appendStateSnapshot(sessionDir, state, transcript_path);
    appendCapture(sessionDir, {
      ts: Date.now(),
      epoch_id: newEpoch.id,
      parent_capture_seq: null,
      event: "SessionStart",
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
      injection_seqs: records.map((record) => record.seq),
      injection_hashes: records.map((record) => record.message_hash),
      state_snapshot_seq: snapshotSeq,
    });
    await exitSessionStart(encoder, records);
    return;
  }

  // resume: no-op. The host agent's native compaction handles transcript continuity.
  const { transition, records } = await computeSessionStartPlanMode(input, sessionDir);
  const state = await getSessionState(sessionDir).load().catch(() => sessionStateDefaults());
  const snapshotSeq = appendStateSnapshot(sessionDir, state, transcript_path);
  const epoch = loadCurrentEpoch(sessionDir);
  appendCapture(sessionDir, {
    ts: Date.now(),
    epoch_id: epoch?.id ?? "unknown",
    parent_capture_seq: null,
    event: "SessionStart",
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
    injection_seqs: records.map((record) => record.seq),
    injection_hashes: records.map((record) => record.message_hash),
    state_snapshot_seq: snapshotSeq,
  });
  await exitSessionStart(encoder, records);
}
