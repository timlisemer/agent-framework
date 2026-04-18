/**
 * Drift Detector - Pure TypeScript heuristics for anomaly detection.
 *
 * All checks are synchronous (<5ms) using the recent tool log.
 * No LLM calls.
 *
 * @module drift-detector
 */

import type { ToolLogEntry } from "./session-store.js";

export interface DriftSignal {
  detected: boolean;
  reason: string;
}

const NO_DRIFT: DriftSignal = { detected: false, reason: "" };

/**
 * Detect drift between the current tool call and recent tool history.
 * Uses pure string/regex operations for speed.
 */
export function detectDrift(
  toolName: string,
  toolInput: unknown,
  recentToolLog: ToolLogEntry[],
): DriftSignal {
  const input = toolInput as Record<string, unknown>;
  const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
  const command = (input?.command as string) ?? "";
  const target = filePath || command;

  // Repetition detection: 4+ edits to same file in recent log
  const repetitionSignal = checkRepetition(toolName, target, recentToolLog);
  if (repetitionSignal.detected) return repetitionSignal;

  // Workaround escalation: 2+ recent denials to similar target
  const workaroundSignal = checkWorkaroundEscalation(target, recentToolLog);
  if (workaroundSignal.detected) return workaroundSignal;

  return NO_DRIFT;
}

/**
 * Detect 4+ edits to the same file in recent tool log.
 */
function checkRepetition(toolName: string, target: string, recentToolLog: ToolLogEntry[]): DriftSignal {
  if (!target || !["Edit", "Write", "NotebookEdit"].includes(toolName)) return NO_DRIFT;

  const sameTargetEdits = recentToolLog.filter(
    (e) => e.path === target && ["Edit", "Write", "NotebookEdit"].includes(e.tool)
  );

  if (sameTargetEdits.length >= 4) {
    return {
      detected: true,
      reason: `${sameTargetEdits.length} edits to "${target}" detected - possible loop or thrashing`,
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
