import path from "path";
import { runCommand, runProcessCancellable, type ProcessOutputLimits } from "./command.js";
import { type CancellationOptions, throwIfAborted } from "./cancellation.js";

const isWindows = process.platform === "win32";
const NULL_DEVICE = isWindows ? "NUL" : "/dev/null";
const SUPPRESS_STDERR = isWindows ? "2>NUL" : "2>/dev/null";
const DEFAULT_GIT_STATUS_MAX_BYTES = 512 * 1024;
const DEFAULT_GIT_DIFF_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_UNTRACKED_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_UNTRACKED_FILE_LIMIT = 50;

/**
 * Escape a file path for use in shell commands.
 * Uses single quotes on Unix, double quotes on Windows (cmd.exe).
 */
function shellEscape(filePath: string): string {
  if (isWindows) {
    return '"' + filePath.replace(/"/g, '""') + '"';
  }
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

  /**
   * Synthesized unified diff for untracked files only. This is the same content
   * appended to `diff` for tracked changes; exposed separately so size
   * classification can count untracked-only commits accurately.
   */
  untrackedDiff: string;
}

export type CommitSize = "SMALL" | "MEDIUM" | "LARGE";

/**
 * Classify commit size from git diff stats and untracked-file accounting.
 *
 * `diffStat` (output of `git diff --stat HEAD`) only covers tracked changes.
 * Untracked files appear as `??` lines in porcelain status; their content
 * comes from `untrackedDiff` (synthesized in `getUncommittedChanges`). Both
 * sources are folded into the file/line totals before bucketing.
 *
 * Buckets:
 * - LARGE:  >= 10 files OR >= 200 lines changed
 * - MEDIUM: >= 4 files OR >= 50 lines changed
 * - SMALL:  otherwise
 */
export function classifyCommitSize(
  diffStat: string,
  untrackedDiff: string,
  status: string,
): { size: CommitSize; filesChanged: number; linesChanged: number } {
  const last = diffStat.trim().split("\n").pop() ?? "";
  const filesM = last.match(/(\d+)\s+files?\s+changed/);
  const insM = last.match(/(\d+)\s+insertions?\(\+\)/);
  const delM = last.match(/(\d+)\s+deletions?\(-\)/);
  let filesChanged = filesM ? parseInt(filesM[1], 10) : 0;
  let linesChanged =
    (insM ? parseInt(insM[1], 10) : 0) + (delM ? parseInt(delM[1], 10) : 0);

  // Add untracked files: count `??` lines in porcelain status, count their
  // added lines from the synthesized untracked diff.
  const untrackedPaths = status
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  filesChanged += untrackedPaths.length;
  linesChanged += untrackedDiff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;

  let size: CommitSize;
  if (filesChanged >= 10 || linesChanged >= 200) size = "LARGE";
  else if (filesChanged >= 4 || linesChanged >= 50) size = "MEDIUM";
  else size = "SMALL";
  return { size, filesChanged, linesChanged };
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

export interface RepoGitContext {
  path: string;
  name: string;
  changes: GitChanges;
}

function sortRepoSelectionsSubmodulesFirst<T extends { path: string }>(
  repos: T[],
  mainRepo: string,
): T[] {
  const submodules = repos.filter((repo) => repo.path !== mainRepo);
  const main = repos.filter((repo) => repo.path === mainRepo);
  return [...submodules, ...main];
}

export function sortReposWithChangesSubmodulesFirst(
  repoInfo: RepoInfo,
): Array<{ path: string; name: string }> {
  return sortRepoSelectionsSubmodulesFirst(repoInfo.reposWithChanges, repoInfo.mainRepo);
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
   * COMMAND: git diff --no-index <null-device> "<file>"
   *
   * WHY: This is a trick to generate a diff for a file that git doesn't track.
   *   --no-index    = compare two files outside of git's index
   *   /dev/null|NUL = empty file (represents "nothing"; NUL on Windows)
   *   "<file>"      = the actual untracked file
   *
   * This produces output like "diff --git a/dev/null b/file.ts" showing the
   * entire file content as additions (+lines). This way untracked files appear
   * in the same unified diff format as tracked file changes.
   *
   * Stderr is suppressed and the command is forced to succeed (exit 0)
   * even if the file can't be read.
   */
  let untrackedDiff = "";
  for (const file of (untrackedFiles.output || "").split("\n").filter(Boolean)) {
    const escapedFile = shellEscape(file);
    const fileDiff = runCommand(`git diff --no-index ${NULL_DEVICE} ${escapedFile} ${SUPPRESS_STDERR} || ${isWindows ? "ver >NUL" : "true"}`, workingDir);
    untrackedDiff += fileDiff.output || "";
  }

  return {
    status: status.output || "",
    diff: (trackedDiff.output || "") + untrackedDiff,
    diffStat: diffStat.output || "",
    untrackedDiff,
  };
}

async function runGit(
  args: string[],
  cwd: string,
  options: ProcessOutputLimits = {}
): Promise<{ output: string; exitCode: number }> {
  throwIfAborted(options.signal);
  return runProcessCancellable({ shell: false, file: "git", args }, cwd, options);
}

export async function getGitStatusCancellable(
  workingDir: string,
  options: CancellationOptions = {}
): Promise<string> {
  const status = await runGit(["status", "--porcelain"], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  return status.output || "";
}

function appendWithinLimit(
  current: string,
  addition: string,
  limit: number,
  marker: string,
): { value: string; full: boolean } {
  const used = Buffer.byteLength(current, "utf-8");
  const remaining = Math.max(0, limit - used);
  if (remaining <= 0) {
    return { value: current + marker, full: true };
  }

  const additionBytes = Buffer.byteLength(addition, "utf-8");
  if (additionBytes <= remaining) {
    return { value: current + addition, full: false };
  }

  return {
    value: current + Buffer.from(addition).subarray(0, remaining).toString("utf-8") + marker,
    full: true,
  };
}

/**
 * Cancellable async variant of getUncommittedChanges for MCP request paths.
 */
export async function getUncommittedChangesCancellable(
  workingDir: string,
  options: CancellationOptions = {}
): Promise<GitChanges> {
  const status = await runGit(["status", "--porcelain"], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  const diffStat = await runGit(["diff", "--stat", "HEAD"], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  const trackedDiff = await runGit(["diff", "HEAD"], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_DIFF_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  const untrackedFiles = await runGit(["ls-files", "--others", "--exclude-standard"], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });

  let untrackedDiff = "";
  const files = (untrackedFiles.output || "").split("\n").filter(Boolean);
  for (const file of files.slice(0, DEFAULT_UNTRACKED_FILE_LIMIT)) {
    throwIfAborted(options.signal);
    const remaining = Math.max(
      0,
      DEFAULT_UNTRACKED_DIFF_MAX_BYTES - Buffer.byteLength(untrackedDiff, "utf-8"),
    );
    if (remaining <= 0) {
      untrackedDiff += `\n[agent-framework: untracked diff truncated after ${DEFAULT_UNTRACKED_DIFF_MAX_BYTES} bytes]\n`;
      break;
    }

    const fileDiff = await runGit(["diff", "--no-index", NULL_DEVICE, file], workingDir, {
      ...options,
      maxStdoutBytes: remaining,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    const appended = appendWithinLimit(
      untrackedDiff,
      fileDiff.output || "",
      DEFAULT_UNTRACKED_DIFF_MAX_BYTES,
      `\n[agent-framework: untracked diff truncated after ${DEFAULT_UNTRACKED_DIFF_MAX_BYTES} bytes]\n`,
    );
    untrackedDiff = appended.value;
    if (appended.full) break;
  }
  if (files.length > DEFAULT_UNTRACKED_FILE_LIMIT) {
    untrackedDiff += `\n[agent-framework: skipped ${files.length - DEFAULT_UNTRACKED_FILE_LIMIT} untracked files after limit ${DEFAULT_UNTRACKED_FILE_LIMIT}]\n`;
  }

  return {
    status: status.output || "",
    diff: (trackedDiff.output || "") + untrackedDiff,
    diffStat: diffStat.output || "",
    untrackedDiff,
  };
}

function formatRepoHeading(repo: { path: string; name: string }): string {
  return `${repo.name} (${repo.path})`;
}

export function formatGitContextForRepos(repos: RepoGitContext[]): string {
  if (repos.length === 0) {
    return `GIT STATUS (files changed):
(no changes)

GIT DIFF (all uncommitted changes):
(no diff)`;
  }

  return repos.map((repo) => `=== REPOSITORY: ${formatRepoHeading(repo)} ===

GIT STATUS (files changed):
${repo.changes.status || "(no changes)"}

GIT DIFF (all uncommitted changes):
${repo.changes.diff || "(no diff)"}`).join("\n\n");
}

export function formatSiblingRepoOverview(repos: RepoGitContext[]): string {
  if (repos.length === 0) return "";

  return `=== SIBLING REPOSITORY OVERVIEW ===
These uncommitted code changes are part of a repository with multiple dirty repositories. The current repository is provided in full above. Other dirty repositories are shown here as overview-only context:

${repos.map((repo) => `--- ${formatRepoHeading(repo)} ---
GIT STATUS:
${repo.changes.status || "(no changes)"}

GIT DIFF STAT:
${repo.changes.diffStat || "(no diff stat)"}`).join("\n\n")}
=== END SIBLING REPOSITORY OVERVIEW ===`;
}

export async function getRepoGitContextsCancellable(
  repos: Array<{ path: string; name: string }>,
  options: CancellationOptions = {},
): Promise<RepoGitContext[]> {
  const contexts: RepoGitContext[] = [];
  for (const repo of repos) {
    throwIfAborted(options.signal);
    contexts.push({
      ...repo,
      changes: await getUncommittedChangesCancellable(repo.path, options),
    });
  }
  return contexts;
}

async function getRepoGitOverviewContextsCancellable(
  repos: Array<{ path: string; name: string }>,
  options: CancellationOptions = {},
): Promise<RepoGitContext[]> {
  const contexts: RepoGitContext[] = [];
  for (const repo of repos) {
    throwIfAborted(options.signal);
    const status = await runGit(["status", "--porcelain"], repo.path, {
      ...options,
      maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    const diffStat = await runGit(["diff", "--stat", "HEAD"], repo.path, {
      ...options,
      maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    contexts.push({
      ...repo,
      changes: {
        status: status.output || "",
        diff: "",
        diffStat: diffStat.output || "",
        untrackedDiff: "",
      },
    });
  }
  return contexts;
}

export async function getAllReposGitContextCancellable(
  repoInfo: RepoInfo,
  options: CancellationOptions = {},
): Promise<{ repos: RepoGitContext[]; context: string }> {
  const repos = await getRepoGitContextsCancellable(
    sortReposWithChangesSubmodulesFirst(repoInfo),
    options,
  );
  return { repos, context: formatGitContextForRepos(repos) };
}

export async function getSingleRepoGitContextWithSiblingOverviewCancellable(
  workingDir: string,
  repoInfo: RepoInfo,
  options: CancellationOptions = {},
): Promise<{ current: RepoGitContext; siblingOverview: string }> {
  const sortedRepos = sortReposWithChangesSubmodulesFirst(repoInfo);
  const currentRepo = sortedRepos.find((repo) => repo.path === workingDir)
    ?? { path: workingDir, name: path.basename(workingDir) };
  const currentChanges = await getUncommittedChangesCancellable(currentRepo.path, options);
  const siblingRepos = sortedRepos.filter((repo) => repo.path !== currentRepo.path);
  const siblingContexts = await getRepoGitOverviewContextsCancellable(siblingRepos, options);

  return {
    current: { ...currentRepo, changes: currentChanges },
    siblingOverview: formatSiblingRepoOverview(siblingContexts),
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
  while (parentDir && parentDir !== path.dirname(parentDir)) {
    // Check if parent directory is inside a git repo
    const parentGitResult = runCommand(`git rev-parse --show-toplevel ${SUPPRESS_STDERR} || ${isWindows ? "echo." : "echo ''"}`, parentDir);
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

async function findTopmostRepoCancellable(
  startDir: string,
  options: CancellationOptions = {}
): Promise<string> {
  const gitRootResult = await runGit(["rev-parse", "--show-toplevel"], startDir, options);
  let currentRepo = gitRootResult.exitCode === 0 ? (gitRootResult.output || "").trim() : "";

  if (!currentRepo) {
    return startDir;
  }

  let parentDir = path.dirname(currentRepo);
  while (parentDir && parentDir !== path.dirname(parentDir)) {
    throwIfAborted(options.signal);
    const parentGitResult = await runGit(["rev-parse", "--show-toplevel"], parentDir, options);
    const parentRepo = parentGitResult.exitCode === 0 ? (parentGitResult.output || "").trim() : "";

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

  // Get submodule paths via `git submodule status` (cross-platform, no shell variable expansion)
  // Output format: " <hash> <path> (<description>)" or "-<hash> <path>" for uninitialized
  const submoduleResult = runCommand("git submodule status", mainRepo);
  const submodulePaths = (submoduleResult.output || "")
    .split("\n")
    .map((line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      // Skip the leading hash (and optional - or + prefix), extract the path
      const parts = trimmed.split(/\s+/);
      return parts.length >= 2 ? parts[1] : "";
    })
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

/**
 * Cancellable async variant of getRepoInfo for long-running MCP request paths.
 */
export async function getRepoInfoCancellable(
  workingDir: string,
  options: CancellationOptions = {}
): Promise<RepoInfo> {
  const mainRepo = await findTopmostRepoCancellable(workingDir, options);
  const mainRepoName = path.basename(mainRepo);

  const submoduleResult = await runGit(["submodule", "status"], mainRepo, options);
  const submodulePaths = (submoduleResult.output || "")
    .split("\n")
    .map((line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      const parts = trimmed.split(/\s+/);
      return parts.length >= 2 ? parts[1] : "";
    })
    .filter(Boolean);

  const submodules: SubmoduleInfo[] = [];
  for (const subPath of submodulePaths) {
    throwIfAborted(options.signal);
    const absolutePath = path.join(mainRepo, subPath);
    const statusResult = await runGit(["status", "--porcelain"], absolutePath, options);
    submodules.push({
      path: subPath,
      absolutePath,
      hasChanges: Boolean((statusResult.output || "").trim()),
    });
  }

  const mainStatusResult = await runGit(["status", "--porcelain", "--ignore-submodules=all"], mainRepo, options);
  const mainRepoHasChanges = Boolean((mainStatusResult.output || "").trim());

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
