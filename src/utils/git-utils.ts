import { runCommand } from "./command.js";

/**
 * Escape a file path for use in shell commands.
 * Uses single quotes and escapes any embedded single quotes.
 */
function shellEscape(filePath: string): string {
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

/**
 * ============================================================================
 * GIT UTILITIES FOR UNCOMMITTED CODE ANALYSIS
 * ============================================================================
 *
 * PURPOSE:
 * This module provides a single function to gather ALL uncommitted code changes
 * in a git repository. This includes:
 * - Staged changes (files added with `git add`)
 * - Unstaged changes (modified tracked files not yet added)
 * - Untracked files (new files never added to git)
 *
 * USE CASES:
 *
 * 1. CHECK AGENT (src/agents/mcp/check.ts)
 *    - Needs to know which files are uncommitted so it can focus error reporting
 *    - Uses: status (to list changed files)
 *
 * 2. CONFIRM AGENT (src/agents/mcp/confirm.ts)
 *    - Main consumer - needs to see ALL code changes to evaluate quality
 *    - Checks for security issues, bad patterns, unwanted files
 *    - Uses: status (file list), diff (actual code changes)
 *
 * 3. COMMIT AGENT (src/agents/mcp/commit.ts)
 *    - Needs diff stats to classify commit size (small/medium/large)
 *    - Needs diff content to generate meaningful commit message
 *    - Uses: status, diff, diffStat
 *
 * 4. FUTURE: PR description generation, code review, etc.
 *
 * ============================================================================
 */

export interface GitChanges {
  /** List of changed files in short format (e.g., "M  file.ts", "?? new.ts") */
  status: string;

  /** Full unified diff of ALL uncommitted changes (tracked + untracked files) */
  diff: string;

  /** Summary statistics: files changed, insertions, deletions */
  diffStat: string;
}

/**
 * Get all uncommitted code changes from a git repository.
 *
 * @param workingDir - The directory containing the git repository
 * @returns GitChanges object with status, diff, and diffStat
 */
export function getUncommittedChanges(workingDir: string): GitChanges {
  /**
   * COMMAND: git status --porcelain
   *
   * WHY: The --porcelain flag outputs a stable, machine-parseable format that
   * won't change between git versions. Without it, git status outputs human-friendly
   * text that varies based on locale and git version.
   *
   * OUTPUT FORMAT:
   *   "M  file.ts"  = modified and staged
   *   " M file.ts"  = modified but not staged
   *   "MM file.ts"  = modified, staged, then modified again
   *   "A  file.ts"  = new file, staged
   *   "?? file.ts"  = untracked (new file, never added to git)
   *   "D  file.ts"  = deleted and staged
   */
  const status = runCommand("git status --porcelain", workingDir);

  /**
   * COMMAND: git diff --stat HEAD
   *
   * WHY: The --stat flag gives a summary showing which files changed and how many
   * lines were added/removed. HEAD means "compare against the last commit".
   * This is used by the commit agent to classify commit size (small/medium/large).
   *
   * OUTPUT FORMAT:
   *   src/file.ts | 10 ++++------
   *   2 files changed, 4 insertions(+), 6 deletions(-)
   */
  const diffStat = runCommand("git diff --stat HEAD", workingDir);

  /**
   * COMMAND: git diff HEAD
   *
   * WHY: Shows the actual code changes (unified diff format) for all TRACKED files.
   * HEAD means compare working directory against the last commit.
   * This captures both staged AND unstaged changes to existing files.
   *
   * LIMITATION: Does NOT show content of untracked files (new files never added).
   * We handle untracked files separately below.
   */
  const trackedDiff = runCommand("git diff HEAD", workingDir);

  /**
   * COMMAND: git ls-files --others --exclude-standard
   *
   * WHY: Lists all UNTRACKED files (files that exist but were never git added).
   *   --others        = show untracked files
   *   --exclude-standard = respect .gitignore rules (don't show node_modules, etc.)
   *
   * We need this because `git diff HEAD` only shows changes to tracked files.
   * New files that were never added to git won't appear in that diff.
   */
  const untrackedFiles = runCommand("git ls-files --others --exclude-standard", workingDir);

  /**
   * COMMAND: git diff --no-index /dev/null "<file>"
   *
   * WHY: This is a trick to generate a diff for a file that git doesn't track.
   *   --no-index = compare two files outside of git's index
   *   /dev/null  = empty file (represents "nothing")
   *   "<file>"   = the actual untracked file
   *
   * This produces output like "diff --git a/dev/null b/file.ts" showing the
   * entire file content as additions (+lines). This way untracked files appear
   * in the same unified diff format as tracked file changes.
   *
   * The "2>/dev/null || true" suppresses errors and ensures the command always
   * succeeds (exit code 0) even if the file can't be read.
   */
  let untrackedDiff = "";
  for (const file of (untrackedFiles.output || "").split("\n").filter(Boolean)) {
    const escapedFile = shellEscape(file);
    const fileDiff = runCommand(`git diff --no-index /dev/null ${escapedFile} 2>/dev/null || true`, workingDir);
    untrackedDiff += fileDiff.output || "";
  }

  return {
    status: status.output || "",
    diff: (trackedDiff.output || "") + untrackedDiff,
    diffStat: diffStat.output || "",
  };
}
