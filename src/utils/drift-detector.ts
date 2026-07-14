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
import { isEditToolName, TEXT_EDIT_TOOL_NAMES_DISPLAY } from "./edit-tools.js";
import { fileWritePolicyFingerprintCategories } from "./bash-policy/registry.js";

export interface DriftSignal {
  detected: boolean;
  reason: string;
}

const NO_DRIFT: DriftSignal = { detected: false, reason: "" };

const MULTI_REGION_EDIT_INTENT_RE =
  /\b(non[-\s]?adjacent|discontiguous|multi[-\s]?region|multiple\s+(?:separate\s+)?regions|across\s+(?:non[-\s]?adjacent|separate|multiple)\s+regions)\b/i;

export interface DriftDetectionOptions {
  allowMultiRegionEditRepetition?: boolean;
  driftReductionCredits?: Record<string, number>;
}

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
 * `driftState` holds the per-target escalation level (Warning → Final Warning)
 * maintained by the drift-detect rule; when omitted, all targets are
 * treated as level 0.
 */
export function detectDrift(
  toolName: string,
  toolInput: unknown,
  recentToolLog: ToolLogEntry[],
  driftState?: Record<string, DriftTargetState>,
  options: DriftDetectionOptions = {},
): DriftSignal {
  const targets = extractDriftTargets(toolInput);
  for (const target of targets) {
    const state = driftState?.[target] ?? { level: 0 as const };
    const repetitionSignal = checkRepetition(
      toolName,
      target,
      recentToolLog,
      state,
      options.allowMultiRegionEditRepetition ?? false,
      options.driftReductionCredits?.[target] ?? 0,
    );
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
 * Graduated loop detection.
 *
 * Level 0 (normal): 5+ effective allowed edits to the same file → consolidation nudge.
 * Level 1/2 (post-nudge): 10+ effective allowed edits → final warning.
 *
 * Both messages tell the AI to KEEP editing the file but consolidate the
 * remaining changes into one text edit call. They share the substring
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
  allowMultiRegionEditRepetition: boolean,
  reductionCredit: number,
): DriftSignal {
  if (!target || !isEditToolName(toolName)) return NO_DRIFT;
  if (allowMultiRegionEditRepetition) return NO_DRIFT;

  const rawCount = allowedEditCountForTarget(recentToolLog, target);
  const count = Math.max(0, rawCount - reductionCredit);

  if (state.level > 0) {
    if (count >= 10) {
      return {
        detected: true,
        reason: `${count} edits to "${target}" - final warning. Do NOT make another partial edit. Read the file, list every remaining change, then apply them all in a single ${TEXT_EDIT_TOOL_NAMES_DISPLAY} call.`,
      };
    }
    return NO_DRIFT;
  }

  if (count >= 5) {
    return {
      detected: true,
      reason: `${count} edits to "${target}" - stop making many small edits. Read the full file, plan all remaining changes, and apply them in ONE ${TEXT_EDIT_TOOL_NAMES_DISPLAY} call. You may continue editing this file; just consolidate.`,
    };
  }

  return NO_DRIFT;
}

export function describesMultiRegionEditIntent(text: string): boolean {
  return MULTI_REGION_EDIT_INTENT_RE.test(text);
}

export function toolLogEntryTargets(entry: ToolLogEntry): string[] {
  if (entry.paths?.length) return entry.paths;
  return entry.path ? [entry.path] : [];
}

export function allowedEditTargetCounts(recentToolLog: ToolLogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of recentToolLog) {
    if (entry.status !== "allowed" || !isEditToolName(entry.tool)) continue;
    for (const target of toolLogEntryTargets(entry)) {
      counts[target] = (counts[target] ?? 0) + 1;
    }
  }
  return counts;
}

export function allowedEditCountForTarget(recentToolLog: ToolLogEntry[], target: string): number {
  return allowedEditTargetCounts(recentToolLog)[target] ?? 0;
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

  for (const fingerprint of fileWritePolicyFingerprintCategories(command, reason)) {
    fingerprints.add(fingerprint);
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
