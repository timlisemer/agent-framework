/**
 * Lifecycle — epoch-rotation side-effects.
 *
 * When a new epoch starts (rewind or compact), the five derived caches that
 * accumulated state across the old epoch must be reset so the new epoch
 * begins from defaults. The forensic JSONL logs (captures, state-snapshots,
 * epochs, tool-log) are intentionally NOT touched — they are immutable audit
 * trails.
 *
 * @module scenario/lifecycle
 */

import * as fs from "fs";
import {
  sessionGateReasoningFile,
  sessionDenialCacheFile,
  sessionStatuslineFile,
} from "../utils/paths.js";
import { getSessionState, sessionStateDefaults, resetActiveSubagents } from "../utils/session-store.js";
import type { Epoch } from "./epoch.js";

/**
 * Reset the five derived caches after an epoch rotation.
 *
 * Resets:
 *   - state.json  → sessionStateDefaults()
 *   - gate-reasoning.json → unlinked
 *   - hook-denials.json   → unlinked
 *   - statusline.json     → unlinked
 *   - active-subagents.json → resetActiveSubagents()
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
    sessionDenialCacheFile(sessionDir),
    sessionStatuslineFile(sessionDir),
  ];
  for (const filePath of toUnlink) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Expected when the file doesn't exist yet.
    }
  }

  // Reset active subagent counter.
  try {
    resetActiveSubagents(sessionDir);
  } catch {
    // Best-effort.
  }
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
    sessionDenialCacheFile(sessionDir),
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
      forceCheckPending: false,
      previousEditIntent: s.currentEditIntent ?? null,
      currentEditIntent: null,
      editIntentTimestamp: Date.now(),
      editIntentOverturnCount: 0,
      respondFirstChecked: false,
      driftState: {},
      lastProcessedPlanApprovalToolUseId: null,
      lastUserMessageTimestamp: Date.now(),
    }));
  } catch {
    // Best-effort.
  }
}
