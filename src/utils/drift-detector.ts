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
 * Level 0 (normal): 4+ allowed edits to the same file → block with `Warning:`.
 * Level 1 (post-Warning): 3 free edits, then block with `Final Warning:`.
 * Level 2 (post-Final-Warning): 1 free edit, then block with `Error:`.
 * Level 3 (errored): every subsequent edit is blocked with `Error:`.
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

  if (state.level === 3) {
    return {
      detected: true,
      reason: `Error: ${count} edits to "${target}" detected - possible loop or thrashing`,
    };
  }

  if (state.level === 2) {
    if (state.allowedSinceLevelChange >= 1) {
      return {
        detected: true,
        reason: `Error: ${count} edits to "${target}" detected - possible loop or thrashing`,
      };
    }
    return NO_DRIFT;
  }

  if (state.level === 1) {
    if (state.allowedSinceLevelChange >= 3) {
      return {
        detected: true,
        reason: `Final Warning: ${count} edits to "${target}" detected - possible loop or thrashing`,
      };
    }
    return NO_DRIFT;
  }

  if (count >= 4) {
    return {
      detected: true,
      reason: `Warning: ${count} edits to "${target}" detected - possible loop or thrashing`,
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
