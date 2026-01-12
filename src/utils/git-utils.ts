import path from "path";
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

export interface SubmoduleInfo {
  /** Relative path to the submodule from the parent repo */
  path: string;

  /** Absolute path to the submodule */
  absolutePath: string;

  /** Whether the submodule has uncommitted changes */
  hasChanges: boolean;
}

export interface RepoInfo {
  /** Absolute path to the main repository */
  mainRepo: string;

  /** Name of the main repository (directory name) */
  mainRepoName: string;

  /** Whether the main repo (excluding submodules) has uncommitted changes */
  mainRepoHasChanges: boolean;

  /** List of submodules with their status */
  submodules: SubmoduleInfo[];

  /** List of repos with uncommitted changes (for convenience) */
  reposWithChanges: Array<{ path: string; name: string }>;
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

/**
 * Find the topmost git repository by traversing up the directory tree.
 * This handles the case where we're inside a submodule and need to find the parent repo.
 */
function findTopmostRepo(startDir: string): string {
  // Get the immediate git root
  const gitRootResult = runCommand("git rev-parse --show-toplevel", startDir);
  let currentRepo = (gitRootResult.output || "").trim();

  if (!currentRepo) {
    return startDir;
  }

  // Traverse up to find if there's a parent git repo
  let parentDir = path.dirname(currentRepo);
  while (parentDir && parentDir !== "/" && parentDir !== path.dirname(parentDir)) {
    // Check if parent directory is inside a git repo
    const parentGitResult = runCommand("git rev-parse --show-toplevel 2>/dev/null || echo ''", parentDir);
    const parentRepo = (parentGitResult.output || "").trim();

    if (parentRepo && parentRepo !== currentRepo) {
      currentRepo = parentRepo;
      parentDir = path.dirname(currentRepo);
    } else {
      break;
    }
  }

  return currentRepo;
}

/**
 * Get information about the repository structure including submodules.
 *
 * This function detects git submodules and checks which repos have uncommitted changes.
 * Useful for determining which repositories need to be committed/pushed when working
 * in a project with multiple git repos.
 *
 * @param workingDir - The directory to check (will find the git root)
 * @returns RepoInfo object with main repo and submodule details
 */
export function getRepoInfo(workingDir: string): RepoInfo {
  // Get the absolute path to the git root (topmost parent repo)
  const mainRepo = findTopmostRepo(workingDir);
  const mainRepoName = path.basename(mainRepo);

  // Get submodule paths
  const submoduleResult = runCommand("git submodule --quiet foreach 'echo $sm_path'", mainRepo);
  const submodulePaths = (submoduleResult.output || "")
    .split("\n")
    .map((p: string) => p.trim())
    .filter(Boolean);

  // Check each submodule for changes
  const submodules: SubmoduleInfo[] = submodulePaths.map((subPath: string) => {
    const absolutePath = path.join(mainRepo, subPath);
    const statusResult = runCommand("git status --porcelain", absolutePath);
    const hasChanges = Boolean((statusResult.output || "").trim());

    return {
      path: subPath,
      absolutePath,
      hasChanges,
    };
  });

  // Check main repo for changes (excluding submodule directories)
  // Get status and filter out lines that are inside submodule paths
  const mainStatusResult = runCommand("git status --porcelain --ignore-submodules=all", mainRepo);
  const mainRepoHasChanges = Boolean((mainStatusResult.output || "").trim());

  // Build list of repos with changes
  const reposWithChanges: Array<{ path: string; name: string }> = [];

  if (mainRepoHasChanges) {
    reposWithChanges.push({ path: mainRepo, name: mainRepoName });
  }

  for (const sub of submodules) {
    if (sub.hasChanges) {
      reposWithChanges.push({
        path: sub.absolutePath,
        name: path.basename(sub.absolutePath),
      });
    }
  }

  return {
    mainRepo,
    mainRepoName,
    mainRepoHasChanges,
    submodules,
    reposWithChanges,
  };
}
