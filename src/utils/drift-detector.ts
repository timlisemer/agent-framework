/**
 * Drift Detector - Pure TypeScript heuristics for anomaly detection.
 *
 * All checks are synchronous (<5ms) using the recent tool log.
 * No LLM calls.
 *
 * @module drift-detector
 */

import type { DriftTargetState, ToolLogEntry } from "./session-store.js";

export interface DriftSignal {
  detected: boolean;
  reason: string;
}

const NO_DRIFT: DriftSignal = { detected: false, reason: "" };

const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

/**
 * Extract the target path/command for drift detection.
 */
export function extractDriftTarget(toolInput: unknown): string {
  const input = toolInput as Record<string, unknown>;
  const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
  const command = (input?.command as string) ?? "";
  return filePath || command;
}

/**
 * Detect drift between the current tool call and recent tool history.
 * Uses pure string/regex operations for speed.
 *
 * `driftState` holds the per-target escalation level (Warning → Final Warning
 * → Error) maintained by the drift-detect rule; when omitted, all targets are
 * treated as level 0.
 */
export function detectDrift(
  toolName: string,
  toolInput: unknown,
  recentToolLog: ToolLogEntry[],
  driftState?: Record<string, DriftTargetState>,
): DriftSignal {
  const target = extractDriftTarget(toolInput);

  const state = driftState?.[target] ?? { level: 0, allowedSinceLevelChange: 0 };
  const repetitionSignal = checkRepetition(toolName, target, recentToolLog, state);
  if (repetitionSignal.detected) return repetitionSignal;

  // Workaround escalation: 2+ recent denials to similar target
  const workaroundSignal = checkWorkaroundEscalation(target, recentToolLog);
  if (workaroundSignal.detected) return workaroundSignal;

  return NO_DRIFT;
}

/**
 * Graduated loop/thrashing detection.
 *
 * Level 0 (normal): 4+ allowed edits to the same file → consolidation nudge.
 * Level 1 (post-nudge): 3 free edits, then a stronger consolidation nudge.
 * Level 2 (post-second-nudge): 1 free edit, then "thrashing" message.
 * Level 3 (clamped): every subsequent edit gets the "thrashing" message.
 *
 * All three messages tell the AI to KEEP editing the file but consolidate the
 * remaining changes into one Edit/Write call. They share the substring
 * `edits to "` so the drift-detect rule can recognize its own emissions in
 * onDenialConfirmed without relying on a Warning/Error prefix that the AI
 * misreads as a hard prohibition.
 *
 * State transitions are applied by the caller (drift-detect rule) based on
 * whether this returns a detected signal and whether appeals overturn it.
 */
function checkRepetition(
  toolName: string,
  target: string,
  recentToolLog: ToolLogEntry[],
  state: DriftTargetState,
): DriftSignal {
  if (!target || !EDIT_TOOLS.includes(toolName)) return NO_DRIFT;

  const sameTargetAllowedEdits = recentToolLog.filter(
    (e) =>
      e.path === target &&
      EDIT_TOOLS.includes(e.tool) &&
      e.status === "allowed",
  );
  const count = sameTargetAllowedEdits.length;

  const thrashingMessage = `${count} edits to "${target}" — you are thrashing. The fix is not to stop editing; it is to consolidate. Read the full current file, plan every remaining change, then apply them in ONE Edit or Write call.`;

  if (state.level === 3) {
    return { detected: true, reason: thrashingMessage };
  }

  if (state.level === 2) {
    if (state.allowedSinceLevelChange >= 1) {
      return { detected: true, reason: thrashingMessage };
    }
    return NO_DRIFT;
  }

  if (state.level === 1) {
    if (state.allowedSinceLevelChange >= 3) {
      return {
        detected: true,
        reason: `${count} edits to "${target}" — last nudge. Do NOT make another partial edit. Read the file, list every remaining change, then apply them all in a single Edit/Write call.`,
      };
    }
    return NO_DRIFT;
  }

  if (count >= 4) {
    return {
      detected: true,
      reason: `${count} edits to "${target}" — stop making many small edits. Read the full file, plan all remaining changes, and apply them in ONE Edit/Write call. You may continue editing this file; just consolidate.`,
    };
  }

  return NO_DRIFT;
}

/**
 * Detect 2+ recent denials to similar target (workaround escalation).
 */
function checkWorkaroundEscalation(target: string, recentToolLog: ToolLogEntry[]): DriftSignal {
  if (!target) return NO_DRIFT;

  const targetBase = target.split("/").pop() ?? target;
  const recentDenials = recentToolLog.filter(
    (e) => e.status === "denied" && (e.path?.includes(targetBase) || e.cmd?.includes(targetBase))
  );

  if (recentDenials.length >= 2) {
    return {
      detected: true,
      reason: `${recentDenials.length} recent denials targeting "${targetBase}" - possible workaround escalation`,
    };
  }

  return NO_DRIFT;
}
