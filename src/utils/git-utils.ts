import path from "path";
import fs from "fs";
import os from "os";
import { runCommand, runProcessCancellable, type ProcessOutputLimits } from "./command.js";
import { type CancellationOptions, throwIfAborted } from "./cancellation.js";
import { isPathAtOrInside } from "./path-containment.js";

const isWindows = process.platform === "win32";
const NULL_DEVICE = isWindows ? "NUL" : "/dev/null";
const SUPPRESS_STDERR = isWindows ? "2>NUL" : "2>/dev/null";
const DEFAULT_GIT_STATUS_MAX_BYTES = 512 * 1024;
const DEFAULT_GIT_DIFF_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_GIT_FILE_LIST_MAX_BYTES = 64 * 1024 * 1024;
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

  /** Move pairs normalized while constructing the diff, if any. */
  normalizedMoves?: NormalizedMoveSummary[];
}

export type CommitSize = "SMALL" | "MEDIUM" | "LARGE";

export interface NormalizedMoveSummary {
  oldPath: string;
  newPath: string;
  similarity: number;
  mode: "moved" | "moved-with-edits";
}

export interface RepoNormalizedMoveSummary {
  repoPath: string;
  moves: NormalizedMoveSummary[];
}

export interface SkippedMoveCandidate {
  oldPath: string;
  newPaths: string[];
  reason: "ambiguous";
}

export interface MoveDetectionResult {
  moves: NormalizedMoveSummary[];
  skipped: SkippedMoveCandidate[];
}

type GitChangeCollectionOptions = CancellationOptions & {
  normalizeMovedRecreated?: boolean;
  preparedNormalizedMoves?: NormalizedMoveSummary[];
  preparedNormalizedMovesByRepo?: RepoNormalizedMoveSummary[];
};

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

export interface GitVisibleFileEntry {
  path: string;
  lines: number;
}

export interface GitVisibleFileInventory {
  files: GitVisibleFileEntry[];
  totalFiles: number;
  totalLines: number;
  skippedBinary: number;
  skippedUnreadable: number;
}

export interface RepoFullScopeContext {
  path: string;
  name: string;
  inventory: GitVisibleFileInventory;
}

export interface DeletedOrRenamedFileReference {
  path: string;
  line: number;
  text: string;
}

export interface DeletedOrRenamedFileReferenceIssue {
  oldPath: string;
  oldBasename: string;
  changeType: "deleted" | "renamed";
  references: DeletedOrRenamedFileReference[];
}

export interface NonexistentFileReferenceIssue {
  referencedPath: string;
  references: DeletedOrRenamedFileReference[];
}

export interface FilenameReferenceDiagnostics {
  deletedOrRenamedIssues: DeletedOrRenamedFileReferenceIssue[];
  nonexistentIssues: NonexistentFileReferenceIssue[];
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

export function allReposInScope(repoInfo: RepoInfo): Array<{ path: string; name: string }> {
  return [
    ...repoInfo.submodules.map((submodule) => ({
      path: submodule.absolutePath,
      name: path.basename(submodule.absolutePath),
    })),
    { path: repoInfo.mainRepo, name: repoInfo.mainRepoName },
  ];
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

function splitGitLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
    .filter((line) => line.length > 0);
}

async function readGitBlobText(
  workingDir: string,
  relativePath: string,
  options: CancellationOptions,
): Promise<string | undefined> {
  const result = await runGit(["show", `HEAD:${relativePath}`], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_DIFF_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  if (result.exitCode !== 0) return undefined;
  if ((result.output || "").includes("\0")) return undefined;
  if ((result.output || "").includes("[agent-framework: stdout truncated after")) return undefined;
  return result.output || "";
}

async function readWorkingTreeText(
  workingDir: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    const buffer = await fs.promises.readFile(path.join(workingDir, relativePath));
    if (buffer.includes(0) || buffer.byteLength > DEFAULT_GIT_DIFF_MAX_BYTES) return undefined;
    return buffer.toString("utf-8");
  } catch {
    return undefined;
  }
}

async function getHeadBlobHash(
  workingDir: string,
  relativePath: string,
  options: CancellationOptions,
): Promise<string | undefined> {
  const result = await runGit(["rev-parse", `HEAD:${relativePath}`], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  return result.exitCode === 0 ? result.output.trim() || undefined : undefined;
}

async function getWorkingTreeBlobHash(
  workingDir: string,
  relativePath: string,
  options: CancellationOptions,
): Promise<string | undefined> {
  const result = await runGit(["hash-object", "--", relativePath], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  return result.exitCode === 0 ? result.output.trim() || undefined : undefined;
}

function lcsLineCount(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous.fill(0)];
  }
  return previous[b.length];
}

async function scoreMoveCandidate(
  workingDir: string,
  oldPath: string,
  newPath: string,
  options: CancellationOptions,
): Promise<number | undefined> {
  const [oldHash, newHash] = await Promise.all([
    getHeadBlobHash(workingDir, oldPath, options),
    getWorkingTreeBlobHash(workingDir, newPath, options),
  ]);
  if (oldHash && newHash && oldHash === newHash) return 100;

  const [oldText, newText] = await Promise.all([
    readGitBlobText(workingDir, oldPath, options),
    readWorkingTreeText(workingDir, newPath),
  ]);
  if (oldText === undefined || newText === undefined) return undefined;

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length + newLines.length === 0) return undefined;
  return Math.floor((2 * lcsLineCount(oldLines, newLines) / (oldLines.length + newLines.length)) * 100);
}

