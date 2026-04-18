import * as fs from "fs";

export interface PlanModeContext {
  active: boolean;
  contextString: string;  // empty string when inactive (safe to concatenate)
}

const PLAN_MODE_CONTEXT_STRING = `\n=== PLAN MODE ACTIVE ===\nThe session is in PLAN MODE (read-only exploration and planning). File modifications (Edit, Write, NotebookEdit) and write Bash commands are blocked by TypeScript. The user's intent is planning and exploration, NOT implementation. ExitPlanMode is the expected way to finish planning.\n=== END PLAN MODE ===\n`;

export function getPlanModeContext(active: boolean): PlanModeContext {
  if (!active) return { active: false, contextString: "" };
  return { active: true, contextString: PLAN_MODE_CONTEXT_STRING };
}

export function formatPlanModeContext(active: boolean): string {
  return getPlanModeContext(active).contextString;
}

/**
 * Primary plan-mode detection: read directly from the hook stdin payload.
 * Every hook input extends BaseHookInput which carries `permission_mode`.
 * `"plan"` is the only value that indicates native plan mode (shift+tab).
 */
export function isPlanModeFromInput(input: { permission_mode?: string }): boolean {
  return input.permission_mode === "plan";
}

/**
 * Fallback plan-mode detection for code paths that only have a transcript
 * path (e.g. synthetic tool writes). Scans the tail of the transcript for
 * the most recent `permission-mode` marker.
 *
 * Transcripts contain two authoritative markers for plan mode:
 *   1. Dedicated events:   {"type":"permission-mode","permissionMode":"plan"|"default"|...}
 *   2. Per-message fields: {..., "permissionMode":"plan", ...}
 *
 * We take whichever marker has the most recent position in the tail.
 */
export function isPlanModeActive(transcriptPath: string): boolean {
  let fd: number | undefined;
  try {
    const stats = fs.statSync(transcriptPath);
    const readSize = Math.min(stats.size, 50 * 1024);

    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);
    fd = undefined;

    const content = buffer.toString("utf-8");

    // Find the most recent permissionMode occurrence (from either marker form).
    // Both forms store the value as `"permissionMode":"<value>"`, so a single
    // regex with `lastIndexOf` semantics is enough.
    const pattern = /"permissionMode"\s*:\s*"([^"]+)"/g;
    let lastValue: string | null = null;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      lastValue = match[1];
    }

    return lastValue === "plan";
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
    return false;
  }
}
