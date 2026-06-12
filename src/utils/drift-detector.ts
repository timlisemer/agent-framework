/**
 * Drift Detector - Pure TypeScript heuristics for anomaly detection.
 *
 * All checks are synchronous (<5ms) using the recent tool log.
 * No LLM calls.
 *
 * @module drift-detector
 */

import type { DriftTargetState, ToolLogEntry } from "./session-store.js";
import { findDestructiveFlagsFromCommand } from "./find-command-policy.js";

export interface DriftSignal {
  detected: boolean;
  reason: string;
}

const NO_DRIFT: DriftSignal = { detected: false, reason: "" };

const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

/**
 * Extract target paths/command for drift detection.
 */
export function extractDriftTargets(toolInput: unknown): string[] {
  const input = toolInput as Record<string, unknown>;
  if (Array.isArray(input?.file_paths)) {
    const paths = input.file_paths.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length > 0) return paths;
  }
  const single = extractDriftTarget(toolInput);
  return single ? [single] : [];
}

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
  const targets = extractDriftTargets(toolInput);
  for (const target of targets) {
    const state = driftState?.[target] ?? { level: 0, allowedSinceLevelChange: 0 };
    const repetitionSignal = checkRepetition(toolName, target, recentToolLog, state);
    if (repetitionSignal.detected) return repetitionSignal;
  }

  // Workaround escalation: 2+ recent denials to the same denied Bash pattern.
  for (const target of targets) {
    const workaroundSignal = checkWorkaroundEscalation(toolName, target, recentToolLog);
    if (workaroundSignal.detected) return workaroundSignal;
  }

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
      toolLogEntryTargets(e).includes(target) &&
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

function toolLogEntryTargets(entry: ToolLogEntry): string[] {
  if (entry.paths?.length) return entry.paths;
  return entry.path ? [entry.path] : [];
}

/**
 * Detect 2+ recent denials to the same denied Bash pattern.
 */
function checkWorkaroundEscalation(toolName: string, target: string, recentToolLog: ToolLogEntry[]): DriftSignal {
  if (toolName !== "Bash" || !target) return NO_DRIFT;

  const currentFingerprints = collectBashDenialFingerprints(target, "");
  if (currentFingerprints.size === 0) return NO_DRIFT;

  for (const fingerprint of currentFingerprints) {
    const recentDenials = recentToolLog.filter((e) => {
      if (e.status !== "denied" || e.tool !== "Bash") return false;
      const deniedFingerprints = collectBashDenialFingerprints(e.cmd ?? "", e.reason ?? "");
      return deniedFingerprints.has(fingerprint);
    });
    if (recentDenials.length >= 2) {
      return {
        detected: true,
        reason: `${recentDenials.length} recent denials targeting "${fingerprint}" - possible workaround escalation`,
      };
    }
  }

  return NO_DRIFT;
}

function collectBashDenialFingerprints(command: string, reason: string): Set<string> {
  const fingerprints = new Set<string>();
  const findFlags = findDestructiveFlags(command);
  for (const flag of findFlags) {
    fingerprints.add(`find:${flag}`);
  }
  if (findFlags.length > 0) {
    fingerprints.add("find:destructive");
  }

  if (
    fingerprints.size === 0 &&
    /find destructive flag/i.test(reason)
  ) {
    fingerprints.add("find:destructive");
  }

  if (isFilteredCheckCommand(command) || /filter restricting check output/i.test(reason)) {
    fingerprints.add("check-output-filter");
  }

  return fingerprints;
}

function findDestructiveFlags(command: string): string[] {
  return findDestructiveFlagsFromCommand(command);
}

function isFilteredCheckCommand(command: string): boolean {
  const runsCheckLikeCommand = /\b(npx\s+tsc|tsc|vitest|jest|npm\s+test|just\s+check|make\s+check|cargo\s+(check|clippy)|go\s+test|go\s+vet|ruff\s+check|pylint|eslint)\b/.test(command);
  if (!runsCheckLikeCommand) return false;

  return /\|\s*grep\b|\bgit\s+diff\s+--name-only\b/.test(command);
}