export async function detectMovedRecreatedFilesCancellable(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<MoveDetectionResult> {
  const [deletedResult, untrackedResult] = await Promise.all([
    runGit(["diff", "--name-only", "--diff-filter=D", "HEAD"], workingDir, {
      ...options,
      maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    }),
    runGit(["ls-files", "--others", "--exclude-standard"], workingDir, {
      ...options,
      maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    }),
  ]);

  const deletedPaths = splitGitLines(deletedResult.output || "");
  const untrackedPaths = splitGitLines(untrackedResult.output || "");
  return detectMovedRecreatedFilesFromPathsCancellable(workingDir, deletedPaths, untrackedPaths, options);
}

async function detectMovedRecreatedFilesFromPathsCancellable(
  workingDir: string,
  deletedPaths: string[],
  untrackedPaths: string[],
  options: CancellationOptions = {},
): Promise<MoveDetectionResult> {
  const candidates: Array<{ oldPath: string; newPath: string; score: number }> = [];

  for (const oldPath of deletedPaths) {
    throwIfAborted(options.signal);
    for (const newPath of untrackedPaths) {
      if (path.basename(oldPath) !== path.basename(newPath)) continue;
      const score = await scoreMoveCandidate(workingDir, oldPath, newPath, options);
      if (score !== undefined && score >= 50) {
        candidates.push({ oldPath, newPath, score });
      }
    }
  }

  const skipped: SkippedMoveCandidate[] = [];
  const tiedOldPaths = new Set<string>();
  const tiedNewPaths = new Set<string>();
  for (const oldPath of deletedPaths) {
    const matches = candidates.filter((candidate) => candidate.oldPath === oldPath);
    if (matches.length < 2) continue;
    const bestScore = Math.max(...matches.map((candidate) => candidate.score));
    const best = matches.filter((candidate) => candidate.score === bestScore);
    if (best.length > 1) {
      tiedOldPaths.add(oldPath);
      skipped.push({
        oldPath,
        newPaths: best.map((candidate) => candidate.newPath).sort(),
        reason: "ambiguous",
      });
    }
  }
  for (const newPath of untrackedPaths) {
    const matches = candidates.filter((candidate) => candidate.newPath === newPath);
    if (matches.length < 2) continue;
    const bestScore = Math.max(...matches.map((candidate) => candidate.score));
    const best = matches.filter((candidate) => candidate.score === bestScore);
    if (best.length > 1) {
      tiedNewPaths.add(newPath);
      for (const candidate of best) {
        if (tiedOldPaths.has(candidate.oldPath)) continue;
        tiedOldPaths.add(candidate.oldPath);
        skipped.push({
          oldPath: candidate.oldPath,
          newPaths: [newPath],
          reason: "ambiguous",
        });
      }
    }
  }

  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  const moves: NormalizedMoveSummary[] = [];
  for (const candidate of candidates.sort((a, b) =>
    b.score - a.score
    || a.oldPath.localeCompare(b.oldPath)
    || a.newPath.localeCompare(b.newPath)
  )) {
    if (tiedOldPaths.has(candidate.oldPath)) continue;
    if (tiedNewPaths.has(candidate.newPath)) continue;
    if (pairedOld.has(candidate.oldPath) || pairedNew.has(candidate.newPath)) continue;
    pairedOld.add(candidate.oldPath);
    pairedNew.add(candidate.newPath);
    moves.push({
      oldPath: candidate.oldPath,
      newPath: candidate.newPath,
      similarity: candidate.score,
      mode: candidate.score === 100 ? "moved" : "moved-with-edits",
    });
  }

  return { moves, skipped };
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

type DeletedOrRenamedChange = {
  oldPath: string;
  oldBasename: string;
  changeType: "deleted" | "renamed";
};

type NameStatusChange = DeletedOrRenamedChange & {
  newPath?: string;
};

type FilenameReferenceScanContext = {
  changes: NameStatusChange[];
  inventory: GitVisibleFileInventory;
};

function parseDeletedOrRenamedChanges(nameStatus: string): NameStatusChange[] {
  const changes: NameStatusChange[] = [];
  const seen = new Set<string>();

  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let changeType: DeletedOrRenamedChange["changeType"] | undefined;

    if (status === "D") {
      oldPath = parts[1];
      changeType = "deleted";
    } else if (status.startsWith("R")) {
      oldPath = parts[1];
      newPath = parts[2];
      changeType = "renamed";
    }

    if (!oldPath || !changeType) continue;
    const key = `${changeType}\0${oldPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({
      oldPath,
      oldBasename: path.basename(oldPath),
      changeType,
      newPath,
    });
  }

  return changes;
}

function normalizeGitRelativePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/\\/g, "/")).replace(/^\.\//, "");
}

const REFERENCE_LEFT_BOUNDARY_PATTERN = "(^|[\\s\"'`([{<:=,])";
const REFERENCE_RIGHT_BOUNDARY_PATTERN = "(?=$|[\\s\"'`)\\]}>:;,.])";

function buildReferenceBoundaryRegExp(innerPattern: string, flags = ""): RegExp {
  return new RegExp(`${REFERENCE_LEFT_BOUNDARY_PATTERN}${innerPattern}${REFERENCE_RIGHT_BOUNDARY_PATTERN}`, flags);
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function lineContainsRepoPathLiteral(line: string, relativePath: string): boolean {
  return buildReferenceBoundaryRegExp(escapeRegExp(relativePath)).test(line);
}

function lineReferencesDeletedOrRenamedPath(
  sourcePath: string,
  line: string,
  oldPath: string,
  basename: string,
): boolean {
  const normalizedOldPath = normalizeGitRelativePath(oldPath);
  const genericBarrelName = isGenericBarrelBasename(basename);
  const oldPathNoExt = stripKnownExtension(normalizedOldPath);

  if (lineContainsRepoPathLiteral(line, normalizedOldPath)) return true;
  if (genericBarrelName && lineContainsRepoPathLiteral(line, oldPathNoExt)) return true;
  if (lineContainsRepoPathLiteral(line, basename)) {
    const referencedPath = resolveReferencedPath(sourcePath, basename);
    if (referencedPath && normalizeGitRelativePath(referencedPath) === normalizedOldPath) return true;
  }
  if (genericBarrelName) {
    const basenameNoExt = stripKnownExtension(basename);
    if (lineContainsRepoPathLiteral(line, basenameNoExt)) {
      const referencedPathNoExt = normalizeGitRelativePath(path.posix.join(
        path.posix.dirname(sourcePath),
        basenameNoExt,
      ));
      if (referencedPathNoExt === oldPathNoExt) return true;
    }
  }

  for (const candidate of findPathReferenceCandidates(line)) {
    const referencedPath = resolveReferencedPath(sourcePath, candidate.rawPath);
    if (!referencedPath) continue;
    const normalizedReferencedPath = normalizeGitRelativePath(referencedPath);
    if (normalizedReferencedPath === normalizedOldPath) return true;
    if (genericBarrelName && stripKnownExtension(normalizedReferencedPath) === oldPathNoExt) return true;
  }

  return false;
}

async function findReferencesToDeletedOrRenamedPath(
  workingDir: string,
  files: string[],
  oldPath: string,
  basename: string,
  options: CancellationOptions,
): Promise<DeletedOrRenamedFileReference[]> {
  const references: DeletedOrRenamedFileReference[] = [];
  const genericBarrelName = isGenericBarrelBasename(basename);
  const oldPathNoExt = stripKnownExtension(normalizeGitRelativePath(oldPath));
  for (const relativePath of files) {
    throwIfAborted(options.signal);
    const absolutePath = path.join(workingDir, relativePath);
    let content: string;
    try {
      content = await fs.promises.readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (
        !lines[i].includes(basename) &&
        !lines[i].includes(oldPath) &&
        !(genericBarrelName && lines[i].includes(oldPathNoExt))
      ) {
        continue;
      }
      if (!lineReferencesDeletedOrRenamedPath(relativePath, lines[i], oldPath, basename)) continue;
      references.push({
        path: relativePath,
        line: i + 1,
        text: lines[i].trim(),
      });
    }
  }
  return references;
}

function isGenericBarrelBasename(basename: string): boolean {
  return /^(?:index|mod|lib)\.(?:[cm]?[jt]sx?|rs)$/.test(basename);
}

function stripKnownExtension(filePath: string): string {
  return filePath.replace(/\.(?:[cm]?[jt]sx?|rs)$/, "");
}

function isScenarioFixturePath(relativePath: string): boolean {
  return relativePath.startsWith("scenarios/") && relativePath.endsWith(".json");
}

const FILE_REFERENCE_RE = buildReferenceBoundaryRegExp(
  "((?:/+|\\.{1,2}/|[A-Za-z0-9_.-]+/)[A-Za-z0-9_./@%+~=-]*\\.[A-Za-z0-9][A-Za-z0-9+-]{0,11})",
  "g",
);
const EXTENSIONLESS_CONFIG_REFERENCE_RE = buildReferenceBoundaryRegExp(
  "((?:/+|\\.{1,2}/|(?:[A-Za-z0-9_.-]+/)+)?(?:\\.env(?:\\.[A-Za-z0-9_.-]+)?|Dockerfile(?:\\.[A-Za-z0-9_.-]+)?|Containerfile(?:\\.[A-Za-z0-9_.-]+)?|Makefile(?:\\.[A-Za-z0-9_.-]+)?|makefile(?:\\.[A-Za-z0-9_.-]+)?|GNUmakefile|Justfile|justfile))",
  "g",
);
const MARKDOWN_LINK_TARGET_RE = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;

const CHECKED_REFERENCE_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".env",
  ".fish",
  ".gif",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ico",
  ".java",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".nix",
  ".php",
  ".png",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svg",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webp",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const FILENAME_REFERENCE_WARNING_SOURCE_EXTENSIONS = new Set([
  ".adoc",
  ".html",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".rst",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const EXTENSIONLESS_CONFIG_REFERENCE_BASENAMES = new Set([
  ".env",
  "Containerfile",
  "Dockerfile",
  "GNUmakefile",
  "Justfile",
  "Makefile",
  "justfile",
  "makefile",
]);

const JS_RUNTIME_EXTENSION_ALTERNATES: Record<string, string[]> = {
  ".cjs": [".cts", ".ts"],
  ".js": [".ts", ".tsx", ".mts", ".cts"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts", ".ts"],
};

const CONFIG_REFERENCE_ALIASES: Record<string, string[]> = {
  "Justfile": ["justfile"],
  "justfile": ["Justfile"],
  "Makefile": ["makefile", "GNUmakefile"],
  "makefile": ["Makefile", "GNUmakefile"],
};

const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template"];
const ENV_TEMPLATE_BASENAMES = ENV_TEMPLATE_SUFFIXES.map((suffix) => `.env${suffix}`);

const GENERATED_REFERENCE_PATH_PREFIXES = [
  "build/",
  "coverage/",
  "dist/",
  "out/",
  "target/",
];

function shouldIgnoreFilenameReferenceScanPath(relativePath: string): boolean {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const basename = path.posix.basename(relativePath);
  const isScannableSource =
    FILENAME_REFERENCE_WARNING_SOURCE_EXTENSIONS.has(extension) ||
    isExtensionlessConfigReferenceBasename(basename);
  return (
    !isScannableSource ||
    isScenarioFixturePath(relativePath) ||
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(relativePath)
  );
}

function isGeneratedReferencePath(relativePath: string): boolean {
  return GENERATED_REFERENCE_PATH_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix) || relativePath.includes(`/${prefix}`)
  );
}

function scansMarkdownFences(relativePath: string): boolean {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return extension === ".md" || extension === ".mdx";
}

function isMarkdownFenceLine(line: string): boolean {
  return /^\s*(?:`{3,}|~{3,})/.test(line);
}

function stripReferenceDecoration(rawPath: string): string {
  return rawPath.replace(/[?#].*$/, "");
}

function isProtocolReferenceCandidate(
  line: string,
  matchIndex: number,
  leftBoundary: string,
  rawPath: string,
): boolean {
  return rawPath.startsWith("//") || line.slice(0, matchIndex + leftBoundary.length).endsWith("://");
}

function resolveReferencedPath(sourcePath: string, rawPath: string): string | null {
  return resolveReferencedPathFromBase(path.posix.dirname(sourcePath), rawPath);
}

function resolveRepoRootReferencedPath(rawPath: string): string | null {
  return resolveReferencedPathFromBase("", rawPath);
}

function resolveReferencedPathFromBase(base: string, rawPath: string): string | null {
  const clean = stripReferenceDecoration(rawPath);
  if (!clean || clean.startsWith("@") || clean.includes("*")) return null;
  if (clean.includes("://") || clean.startsWith("//") || /^[A-Za-z]:/.test(clean)) return null;

  const extension = path.posix.extname(clean).toLowerCase();
  const basename = path.posix.basename(clean);
  if (
    !CHECKED_REFERENCE_EXTENSIONS.has(extension) &&
    !isExtensionlessConfigReferenceBasename(basename)
  ) return null;

  const rootAnchoredPath = clean.startsWith("/") ? clean.replace(/^\/+/, "") : null;
  const resolved = path.posix.normalize(path.posix.join(rootAnchoredPath === null ? base : "", rootAnchoredPath ?? clean));
  if (!resolved || resolved === "." || resolved === ".." || resolved.startsWith("../")) return null;
  return resolved;
}

function isExtensionlessConfigReferenceBasename(basename: string): boolean {
  return (
    EXTENSIONLESS_CONFIG_REFERENCE_BASENAMES.has(basename) ||
    basename.startsWith(".env.") ||
    basename.startsWith("Containerfile.") ||
    basename.startsWith("Dockerfile.") ||
    basename.startsWith("Makefile.") ||
    basename.startsWith("makefile.")
  );
}

async function repoRelativeFileExists(
  workingDir: string,
  relativePath: string,
): Promise<boolean> {
  try {
    const absolutePath = path.resolve(workingDir, relativePath);
    if (!isPathAtOrInside(absolutePath, workingDir)) return false;
    return (await fs.promises.stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

async function referencedPathExists(
  workingDir: string,
  relativePath: string,
): Promise<boolean> {
  if (await repoRelativeFileExists(workingDir, relativePath)) return true;

  const extension = path.posix.extname(relativePath).toLowerCase();
  const alternates = JS_RUNTIME_EXTENSION_ALTERNATES[extension] ?? [];
  for (const alternateExtension of alternates) {
    const alternatePath = relativePath.slice(0, -extension.length) + alternateExtension;
    if (await repoRelativeFileExists(workingDir, alternatePath)) return true;
  }

  const basename = path.posix.basename(relativePath);
  const aliases = CONFIG_REFERENCE_ALIASES[basename] ?? [];
  for (const alias of aliases) {
    const aliasPath = path.posix.join(path.posix.dirname(relativePath), alias);
    if (await repoRelativeFileExists(workingDir, aliasPath)) return true;
  }

  return false;
}

type PathReferenceCandidateKind = "markdown-link" | "path-literal" | "extensionless-config-literal";

type PathReferenceCandidate = {
  rawPath: string;
  kind: PathReferenceCandidateKind;
  index: number;
};

function addPathReferenceCandidate(
  candidates: Map<string, PathReferenceCandidate>,
  candidate: PathReferenceCandidate,
): void {
  const key = `${candidate.index}\0${candidate.rawPath}`;
  const existing = candidates.get(key);
  if (!existing || candidate.kind === "markdown-link") {
    candidates.set(key, candidate);
  }
}

function findPathReferenceCandidates(line: string): PathReferenceCandidate[] {
  const candidates = new Map<string, PathReferenceCandidate>();
  MARKDOWN_LINK_TARGET_RE.lastIndex = 0;
  for (let match = MARKDOWN_LINK_TARGET_RE.exec(line); match; match = MARKDOWN_LINK_TARGET_RE.exec(line)) {
    const rawPath = match[1];
    if (rawPath) {
      addPathReferenceCandidate(candidates, {
        rawPath,
        kind: "markdown-link",
        index: match.index + match[0].indexOf(rawPath),
      });
    }
  }

  FILE_REFERENCE_RE.lastIndex = 0;
  for (let match = FILE_REFERENCE_RE.exec(line); match; match = FILE_REFERENCE_RE.exec(line)) {
    const rawPath = match[2];
    if (!rawPath || isProtocolReferenceCandidate(line, match.index, match[1], rawPath)) continue;
    addPathReferenceCandidate(candidates, {
      rawPath,
      kind: "path-literal",
      index: match.index + match[1].length,
    });
  }

  EXTENSIONLESS_CONFIG_REFERENCE_RE.lastIndex = 0;
  for (
    let match = EXTENSIONLESS_CONFIG_REFERENCE_RE.exec(line);
    match;
    match = EXTENSIONLESS_CONFIG_REFERENCE_RE.exec(line)
  ) {
    const rawPath = match[2];
    if (!rawPath || isProtocolReferenceCandidate(line, match.index, match[1], rawPath)) continue;
    addPathReferenceCandidate(candidates, {
      rawPath,
      kind: "extensionless-config-literal",
      index: match.index + match[1].length,
    });
  }
  return [...candidates.values()].sort((a, b) => a.index - b.index || a.rawPath.localeCompare(b.rawPath));
}

function isRepoRootFallbackEligible(candidate: PathReferenceCandidate): boolean {
  const clean = stripReferenceDecoration(candidate.rawPath);
  return (
    candidate.kind !== "markdown-link" &&
    !clean.startsWith("./") &&
    !clean.startsWith("../") &&
    !clean.startsWith("/")
  );
}

async function referenceCandidateExists(
  workingDir: string,
  referencedPath: string,
  candidate: PathReferenceCandidate,
): Promise<boolean> {
  if (await referencedPathExists(workingDir, referencedPath)) return true;
  if (!isRepoRootFallbackEligible(candidate)) return false;

  const rootReferencedPath = resolveRepoRootReferencedPath(candidate.rawPath);
  return Boolean(rootReferencedPath && await referencedPathExists(workingDir, rootReferencedPath));
}

function isPlaceholderReferencePath(relativePath: string): boolean {
  return /(?:^|[^A-Za-z0-9])(?:Your[A-Z][A-Za-z0-9]*|your[A-Z][A-Za-z0-9]*)/.test(path.posix.basename(relativePath));
}

function isCreateInstructionForCandidate(line: string, candidate: PathReferenceCandidate): boolean {
  if (candidate.kind === "markdown-link") return false;
  const beforeCandidate = line.slice(0, candidate.index);
  if (/\b(?:do\s+not|don't|never)\s+create\s+$/i.test(beforeCandidate)) return false;
  return /\bcreate\s+$/i.test(beforeCandidate);
}

async function isGitIgnoredPath(
  workingDir: string,
  relativePath: string,
  options: CancellationOptions,
): Promise<boolean> {
  const result = await runGit(["check-ignore", "--quiet", "--", relativePath], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  return result.exitCode === 0;
}

async function hasEnvTemplateForPath(
  workingDir: string,
  relativePath: string,
  allowGenericTemplates: boolean,
): Promise<boolean> {
  const dirname = path.posix.dirname(relativePath);
  const candidateDirs = new Set(["", dirname === "." ? "" : dirname]);
  const basename = path.posix.basename(relativePath);
  const templateBasenames = [
    ...ENV_TEMPLATE_SUFFIXES.map((suffix) => `${basename}${suffix}`),
    ...(allowGenericTemplates ? ENV_TEMPLATE_BASENAMES : []),
  ];

  for (const dir of candidateDirs) {
    for (const templateBasename of templateBasenames) {
      const templatePath = dir ? path.posix.join(dir, templateBasename) : templateBasename;
      if (await repoRelativeFileExists(workingDir, templatePath)) return true;
    }
  }

  return false;
}

async function isIntentionalEnvReference(
  workingDir: string,
  referencedPath: string,
  options: CancellationOptions,
): Promise<boolean> {
  const basename = path.posix.basename(referencedPath);
  const isBareEnv = basename === ".env";
  if (
    !isBareEnv &&
    (
      !basename.startsWith(".env.") ||
      ENV_TEMPLATE_BASENAMES.includes(basename)
    )
  ) return false;
  if (
    await isGitIgnoredPath(workingDir, referencedPath, options) ||
    await isGitIgnoredPath(workingDir, basename, options)
  ) return true;
  return (
    await hasEnvTemplateForPath(workingDir, referencedPath, isBareEnv)
  );
}

function lastWordIndexBefore(line: string, word: string, endIndex: number): number {
  const wordRe = new RegExp(`\\b${word}\\b`, "gi");
  let lastIndex = -1;
  for (let match = wordRe.exec(line); match && match.index < endIndex; match = wordRe.exec(line)) {
    lastIndex = match.index;
  }
  return lastIndex;
}

async function isCopyInstructionToCandidate(
  workingDir: string,
  sourcePath: string,
  line: string,
  candidate: PathReferenceCandidate,
  candidates: readonly PathReferenceCandidate[],
): Promise<boolean> {
  const toIndex = lastWordIndexBefore(line, "to", candidate.index);
  if (toIndex < 0) return false;
  const copyIndex = lastWordIndexBefore(line, "copy", toIndex);
  if (copyIndex < 0) return false;
  const destinationCandidate = candidates.find((possibleDestination) => possibleDestination.index > toIndex);
  if (destinationCandidate !== candidate) return false;

  const sourceCandidates = candidates.filter((sourceCandidate) =>
    sourceCandidate.index > copyIndex &&
    sourceCandidate.index < toIndex
  );
  for (const sourceCandidate of sourceCandidates) {
    const sourceReferencedPath = resolveReferencedPath(sourcePath, sourceCandidate.rawPath);
    if (sourceReferencedPath && await referenceCandidateExists(workingDir, sourceReferencedPath, sourceCandidate)) {
      return true;
    }
  }

  return false;
}

async function shouldSuppressNonexistentReference(input: {
  workingDir: string;
  sourcePath: string;
  line: string;
  referencedPath: string;
  candidate: PathReferenceCandidate;
  candidates: readonly PathReferenceCandidate[];
  options: CancellationOptions;
}): Promise<boolean> {
  return (
    isPlaceholderReferencePath(input.referencedPath) ||
    isCreateInstructionForCandidate(input.line, input.candidate) ||
    await isIntentionalEnvReference(input.workingDir, input.referencedPath, input.options) ||
    await isCopyInstructionToCandidate(
      input.workingDir,
      input.sourcePath,
      input.line,
      input.candidate,
      input.candidates,
    )
  );
}

/**
 * Deterministically find references to file names that were truly deleted or
 * renamed in the uncommitted diff. A same-basename path elsewhere in the repo
 * is treated as a move and skipped; a git rename to a different basename is
 * not treated as a move.
 */
export async function findDeletedOrRenamedFileReferenceIssuesCancellable(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<DeletedOrRenamedFileReferenceIssue[]> {
  const context = await getFilenameReferenceScanContext(workingDir, options);
  return findDeletedOrRenamedFileReferenceIssuesFromContext(workingDir, context, options);
}

async function getFilenameReferenceScanContext(
  workingDir: string,
  options: CancellationOptions,
): Promise<FilenameReferenceScanContext> {
  const nameStatus = await runGit(["diff", "--name-status", "--find-renames", "HEAD"], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  return {
    changes: parseDeletedOrRenamedChanges(nameStatus.output || ""),
    inventory: await getGitVisibleFileInventoryCancellable(workingDir, options),
  };
}

async function findDeletedOrRenamedFileReferenceIssuesFromContext(
  workingDir: string,
  context: FilenameReferenceScanContext,
  options: CancellationOptions,
): Promise<DeletedOrRenamedFileReferenceIssue[]> {
  const { changes, inventory } = context;
  if (changes.length === 0) return [];

  const files = inventory.files.map((file) => file.path);
  const deletedReferenceSourcePaths = new Set(changes.map((change) => change.oldPath));
  const issues: DeletedOrRenamedFileReferenceIssue[] = [];

  for (const change of changes) {
    throwIfAborted(options.signal);
    const references = await findReferencesToDeletedOrRenamedPath(
      workingDir,
      files.filter((relativePath) =>
        !deletedReferenceSourcePaths.has(relativePath) && !isScenarioFixturePath(relativePath)
      ),
      change.oldPath,
      change.oldBasename,
      options,
    );
    if (references.length > 0) {
      issues.push({ ...change, references });
    }
  }

  return issues;
}

export async function findNonexistentFileReferenceIssuesCancellable(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<NonexistentFileReferenceIssue[]> {
  const context = await getFilenameReferenceScanContext(workingDir, options);
  return findNonexistentFileReferenceIssuesFromContext(workingDir, context, options);
}

async function findNonexistentFileReferenceIssuesFromContext(
  workingDir: string,
  context: FilenameReferenceScanContext,
  options: CancellationOptions,
): Promise<NonexistentFileReferenceIssue[]> {
  const deletedOrRenamedOldPaths = new Set(context.changes.map((change) => change.oldPath));
  const issuesByReferencedPath = new Map<string, NonexistentFileReferenceIssue>();
  const seenReferences = new Set<string>();

  for (const file of context.inventory.files) {
    throwIfAborted(options.signal);
    if (shouldIgnoreFilenameReferenceScanPath(file.path) || deletedOrRenamedOldPaths.has(file.path)) continue;

    const content = await readWorkingTreeText(workingDir, file.path);
    if (content === undefined) continue;

    const lines = content.split("\n");
    let inMarkdownFence = false;
    for (let i = 0; i < lines.length; i++) {
      throwIfAborted(options.signal);
      if (scansMarkdownFences(file.path) && isMarkdownFenceLine(lines[i])) {
        inMarkdownFence = !inMarkdownFence;
        continue;
      }
      if (inMarkdownFence) continue;

      const candidates = findPathReferenceCandidates(lines[i]);
      for (const candidate of candidates) {
        const referencedPath = resolveReferencedPath(file.path, candidate.rawPath);
        if (
          !referencedPath ||
          deletedOrRenamedOldPaths.has(referencedPath) ||
          isGeneratedReferencePath(referencedPath)
        ) continue;
        if (await referenceCandidateExists(workingDir, referencedPath, candidate)) continue;
        if (await shouldSuppressNonexistentReference({
          workingDir,
          sourcePath: file.path,
          line: lines[i],
          referencedPath,
          candidate,
          candidates,
          options,
        })) continue;

        const reference = {
          path: file.path,
          line: i + 1,
          text: lines[i].trim(),
        };
        const referenceKey = `${referencedPath}\0${reference.path}\0${reference.line}\0${reference.text}`;
        if (seenReferences.has(referenceKey)) continue;
        seenReferences.add(referenceKey);

        const issue = issuesByReferencedPath.get(referencedPath) ?? {
          referencedPath,
          references: [],
        };
        issue.references.push(reference);
        issuesByReferencedPath.set(referencedPath, issue);
      }
    }
  }

  return [...issuesByReferencedPath.values()].sort((a, b) =>
    a.referencedPath.localeCompare(b.referencedPath)
  );
}

export async function findFilenameReferenceDiagnosticsCancellable(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<FilenameReferenceDiagnostics> {
  const context = await getFilenameReferenceScanContext(workingDir, options);
  const deletedOrRenamedIssues = await findDeletedOrRenamedFileReferenceIssuesFromContext(
    workingDir,
    context,
    options,
  );
  const nonexistentIssues = await findNonexistentFileReferenceIssuesFromContext(
    workingDir,
    context,
    options,
  );
  return { deletedOrRenamedIssues, nonexistentIssues };
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

async function buildUntrackedDiffForFiles(
  workingDir: string,
  files: string[],
  options: CancellationOptions,
): Promise<string> {
  let untrackedDiff = "";
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
      maxStderrBytes: 0,
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
  return untrackedDiff;
}

async function getVirtualNormalizedTrackedDiff(
  workingDir: string,
  moves: NormalizedMoveSummary[],
  options: CancellationOptions,
): Promise<string | undefined> {
  if (moves.length === 0) return undefined;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "af-git-index-"));
  const indexPath = path.join(tempDir, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const realIndex = await runGit(["rev-parse", "--git-path", "index"], workingDir, {
      ...options,
      maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    if (realIndex.exitCode === 0 && realIndex.output.trim()) {
      await fs.promises.copyFile(path.resolve(workingDir, realIndex.output.trim()), indexPath);
    } else {
      const readTree = await runGit(["read-tree", "HEAD"], workingDir, {
        ...options,
        env,
        maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
        maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      });
      if (readTree.exitCode !== 0) return undefined;
    }

    const addTracked = await runGit(["add", "-u"], workingDir, {
      ...options,
      env,
      maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    if (addTracked.exitCode !== 0) return undefined;

    const addMoved = await runGit(["add", "--", ...moves.map((move) => move.newPath)], workingDir, {
      ...options,
      env,
      maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    if (addMoved.exitCode !== 0) return undefined;

    const diff = await runGit(["diff", "--cached", "--find-renames", "HEAD"], workingDir, {
      ...options,
      env,
      maxStdoutBytes: DEFAULT_GIT_DIFF_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    return diff.output || "";
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeStatusForVirtualMoves(
  status: string,
  moves: NormalizedMoveSummary[],
): string {
  if (moves.length === 0) return status;
  const deletedPaths = new Set(moves.map((move) => move.oldPath));
  const newPaths = new Set(moves.map((move) => move.newPath));
  const remaining = status
    .split("\n")
    .filter((line) => {
      if (!line) return false;
      const porcelainPath = line.slice(3);
      const renameDestination = porcelainPath.includes(" -> ")
        ? porcelainPath.slice(porcelainPath.indexOf(" -> ") + " -> ".length)
        : "";
      const renameSource = porcelainPath.includes(" -> ")
        ? porcelainPath.slice(0, porcelainPath.indexOf(" -> "))
        : "";
      if (renameSource && deletedPaths.has(renameSource)) {
        return false;
      }
      if (renameDestination && newPaths.has(renameDestination)) {
        return false;
      }
      if ((line.startsWith(" D ") || line.startsWith("D  ")) && deletedPaths.has(porcelainPath)) {
        return false;
      }
      if ((line.startsWith(" A ") || line.startsWith("A  ")) && newPaths.has(porcelainPath)) {
        return false;
      }
      if (line.startsWith("?? ") && newPaths.has(porcelainPath)) {
        return false;
      }
      return true;
    });
  return [
    ...remaining,
    ...moves.map((move) => `R  ${move.oldPath} -> ${move.newPath}`),
  ].join("\n");
}

function resolvePreparedNormalizedMovesForRepo(
  repoPath: string,
  options: GitChangeCollectionOptions,
): NormalizedMoveSummary[] | undefined {
  return options.preparedNormalizedMovesByRepo
    ?.find((entry) => entry.repoPath === repoPath)
    ?.moves
    ?? options.preparedNormalizedMoves;
}

/**
 * Cancellable async variant of getUncommittedChanges for MCP request paths.
 */
export async function getUncommittedChangesCancellable(
  workingDir: string,
  options: GitChangeCollectionOptions = {}
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
  const untrackedFiles = await runGit(["ls-files", "--others", "--exclude-standard"], workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });

  const files = splitGitLines(untrackedFiles.output || "");
  let normalizedMoves: NormalizedMoveSummary[] = [];
  let normalizedTrackedDiff: string | undefined;
  let untrackedFilesForDiff = files;

  if (options.normalizeMovedRecreated) {
    if (options.preparedNormalizedMoves) {
      normalizedMoves = options.preparedNormalizedMoves;
    } else {
      const deletedResult = await runGit(["diff", "--name-only", "--diff-filter=D", "HEAD"], workingDir, {
        ...options,
        maxStdoutBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
        maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
      });
      const moveDetection = await detectMovedRecreatedFilesFromPathsCancellable(
        workingDir,
        splitGitLines(deletedResult.output || ""),
        files,
        options,
      );
      normalizedMoves = moveDetection.moves;
    }
    normalizedTrackedDiff = await getVirtualNormalizedTrackedDiff(workingDir, normalizedMoves, options);
    if (normalizedTrackedDiff !== undefined) {
      const normalizedNewPaths = new Set(normalizedMoves.map((move) => move.newPath));
      untrackedFilesForDiff = files.filter((file) => !normalizedNewPaths.has(file));
    } else {
      normalizedMoves = [];
    }
  }
  let trackedDiff = "";
  if (normalizedTrackedDiff === undefined) {
    const result = await runGit(["diff", "HEAD"], workingDir, {
      ...options,
      maxStdoutBytes: DEFAULT_GIT_DIFF_MAX_BYTES,
      maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
    });
    trackedDiff = result.output || "";
  }
  const untrackedDiff = await buildUntrackedDiffForFiles(workingDir, untrackedFilesForDiff, options);

  return {
    status: normalizeStatusForVirtualMoves(status.output || "", normalizedMoves),
    diff: (normalizedTrackedDiff ?? trackedDiff) + untrackedDiff,
    diffStat: diffStat.output || "",
    untrackedDiff,
    normalizedMoves,
  };
}

function countTextLines(content: string): number {
  if (!content) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function formatGitVisibleInventory(inventory: GitVisibleFileInventory): string {
  const fileLines = inventory.files
    .map((file) => `${file.path} (${file.lines} lines)`)
    .join("\n");
  return `Files: ${inventory.totalFiles}
Text lines: ${inventory.totalLines}
Skipped binary files: ${inventory.skippedBinary}
Skipped unreadable files: ${inventory.skippedUnreadable}

GIT-VISIBLE FILE INVENTORY:
${fileLines || "(none)"}`;
}

export async function getGitVisibleFileInventoryCancellable(
  workingDir: string,
  options: CancellationOptions & { includeUntracked?: boolean } = {},
): Promise<GitVisibleFileInventory> {
  const lsArgs = options.includeUntracked === false
    ? ["ls-files", "--cached", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const lsFiles = await runGit(lsArgs, workingDir, {
    ...options,
    maxStdoutBytes: DEFAULT_GIT_FILE_LIST_MAX_BYTES,
    maxStderrBytes: DEFAULT_GIT_STATUS_MAX_BYTES,
  });
  if ((lsFiles.output || "").includes("[agent-framework: stdout truncated after")) {
    throw new Error(
      `git-visible file inventory exceeded ${DEFAULT_GIT_FILE_LIST_MAX_BYTES} bytes; cannot compute reliable fullconfirm line count.`,
    );
  }
  const paths = (lsFiles.output || "").split("\0").filter(Boolean).sort();
  const files: GitVisibleFileEntry[] = [];
  let skippedBinary = 0;
  let skippedUnreadable = 0;

  for (const relativePath of paths) {
    throwIfAborted(options.signal);
    try {
      const absolutePath = path.join(workingDir, relativePath);
      const stat = await fs.promises.stat(absolutePath);
      if (!stat.isFile()) continue;
      const buffer = await fs.promises.readFile(absolutePath);
      if (buffer.includes(0)) {
        skippedBinary += 1;
        continue;
      }
      files.push({ path: relativePath, lines: countTextLines(buffer.toString("utf-8")) });
    } catch {
      skippedUnreadable += 1;
    }
  }

  return {
    files,
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    skippedBinary,
    skippedUnreadable,
  };
}

export function formatFullScopeContextForRepos(repos: RepoFullScopeContext[]): string {
  if (repos.length === 0) {
    return `FULLCONFIRM SCOPE:
(no git-visible repositories found)`;
  }

  return repos.map((repo) => `=== REPOSITORY: ${formatRepoHeading(repo)} ===

FULLCONFIRM SCOPE:
Review the whole git-visible repository. Gitignored files are not the focus, but may be inspected if relevant. File contents are intentionally not embedded here; use read/search tools to inspect relevant code.

${formatGitVisibleInventory(repo.inventory)}`).join("\n\n");
}

export async function getRepoFullScopeContextsCancellable(
  repos: Array<{ path: string; name: string }>,
  options: CancellationOptions = {},
): Promise<{ repos: RepoFullScopeContext[]; context: string; totalLines: number }> {
  const contexts: RepoFullScopeContext[] = [];
  for (const repo of repos) {
    throwIfAborted(options.signal);
    contexts.push({
      ...repo,
      inventory: await getGitVisibleFileInventoryCancellable(repo.path, {
        ...options,
        includeUntracked: false,
      }),
    });
  }
  return {
    repos: contexts,
    context: formatFullScopeContextForRepos(contexts),
    totalLines: contexts.reduce((sum, repo) => sum + repo.inventory.totalLines, 0),
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
  options: GitChangeCollectionOptions = {},
): Promise<RepoGitContext[]> {
  const contexts: RepoGitContext[] = [];
  for (const repo of repos) {
    throwIfAborted(options.signal);
    contexts.push({
      ...repo,
      changes: await getUncommittedChangesCancellable(repo.path, {
        ...options,
        preparedNormalizedMoves: resolvePreparedNormalizedMovesForRepo(repo.path, options),
      }),
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
  options: GitChangeCollectionOptions = {},
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
  options: GitChangeCollectionOptions = {},
): Promise<{ current: RepoGitContext; siblingOverview: string }> {
  const sortedRepos = sortReposWithChangesSubmodulesFirst(repoInfo);
  const currentRepo = sortedRepos.find((repo) => repo.path === workingDir)
    ?? { path: workingDir, name: path.basename(workingDir) };
  const currentChanges = await getUncommittedChangesCancellable(currentRepo.path, {
    ...options,
    preparedNormalizedMoves: resolvePreparedNormalizedMovesForRepo(currentRepo.path, options),
  });
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
