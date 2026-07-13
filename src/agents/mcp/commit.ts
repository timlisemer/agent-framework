/**
 * Commit Agent - Git Commit with Quality Gate
 *
 * This agent generates commit messages and executes git commits, but only
 * after changes pass the confirm agent quality gate.
 *
 * ## FLOW
 *
 * 1. Pre-check: Skip if nothing to commit
 * 2. Normalize moved+recreated files into Git-recognized moves
 * 3. Run confirm agent (quality gate)
 * 4. If DECLINED, return immediately
 * 5. Generate commit message via unified runner
 * 6. Execute git add -A && git commit
 * 7. Return result with commit hash
 *
 * ## MESSAGE FORMAT
 *
 * Messages are sized based on diff stats:
 * - SMALL (1-3 files, <50 lines): Single lowercase line
 * - MEDIUM (4-10 files or 50-200 lines): Single line with scope prefix
 * - LARGE (10+ files or 200+ lines): Title + bullet points
 *
 * @module commit
 */

import { EXECUTION_TYPES } from "../../types.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runAgent } from "../../utils/agent-runner.js";
import { COMMIT_AGENT } from "../../utils/agent-configs.js";
import { parseCompleteGitNulRecords } from "../../utils/git-status.js";
import { runGitCancellable as runGit } from "../../utils/git-process.js";
import {
  getUncommittedChangesCancellable,
  classifyCommitSize,
  detectMovedRecreatedFilesCancellable,
  type NormalizedMoveSummary,
  type RepoNormalizedMoveSummary,
  type RepoInfo,
} from "../../utils/git-utils.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import { confirmResultFailed, runConfirmAgent } from "./confirm.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import { clipUtf8Bytes } from "../../utils/text-bounds.js";

import { activeSpec } from "../../adapter/spec.js";
function getHookName(): string { return activeSpec().mcpWireName("commit"); }

type CommitOptions = CancellationOptions & {
  repoScope?: { mode: "single"; repoInfo?: RepoInfo };
};

export async function prepareCommitConfirmContext(
  repos: Array<{ path: string }>,
  extraContext: string | undefined,
  options: CancellationOptions = {},
): Promise<{
  extraContext: string | undefined;
  moves: NormalizedMoveSummary[];
  movesByRepo: RepoNormalizedMoveSummary[];
  error?: string;
}> {
  const moves: NormalizedMoveSummary[] = [];
  const movesByRepo: RepoNormalizedMoveSummary[] = [];
  const stagedByRepo: PreparedMoveIndexSnapshot[] = [];
  for (const repo of repos) {
    throwIfAborted(options.signal);
    const normalized = await normalizeMovedRecreatedFilesForCommit(repo.path, options);
    if (normalized.error) {
      await rollbackPreparedMoveStaging(stagedByRepo, options);
      return { extraContext, moves, movesByRepo, error: normalized.error };
    }
    moves.push(...normalized.moves);
    movesByRepo.push({ repoPath: repo.path, moves: normalized.moves });
    if (normalized.stagedPaths.length > 0) {
      stagedByRepo.push(normalized.indexSnapshot);
    }
  }
  return {
    extraContext,
    moves,
    movesByRepo,
  };
}

