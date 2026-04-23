import * as fs from "fs";

export interface PlanModeContext {
  active: boolean;
  contextString: string;  // empty string when inactive (safe to concatenate)
}

const PLAN_MODE_CONTEXT_STRING = `
=== PLAN MODE ACTIVE ===
The session is in PLAN MODE (read-only exploration and planning). The user's intent is planning and exploration, NOT implementation. ExitPlanMode is the expected way to finish planning.

BLOCKED (handled deterministically by TypeScript upstream — the LLM should never need to deny these itself):
- Edit, Write, NotebookEdit
- Bash commands that write (git commit/push, mkdir, echo >, npm install, build/compile, etc.)

ALLOWED in plan mode (APPROVE by default):
- Read, Grep, Glob, LS
- Read-only Bash (grep, find, ls, git status/log/diff/show)
- WebFetch, WebSearch
- Any MCP read tool
- ExitPlanMode
- Agent / Task subagent dispatch for exploration or research (e.g. subagent_type "Explore", "general-purpose", "Plan", code-reviewer-style agents). APPROVE these by default. Only DENY a subagent dispatch when (a) the dispatch prompt itself instructs the subagent to edit/write/commit/push/build, or (b) the subagent_type is inherently write-oriented (e.g. "implementer", "tester"). Any write the subagent later attempts hits this same pre-tool-use hook and is blocked there, so you do not need to pre-block exploration dispatches defensively.

Do not invent additional restrictions. If a tool is not listed as blocked above, it is allowed. Do not fabricate policies like "requires explicit user approval", "prior denials confirm", "#N in sequence", "subagent escalation", or "workaround pattern" — those are not rules of this system.
=== END PLAN MODE ===
`;

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
