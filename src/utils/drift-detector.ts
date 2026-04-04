/**
 * Drift Detector - Pure TypeScript heuristics for anomaly detection.
 *
 * All checks are synchronous (<5ms) using pre-computed data from
 * summary cache and tool log. No LLM calls.
 *
 * @module drift-detector
 */

import type { ToolLogEntry } from "./summary-cache.js";

export interface DriftSignal {
  detected: boolean;
  reason: string;
  severity: "warn" | "block";
}

const NO_DRIFT: DriftSignal = { detected: false, reason: "", severity: "warn" };

/**
 * Detect drift between the current tool call and the user's stated intent.
 * Uses pure string/regex operations for speed.
 */
export function detectDrift(
  toolName: string,
  toolInput: unknown,
  userIntent: string,
  misalignments: string,
  recentToolLog: ToolLogEntry[],
): DriftSignal {
  const input = toolInput as Record<string, unknown>;
  const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
  const command = (input?.command as string) ?? "";
  const target = filePath || command;

  // Scope divergence: extract file/dir mentions from userIntent, check if tool targets outside
  const scopeSignal = checkScopeDivergence(target, userIntent);
  if (scopeSignal.detected) return scopeSignal;

  // Repetition detection: 4+ edits to same file in recent log
  const repetitionSignal = checkRepetition(toolName, target, recentToolLog);
  if (repetitionSignal.detected) return repetitionSignal;

  // Workaround escalation: 2+ recent denials to similar target
  const workaroundSignal = checkWorkaroundEscalation(target, recentToolLog);
  if (workaroundSignal.detected) return workaroundSignal;

  // Misalignment echo: if misalignments mention a concern and current tool touches that area
  const echoSignal = checkMisalignmentEcho(toolName, target, misalignments);
  if (echoSignal.detected) return echoSignal;

  return NO_DRIFT;
}

/**
 * Check if the tool target is outside the scope mentioned in user intent.
 */
function checkScopeDivergence(target: string, userIntent: string): DriftSignal {
  if (!target || !userIntent) return NO_DRIFT;

  // Extract file/directory patterns from intent
  const pathMatches = userIntent.match(/[\w./\\-]+\.\w{1,6}|[\w./\\-]+\//g);
  if (!pathMatches || pathMatches.length === 0) return NO_DRIFT;

  // Check if the target relates to any mentioned path
  const targetNorm = target.toLowerCase();
  const inScope = pathMatches.some((p) => {
    const norm = p.toLowerCase();
    return targetNorm.includes(norm) || norm.includes(targetNorm.split("/").pop() ?? "");
  });

  if (!inScope) {
    return {
      detected: true,
      reason: `Target "${target}" is outside the scope mentioned in user intent (${pathMatches.join(", ")})`,
      severity: "warn",
    };
  }

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
      severity: "block",
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
      severity: "block",
    };
  }

  return NO_DRIFT;
}

/**
 * Check if current tool touches an area flagged in misalignments.
 */
function checkMisalignmentEcho(toolName: string, target: string, misalignments: string): DriftSignal {
  if (!misalignments || misalignments.includes("No misalignments")) return NO_DRIFT;
  if (!target) return NO_DRIFT;

  const targetBase = target.split("/").pop() ?? target;
  if (misalignments.toLowerCase().includes(targetBase.toLowerCase())) {
    return {
      detected: true,
      reason: `Tool "${toolName}" targets "${target}" which is flagged in misalignments`,
      severity: "warn",
    };
  }

  return NO_DRIFT;
}