async function normalizeMovedRecreatedFilesForCommit(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<{ moves: NormalizedMoveSummary[]; stagedPaths: string[]; indexSnapshot: PreparedMoveIndexSnapshot; error?: string }> {
  const result = await detectMovedRecreatedFilesCancellable(workingDir, options);
  if (result.moves.length === 0) {
    return { moves: [], stagedPaths: [], indexSnapshot: { repoPath: workingDir, paths: [], cachedPatch: "" } };
  }

  throwIfAborted(options.signal);
  const paths = result.moves.flatMap((move) => [move.oldPath, move.newPath]);
  const indexSnapshot = await snapshotPreparedMoveIndex(workingDir, paths, options);
  const oldPaths = result.moves.map((move) => move.oldPath);
  const indexedOldPaths = await getIndexedPaths(workingDir, oldPaths, options);
  if (indexedOldPaths.error) {
    return {
      moves: result.moves,
      stagedPaths: [],
      indexSnapshot,
      error: `ERROR: Failed to inspect moved files before confirm: ${indexedOldPaths.error}`,
    };
  }
  // An already-staged deletion is absent from the index and no longer matches
  // an exact `git add` pathspec. Its deletion is already prepared, so only add
  // old paths that remain in the index plus every untracked destination.
  const stagedPaths = [
    ...oldPaths.filter((oldPath) => indexedOldPaths.paths.has(oldPath)),
    ...result.moves.map((move) => move.newPath),
  ];
  const add = await runGit(["add", "-A", "--", ...stagedPaths], workingDir, options);
  if (add.exitCode !== 0) {
    await rollbackPreparedMoveStaging([indexSnapshot], options);
    return {
      moves: result.moves,
      stagedPaths: [],
      indexSnapshot,
      error: `ERROR: Failed to normalize moved files before confirm: ${add.output}`,
    };
  }
  return { moves: result.moves, stagedPaths, indexSnapshot };
}

async function getIndexedPaths(
  workingDir: string,
  paths: string[],
  options: CancellationOptions,
): Promise<{ paths: Set<string>; error?: string }> {
  const result = await runGit(["ls-files", "--cached", "-z", "--", ...paths], workingDir, options);
  try {
    return {
      paths: new Set(parseCompleteGitNulRecords(result, "indexed-path inventory")),
    };
  } catch (error) {
    return { paths: new Set(), error: error instanceof Error ? error.message : String(error) };
  }
}

type PreparedMoveIndexSnapshot = {
  repoPath: string;
  paths: string[];
  cachedPatch: string;
};

async function snapshotPreparedMoveIndex(
  workingDir: string,
  paths: string[],
  options: CancellationOptions,
): Promise<PreparedMoveIndexSnapshot> {
  const diff = await runGit(["diff", "--cached", "--binary", "--", ...paths], workingDir, options);
  return {
    repoPath: workingDir,
    paths,
    cachedPatch: diff.output || "",
  };
}

async function rollbackPreparedMoveStaging(
  repos: PreparedMoveIndexSnapshot[],
  options: CancellationOptions,
): Promise<void> {
  for (const repo of repos.reverse()) {
    throwIfAborted(options.signal);
    if (repo.paths.length === 0) continue;
    await runGit(["restore", "--staged", "--", ...repo.paths], repo.repoPath, options);
    if (!repo.cachedPatch.trim()) continue;
    const patchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "af-index-rollback-"));
    const patchPath = path.join(patchDir, "cached.patch");
    try {
      await fs.promises.writeFile(patchPath, repo.cachedPatch, "utf-8");
      await runGit(["apply", "--cached", "--whitespace=nowarn", patchPath], repo.repoPath, options);
    } finally {
      await fs.promises.rm(patchDir, { recursive: true, force: true });
    }
  }
}

/**
 * Parse the LLM response to extract size and message.
 */
function parseCommitResponse(
  response: string
): { size: string; message: string } | null {
  const sizeMatch = response.match(/SIZE:\s*(SMALL|MEDIUM|LARGE)/i);
  if (!sizeMatch) return null;

  const size = sizeMatch[1].toUpperCase();
  // Capture everything after MESSAGE: to the end, allowing blank lines in LARGE commits
  const messageMatch = response.match(/MESSAGE:\s*\n([\s\S]+)$/);
  let message = messageMatch ? messageMatch[1].trim() : "";

  if (!message) {
    const fallbackMatch = response.match(/MESSAGE:\s*([\s\S]+)$/);
    message = fallbackMatch ? fallbackMatch[1].trim() : "";
  }

  if (!message) return null;
  return { size, message };
}

