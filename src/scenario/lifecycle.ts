/**
 * Lifecycle - epoch-rotation side-effects.
 *
 * When a new epoch starts (rewind or compact), the derived caches that
 * accumulated state across the old epoch must be reset so the new epoch
 * begins from defaults. The forensic JSONL logs (captures, state-snapshots,
 * epochs, tool-log) are intentionally NOT touched - they are immutable audit
 * trails.
 *
 * @module scenario/lifecycle
 */

import * as fs from "fs";
import {
  sessionGateReasoningFile,
  sessionPlanModeStateFile,
  sessionStatuslineFile,
} from "../utils/paths.js";
import { allowedEditTargetCounts } from "../utils/drift-detector.js";
import { getSessionState, readToolLogEntries, sessionStateDefaults } from "../utils/session-store.js";
import { detectEpochChange, rotateEpoch, type Epoch } from "./epoch.js";

/**
 * Reset derived caches after an epoch rotation.
 *
 * Resets:
 *   - state.json  → sessionStateDefaults()
 *   - gate-reasoning.json → unlinked
 *   - statusline.json     → unlinked
 *
 * Does NOT touch: captures.jsonl, state-snapshots.jsonl, epochs.jsonl,
 * tool-log.jsonl (those are forensic logs).
 */
export async function onEpochRotation(sessionDir: string, _epoch: Epoch): Promise<void> {
  // Reset state.json to defaults.
  try {
    const stateManager = getSessionState(sessionDir);
    await stateManager.save(sessionStateDefaults());
  } catch {
    // Best-effort.
  }

  // Unlink derived caches.
  const toUnlink = [
    sessionGateReasoningFile(sessionDir),
    sessionPlanModeStateFile(sessionDir),
    sessionStatuslineFile(sessionDir),
  ];
  for (const filePath of toUnlink) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Expected when the file doesn't exist yet.
    }
  }
}

export async function rotateEpochIfNeeded(
  sessionDir: string,
  transcriptPath: string,
): Promise<void> {
  const epochChange = detectEpochChange(sessionDir, transcriptPath);
  if (!epochChange.rotated) return;
  const newEpoch = rotateEpoch(
    sessionDir,
    epochChange.reason!,
    epochChange.anchorUuid ?? null,
  );
  await onEpochRotation(sessionDir, newEpoch);
}

/**
 * Reset derived decision state at the start of a fresh user turn.
 *
 * This is intentionally narrower than epoch rotation: forensic logs remain
 * intact, and the sentiment rule still owns currentPrediction updates.
 */
export async function onUserPromptTurn(sessionDir: string): Promise<void> {
  const toUnlink = [
    sessionGateReasoningFile(sessionDir),
  ];
  for (const filePath of toUnlink) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Expected when the file doesn't exist yet.
    }
  }

  try {
    const stateManager = getSessionState(sessionDir);
    await stateManager.update((s) => ({
      ...s,
      previousEditIntent: s.currentEditIntent ?? null,
      currentEditIntent: null,
      editIntentTimestamp: Date.now(),
      editIntentOverturnCount: 0,
      respondFirstChecked: false,
      driftState: {},
      driftReductionCredits: {},
      lastProcessedPlanApprovalToolUseId: null,
      lastUserMessageTimestamp: Date.now(),
    }));
  } catch {
    // Best-effort.
  }
}

/**
 * Reset only the edit-drift repetition window.
 *
 * Used by sanctioned validation tools such as check/confirm after they give
 * the agent feedback. This intentionally preserves broader user-turn state and
 * forensic logs while making older edit entries fall outside drift detection.
 */
export async function resetDriftDetectionWindow(sessionDir: string): Promise<void> {
  const stateManager = getSessionState(sessionDir);
  await stateManager.update((s) => ({
    ...s,
    driftState: {},
    driftReductionCredits: {},
    lastUserMessageTimestamp: Date.now(),
  }));
}

/**
 * Reduce the effective edit-drift repetition window without deleting logs.
 *
 * The reduction is stored as per-target credits and capped at the current raw
 * count in the same recent window used by drift-detect.
 */
export async function reduceDriftDetectionWindow(sessionDir: string, reduction: number): Promise<void> {
  const stateManager = getSessionState(sessionDir);
  await stateManager.update((s) => {
    const sinceTs = s.lastUserMessageTimestamp ?? 0;
    const counts = allowedEditTargetCounts(
      readToolLogEntries(sessionDir, 50).filter((entry) => entry.ts >= sinceTs),
    );

    const nextCredits = { ...(s.driftReductionCredits ?? {}) };
    for (const [target, rawCountForTarget] of Object.entries(counts)) {
      const currentCredit = s.driftReductionCredits?.[target] ?? 0;
      nextCredits[target] = Math.min(rawCountForTarget, currentCredit + reduction);
    }

    return {
      ...s,
      driftReductionCredits: nextCredits,
    };
  });
}
