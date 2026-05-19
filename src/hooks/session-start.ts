import * as fs from "fs";
import * as path from "path";
import { exitAfterFlush } from "../utils/hook-bootstrap.js";
import {
  getSessionState,
  sessionStateDefaults,
} from "../utils/session-store.js";
import { getAgentFrameworkSessionDir } from "../utils/paths.js";
import type { AdapterEncoder } from "../adapter/types.js";
import {
  commitPlanModeTransition,
  computePlanModeTransition,
  type PlanModeTransition,
} from "../utils/plan-mode-entry-state.js";
import { combineInjectionMessages, type SessionInjectionRecord } from "../utils/session-injections.js";
import { appendCapture } from "../scenario/capture.js";
import { appendStateSnapshot } from "../scenario/snapshot.js";
import { rotateEpoch, loadCurrentEpoch } from "../scenario/epoch.js";
import { onEpochRotation } from "../scenario/lifecycle.js";
import { activeSpec } from "../adapter/spec.js";

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
  collaboration_mode?: string;
}

async function computeSessionStartPlanMode(
  input: SessionStartHookInput,
  sessionDir: string,
): Promise<{ transition: PlanModeTransition; records: SessionInjectionRecord[] }> {
  const spec = activeSpec();
  const detection = spec.detectPlanMode({
    permissionMode: input.permission_mode,
    collaborationMode: input.collaboration_mode,
    transcriptPath: input.transcript_path,
  });
  const transition = await computePlanModeTransition({
    source: "SessionStart",
    sessionDir,
    detection,
  });
  await commitPlanModeTransition(sessionDir, transition);
  return { transition, records: [] };
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

  const sessionDir = getAgentFrameworkSessionDir({ transcriptPath: transcript_path });
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
        mode: transition.mode,
        source: transition.detection_source,
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
        mode: transition.mode,
        source: transition.detection_source,
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
      mode: transition.mode,
      source: transition.detection_source,
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