async function commitWithConfirmResult(
  workingDir: string,
  confirmResult: string,
  sharedCommitContext: string | undefined,
  options: CancellationOptions = {},
): Promise<string> {
  const {
    status,
    diff,
    diffStat,
    untrackedDiff,
    untrackedInventory,
    untrackedLinesChanged,
    untrackedContentDiff,
  } = await getUncommittedChangesCancellable(workingDir, {
    ...options,
    untrackedContentSourceMaxBytes: 8000,
  });

  if (!status.trim()) {
    return "SKIPPED: nothing to commit";
  }

  if (confirmResultFailed(confirmResult)) {
    return confirmResult;
  }

  // TS-side size classification (folds in untracked-file accounting). The LLM
  // still emits a SIZE: line per its prompt format; we override the parsed
  // value with the TS-authoritative classification before returning.
  const tsSize = classifyCommitSize(diffStat, untrackedDiff, status, untrackedLinesChanged);
  const boundSection = (value: string, maxBytes: number): string => clipUtf8Bytes(
    value,
    maxBytes,
    "\n... (truncated)",
    1,
  );
  const trackedDiff = untrackedInventory && diff.endsWith(`\n${untrackedInventory}`)
    ? diff.slice(0, -(untrackedInventory.length + 1))
    : diff;
  const commitDiffContext = [
    `TRACKED CHANGES:\n${boundSection(trackedDiff, 2400)}`,
    untrackedInventory
      ? `UNTRACKED FILE INVENTORY:\n${boundSection(untrackedInventory, 1600)}`
      : "",
    untrackedContentDiff
      ? `UNTRACKED SOURCE EXCERPT:\n${boundSection(untrackedContentDiff, 3600)}`
      : "",
  ].filter(Boolean).join("\n\n");

  // Generate commit message
  const result = await runAgent(
    { ...COMMIT_AGENT, workingDir },
    {
      prompt: "Generate a commit message based on the analysis and stats below.",
      context: `CONFIRM AGENT ANALYSIS:
${confirmResult}${sharedCommitContext ? `\n\n${sharedCommitContext}` : ""}

---

PRECOMPUTED SIZE: ${tsSize.size} (${tsSize.filesChanged} files, ${tsSize.linesChanged} lines)

DIFF STATS:
${diffStat}

DIFF (for context):
${commitDiffContext}`,
    },
    options
  );

  const parsed = parseCommitResponse(result.output);

  if (!parsed || !parsed.message) {
    logAgentResult(result, {
      agent: "commit",
      hookName: getHookName(),
      toolName: getHookName(),
      workingDir,
      executionType: EXECUTION_TYPES.LLM,
      decisionOverride: "ERROR",
      decisionReason: "Failed to parse commit message",
    });
    return `ERROR: Failed to parse commit message from LLM response: ${result.output}`;
  }

  // TS authoritative on size — override whatever the LLM emitted.
  parsed.size = tsSize.size;

  // Execute the commit. Use argv-based git calls so shell-active commit
  // message text like backticks, $(), or <proposed_plan> stays literal.
  throwIfAborted(options.signal);
  const add = await runGit(["add", "-A"], workingDir, options);
  if (add.exitCode !== 0) {
    logAgentResult(result, {
      agent: "commit",
      hookName: getHookName(),
      toolName: getHookName(),
      workingDir,
      executionType: EXECUTION_TYPES.LLM,
      decisionOverride: "ERROR",
      decisionReason: `Git add failed: ${add.output}`,
    });
    return `ERROR: Git add failed: ${add.output}`;
  }

  throwIfAborted(options.signal);
  const commit = await runGit(["commit", "-m", parsed.message], workingDir, options);

  if (commit.exitCode !== 0) {
    logAgentResult(result, {
      agent: "commit",
      hookName: getHookName(),
      toolName: getHookName(),
      workingDir,
      executionType: EXECUTION_TYPES.LLM,
      decisionOverride: "ERROR",
      decisionReason: `Commit failed: ${commit.output}`,
    });
    return `ERROR: Commit failed: ${commit.output}`;
  }

  throwIfAborted(options.signal);
  const hashResult = await runGit(["rev-parse", "--short", "HEAD"], workingDir, options);
  const hash = hashResult.output.trim();

  throwIfAborted(options.signal);
  logAgentResult(result, {
    agent: "commit",
    hookName: getHookName(),
    toolName: getHookName(),
    workingDir,
    executionType: EXECUTION_TYPES.LLM,
    decisionOverride: "CONFIRM",
    decisionReason: `Committed: ${hash}`,
  });

  return `${confirmResult}\n\nSIZE: ${parsed.size}\n${parsed.message}\nHASH: ${hash}`;
}

export async function runCommitAgentWithSharedConfirm(
  workingDir: string,
  confirmResult: string,
  sharedCommitContext?: string,
  options: CancellationOptions = {},
): Promise<string> {
  logAgentStarted("commit", getHookName());
  return commitWithConfirmResult(workingDir, confirmResult, sharedCommitContext, options);
}

/**
 * Run the commit agent to generate and execute a git commit.
 *
 * @param workingDir - The project directory to commit
 * @param confirmTierName - Passed through to confirm agent (does not affect commit agent tier)
 * @param confirmExtraContext - Passed through to confirm agent
 * @param optionalPlanfile - Optional explicit planfile path passed through to confirm
 * @returns Result with confirm output, message size, and commit hash
 */
export async function runCommitAgent(
  workingDir: string,
  confirmTierName?: string,
  confirmExtraContext?: string,
  optionalPlanfile?: string,
  options: CommitOptions = {}
): Promise<string> {
  logAgentStarted("commit", getHookName());

  const { status } = await getUncommittedChangesCancellable(workingDir, options);

  if (!status.trim()) {
    return "SKIPPED: nothing to commit";
  }

  throwIfAborted(options.signal);
  const preparedConfirm = await prepareCommitConfirmContext(
    [{ path: workingDir }],
    confirmExtraContext,
    options,
  );
  if (preparedConfirm.error) {
    return preparedConfirm.error;
  }

  // Confirm changes before generating commit message (pass through tier/context)
  throwIfAborted(options.signal);
  const confirmResult = await runConfirmAgent(
    workingDir,
    confirmTierName,
    preparedConfirm.extraContext,
    optionalPlanfile,
    { ...options, preparedNormalizedMoves: preparedConfirm.moves }
  );
  if (confirmResultFailed(confirmResult)) {
    // Preserve confirm output verbatim so check and planfile failures keep
    // their concrete error list instead of collapsing to a vague summary.
    return confirmResult;
  }

  return commitWithConfirmResult(workingDir, confirmResult, undefined, options);
}
