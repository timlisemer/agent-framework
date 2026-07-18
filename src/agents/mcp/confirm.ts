/**
 * Confirm Agent - Code Quality Gate with Autonomous Investigation
 *
 * This agent evaluates code changes for quality, security, and documentation.
 * Confirm uses SDK-mode reviewers with read/search tools for autonomous code
 * investigation, then merges their results with a direct aggregator.
 *
 * ## FLOW
 *
 * 1. Run check agent first (linter/type-check must pass)
 * 2. If check fails, return check output verbatim
 * 3. Gather git status and diff
 * 4. Run general, deduplication, and pattern SDK reviewers with investigation capabilities
 * 5. Return verdict (CONFIRMED or DECLINED)
 *
 * @module confirm
 */

import * as fs from "fs";
import * as path from "path";
import { EXECUTION_TYPES, parseTierName } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import {
  CONFIRM_AGENT,
  CONFIRM_AGGREGATOR_AGENT,
  CONFIRM_PATTERN_AGENT,
  CONFIRM_SPECIALIST_AGENT,
} from "../../utils/agent-configs.js";
import {
  formatGitContextForRepos,
  allReposInScope,
  getRepoFullScopeContextsCancellable,
  getAllReposGitContextCancellable,
  getSingleRepoGitContextWithSiblingOverviewCancellable,
  getUncommittedChangesCancellable,
  countUnifiedDiffChangedLines,
  REVIEW_CONTEXT_REDUCTION_LIMITS,
  type NormalizedMoveSummary,
  type RepoNormalizedMoveSummary,
  type RepoInfo,
  type GitChanges,
  type RepoGitContext,
} from "../../utils/git-utils.js";
import { formatGitPathForContext, parsePorcelainStatusLine } from "../../utils/git-status.js";
import { logAgentResult } from "../../utils/logger.js";
import {
  findDeduplicationUserRequirement,
  runConfirmPrefilter,
  formatConfirmPrefilter,
  selectConfirmPrefilterCandidateLines,
} from "../../utils/confirm-prefilter.js";
import { getAgentFrameworkSessionDir, readSessionTranscriptPath } from "../../utils/paths.js";
import { readRecentUserMessagesArray } from "../../utils/transcript.js";
import { runCheckAgent } from "./check.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import { parseCheckAgentResult } from "../../utils/check-result.js";
import { resetCanonicalDriftWindow } from "./drift-window.js";
import { canonicalHookRunIdForSession } from "../../entrypoints/host-run-id.js";
import { clipUtf8Bytes } from "../../utils/text-bounds.js";
import { readPlanFileContent, resolveCanonicalCurrentPlanSource } from "../../utils/plan-source.js";

import { activeSpec } from "../../adapter/spec.js";
function getHookName(scopeKind: ConfirmReviewScopeKind = "uncommitted"): string {
  return activeSpec().mcpWireName(scopeKind === "full" ? "fullconfirm" : "confirm");
}

const CONFIRM_DEDUPLICATION_PROMPT_EXTENSION = `## REQUIRED CATEGORY UPDATE: Deduplication

This update supersedes any earlier category count or Results list in the base prompt.

Add this category between Security and Documentation:

### Deduplication
Evaluate the diff and nearby code for:
- Obvious duplicate code that should be shared
- Missed chances to use an existing helper
- Missed chances to create a helper or generic utility for repeated logic
- New helpers that are very similar to existing helpers
- New helpers placed outside the project's obvious helper location without a clear reason
- Missed opportunities for generic code when the local pattern clearly calls for reusable code

When the provided context includes a DEDUPLICATION USER REQUIREMENT block and the code under review clearly does not satisfy it, Deduplication MUST FAIL. In the Deduplication failure reason and in the DECLINED verdict, quote the exact user wording from that block, then state exactly which changed code violates it.

The Results section must include exactly these six categories:
- Files: PASS or FAIL (<brief reason if FAIL>)
- Code Quality: PASS or FAIL (<brief reason if FAIL>)
- Security: PASS or FAIL (<brief reason if FAIL>)
- Deduplication: PASS or FAIL (<brief reason if FAIL>)
- Documentation: PASS or FAIL (<brief reason if FAIL>)
- Tests: PASS or FAIL (<brief reason if FAIL>)

Every FAIL, including Deduplication, must be expanded in ## Concrete Findings with category, file/function/helper where available, exact bad behavior, supporting evidence from changed or existing code, and concrete remediation. Every warning must be expanded in ## Warnings and is non-blocking by itself.

All six categories must PASS for CONFIRMED. Any FAIL means DECLINED.`;

const CONFIRM_FORMAT_FALLBACK = `## Results
- Files: UNKNOWN
- Code Quality: UNKNOWN
- Security: UNKNOWN
- Deduplication: UNKNOWN
- Documentation: UNKNOWN
- Tests: UNKNOWN

## Concrete Findings
- Agent returned malformed output; rerun confirm to get concrete findings.

## Verdict
DECLINED: Agent returned malformed output

## Raw Output
$RAW`;

const CONFIRM_TRACKED_DIFF_PROMPT_MAX_BYTES = 512 * 1024;
const CONFIRM_FILE_DIFF_PROMPT_MAX_BYTES = 48 * 1024;
const CONFIRM_UNTRACKED_INVENTORY_PROMPT_MAX_BYTES = 96 * 1024;

function summarizeDiffSection(section: string): string {
  const lines = section.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  const header = lines.slice(0, firstHunk < 0 ? Math.min(lines.length, 6) : firstHunk).join("\n");
  const changedLines = countUnifiedDiffChangedLines(section);
  const bytes = Buffer.byteLength(section, "utf8");
  return `${header}\n[agent-framework: diff body omitted from the initial prompt (${changedLines} changed lines, ${bytes} bytes); inspect this file and Git history with read/search tools]`;
}

export function compactUnifiedDiffForConfirmPrompt(diff: string): string {
  if (Buffer.byteLength(diff, "utf8") <= CONFIRM_TRACKED_DIFF_PROMPT_MAX_BYTES) return diff;

  const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const perFileCompacted = sections.map((section) =>
    Buffer.byteLength(section, "utf8") > CONFIRM_FILE_DIFF_PROMPT_MAX_BYTES
      ? summarizeDiffSection(section)
      : section
  );
  const compacted = perFileCompacted.join("");
  if (Buffer.byteLength(compacted, "utf8") <= CONFIRM_TRACKED_DIFF_PROMPT_MAX_BYTES) {
    return compacted;
  }

  const summaries = sections.map(summarizeDiffSection).join("\n");
  return clipUtf8Bytes(
    summaries,
    CONFIRM_TRACKED_DIFF_PROMPT_MAX_BYTES,
    "\n[agent-framework: additional diff summaries omitted from the initial prompt; the complete file scope remains in GIT STATUS and is available through read/search tools]\n",
  );
}

function compactGitChangesForConfirmPrompt(changes: GitChanges): GitChanges {
  const inventory = changes.untrackedInventory ?? "";
  const inventorySuffix = inventory && changes.diff.endsWith(`\n${inventory}`)
    ? `\n${inventory}`
    : "";
  const trackedDiff = inventorySuffix
    ? changes.diff.slice(0, -inventorySuffix.length)
    : changes.diff;
  const compactInventory = inventorySuffix
    ? `\n${clipUtf8Bytes(
        inventory,
        CONFIRM_UNTRACKED_INVENTORY_PROMPT_MAX_BYTES,
        "\n[agent-framework: untracked inventory clipped; the complete path scope remains in GIT STATUS]\n",
      )}`
    : "";
  return {
    ...changes,
    diff: `${compactUnifiedDiffForConfirmPrompt(trackedDiff)}${compactInventory}`,
  };
}

export function formatCheckFailure(checkResult: string, errorCount: number): string {
  void errorCount;
  return checkResult;
}

export function confirmResultFailed(result: string): boolean {
  return result.includes("DECLINED")
    || result.startsWith("ERROR:")
    || /-\s*Status:\s*FAIL\b/i.test(result)
    || /\bStatus:\s*FAIL\b/i.test(result);
}

type ConfirmPlanfileResolution =
  | { kind: "found"; path: string; content: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

type ConfirmSessionContext = {
  sessionDir?: string;
};

type ConfirmRepoScope =
  | { mode: "single"; repoInfo?: RepoInfo }
  | { mode: "all"; repoInfo: RepoInfo };

type ConfirmOptions = CancellationOptions & {
  repoScope?: ConfirmRepoScope;
  preparedNormalizedMoves?: NormalizedMoveSummary[];
  preparedNormalizedMovesByRepo?: RepoNormalizedMoveSummary[];
};

type ConfirmReviewScopeKind = "uncommitted" | "full";

type ConfirmReviewContext = {
  prompt: string;
  context: string;
  status: string;
  diff: string;
  lineCount: number;
  normalizedMoves: NormalizedMoveSummary[];
  deletionContexts: Array<{
    repoPath: string;
    status: string;
    normalizedMoves: NormalizedMoveSummary[];
  }>;
  untrackedMatchedLineDiff: string;
  untrackedOmittedMatchedLines: Array<{ repoPath: string; path: string; count: number }>;
};

async function readPlanfileForConfirm(planPath: string): Promise<ConfirmPlanfileResolution> {
  try {
    const content = await fs.promises.readFile(planPath, "utf-8");
    if (!content.trim()) {
      return {
        kind: "error",
        message: `ERROR: optional_planfile was provided but the planfile is empty: ${planPath}`,
      };
    }
    return { kind: "found", path: planPath, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      message: `ERROR: optional_planfile was provided but could not be read: ${planPath}: ${message}`,
    };
  }
}

function resolveConfirmSessionContext(workingDir: string): ConfirmSessionContext {
  try {
    const sessionDir = getAgentFrameworkSessionDir({ projectDir: workingDir });
    return { sessionDir };
  } catch {
    return {};
  }
}

async function resolveConfirmPlanfile(
  workingDir: string,
  sessionDir: string | undefined,
  optionalPlanfile?: string,
): Promise<ConfirmPlanfileResolution> {
  if (optionalPlanfile !== undefined) {
    const explicit = optionalPlanfile.trim();
    if (!explicit) {
      return {
        kind: "error",
        message: "ERROR: optional_planfile was provided but the planfile path is empty.",
      };
    }
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(workingDir, explicit);
    return readPlanfileForConfirm(resolved);
  }

  if (sessionDir) {
    const current = await resolveCanonicalCurrentPlanSource(sessionDir);
    if (current) {
      const content = await readPlanFileContent(current.path).catch(() => null);
      if (content?.trim()) return { kind: "found", path: current.path, content };
    }
  }
  return { kind: "missing" };
}

function formatPlanfileContext(planfile: ConfirmPlanfileResolution): string {
  if (planfile.kind === "found") {
    return `PLANFILE PATH:
${planfile.path}

PLANFILE CONTENT:
${planfile.content}`;
  }

  return "PLANFILE CONTEXT: No planfile was provided through optional_planfile and no usable session planfile was found. Continue evaluating the code changes without plan input.";
}

function filterGeneratedConfirmGuidance(extraContext: string | undefined): string {
  if (!extraContext) return "";
  return extraContext
    .split("\n")
    .filter((line) => !line.includes("[generated confirm review-depth guidance]"))
    .join("\n");
}

async function readRecentUserContextForConfirm(sessionDir: string | undefined): Promise<string> {
  if (!sessionDir) return "";
  const transcriptPath = readSessionTranscriptPath(sessionDir);
  if (!transcriptPath) return "";
  const messages = await readRecentUserMessagesArray(transcriptPath, 5);
  return messages.join("\n");
}

function formatDeduplicationRequirementContext(requirement: string | undefined): string {
  if (!requirement) return "";
  return `=== DEDUPLICATION USER REQUIREMENT ===
Exact user wording: ${JSON.stringify(requirement)}
If the changed code clearly violates this requirement, fail Deduplication and quote this exact wording in the Deduplication reason and verdict.
=== END DEDUPLICATION USER REQUIREMENT ===
`;
}

function formatNormalizedMovesContext(moves: NormalizedMoveSummary[]): string {
  if (moves.length === 0) return "";
  return `NORMALIZED MOVES:
${moves.map((move) => {
  const label = move.mode === "moved-with-edits" ? "moved with edits" : "moved";
  return `${formatGitPathForContext(move.oldPath)} -> ${formatGitPathForContext(move.newPath)} (${label}, similarity ${move.similarity}%)`;
}).join("\n")}`;
}

function appendNormalizedMovesContext(context: string, moves: NormalizedMoveSummary[]): string {
  const moveContext = formatNormalizedMovesContext(moves);
  if (!moveContext || context.includes(moveContext)) return context;
  return `${context}\n\n${moveContext}`;
}

function formatDeletedFilesContext(contexts: ConfirmReviewContext["deletionContexts"]): string {
  const qualifyRepo = contexts.length > 1;
  const deletedPaths = contexts.flatMap((context) => {
    const normalizedOldPaths = new Set(context.normalizedMoves.map((move) => move.oldPath));
    return context.status.split("\n").flatMap((line) => {
      const parsed = parsePorcelainStatusLine(line);
      if (
        !parsed
        || parsed.oldPath
        || (parsed.indexStatus !== "D" && parsed.workTreeStatus !== "D")
        || normalizedOldPaths.has(parsed.path)
      ) return [];
      const displayPath = formatGitPathForContext(parsed.path);
      return [qualifyRepo
        ? `${displayPath} (repository: ${formatGitPathForContext(context.repoPath)})`
        : displayPath];
    });
  });
  return `=== DELETED FILES ===
${deletedPaths.length > 0 ? deletedPaths.map((filePath) => `- ${filePath}`).join("\n") : "(none)"}
=== END DELETED FILES ===
`;
}

function formatReviewContextReductions(
  scopeKind: ConfirmReviewScopeKind,
  normalizedMoves: NormalizedMoveSummary[],
): string {
  if (scopeKind === "full") {
    return `=== REVIEW CONTEXT REDUCTIONS ===
- Fullconfirm embeds the tracked, git-visible text-file inventory and line counts, not repository file contents. This keeps the initial request bounded while read/search tools remain available for inspecting relevant files.
- Untracked and gitignored files are not part of the automatic fullconfirm inventory. Gitignored files may still be inspected with tools when the visible code makes them relevant.
- Binary and unreadable files are counted as skipped inventory entries rather than embedded as raw content.
- Missing inline content does NOT mean a file was reviewed or is irrelevant. Inspect the files needed to support every verdict.
=== END REVIEW CONTEXT REDUCTIONS ===
`;
  }

  const moveReduction = normalizedMoves.length > 0
    ? `${normalizedMoves.length} detected delete/recreate move pair(s) were rendered as Git renames. Unchanged moved bodies are intentionally collapsed; changed lines and a NORMALIZED MOVES mapping remain.`
    : "No delete/recreate move pair was normalized in this review context.";
  return `=== REVIEW CONTEXT REDUCTIONS ===
- Tracked unified-diff hunks include ${REVIEW_CONTEXT_REDUCTION_LIMITS.trackedDiffContextLines} unchanged context line on each side instead of Git's default three. Every added/deleted line is retained unless an explicit truncation marker says otherwise; use read/search tools for wider surrounding context.
- Oversized per-file diff bodies and aggregate diff context are replaced with explicit size/change-count markers before the initial reviewer prompt reaches model input limits. The complete changed-file list remains in GIT STATUS; reviewers must inspect marked files with read/search tools before deciding.
- Every nonignored untracked path is represented either in the untracked-file inventory or, for a normalized move destination, in the NORMALIZED MOVES mapping. Raw untracked contents are not duplicated because each complete current file is directly available through read/search tools. Inventory-only does not mean reviewed: inspect every untracked file relevant to your verdict.
- Untracked text is still scanned for deterministic debug and unused-workaround patterns. Up to ${REVIEW_CONTEXT_REDUCTION_LIMITS.untrackedPrefilterCandidateLinesPerFile} compact evidence lines per file feed the prefilter; additional matches are counted rather than duplicated.
- Oversized individual logical lines are listed but skipped by deterministic matching rather than split into misleading fragments.
- Inventory metadata is streamed with bounded memory. Symlinks and special files are not followed, and regular-file scans over ${REVIEW_CONTEXT_REDUCTION_LIMITS.inventoryScanMaxFileBytes} bytes per file or ${REVIEW_CONTEXT_REDUCTION_LIMITS.inventoryScanMaxTotalBytes} bytes in total are labeled as skipped while their paths and sizes remain visible. This prevents blocking and resource exhaustion; inspect a labeled path directly when relevant.
- Raw binary contents are not embedded by Git; only compact binary-diff metadata is present.
- ${moveReduction}
- Tracked diff and status collection also have explicit safety caps. Treat every agent-framework truncation or skipped-path marker as an instruction to inspect the named files before deciding.
=== END REVIEW CONTEXT REDUCTIONS ===
`;
}

function formatOmittedPrefilterFindings(
  entries: ConfirmReviewContext["untrackedOmittedMatchedLines"],
): string {
  if (entries.length === 0) return "";
  return `=== OMITTED DETERMINISTIC FINDINGS ===
${entries.map((entry) =>
    `- ${entry.count} additional finding(s) in ${formatGitPathForContext(entry.path)} (repository: ${formatGitPathForContext(entry.repoPath)})`
  ).join("\n")}
=== END OMITTED DETERMINISTIC FINDINGS ===
`;
}

function countDiffReviewLines(diff: string): number {
  return countUnifiedDiffChangedLines(diff);
}

function countGitChangesReviewLines(changes: GitChanges): number {
  const embeddedUntrackedArtifactLines = countDiffReviewLines(changes.untrackedInventory);
  const trackedLines = Math.max(0, countDiffReviewLines(changes.diff) - embeddedUntrackedArtifactLines);
  return trackedLines + changes.untrackedLinesChanged;
}

function summarizeRepoChanges(repos: RepoGitContext[]): Pick<
  ConfirmReviewContext,
  "status" | "diff" | "normalizedMoves" | "lineCount" | "deletionContexts" | "untrackedMatchedLineDiff"
  | "untrackedOmittedMatchedLines"
> {
  return {
    status: repos.map((repo) => repo.changes.status).join("\n"),
    diff: repos.map((repo) => repo.changes.diff).join("\n"),
    normalizedMoves: repos.flatMap((repo) => repo.changes.normalizedMoves ?? []),
    lineCount: repos.reduce(
      (total, repo) => total + countGitChangesReviewLines(repo.changes),
      0,
    ),
    deletionContexts: repos.map((repo) => ({
      repoPath: repo.path,
      status: repo.changes.status,
      normalizedMoves: repo.changes.normalizedMoves ?? [],
    })),
    untrackedMatchedLineDiff: repos
      .map((repo) => repo.changes.untrackedMatchedLineDiff ?? "")
      .filter(Boolean)
      .join("\n"),
    untrackedOmittedMatchedLines: repos.flatMap((repo) =>
      (repo.changes.untrackedOmittedMatchedLines ?? []).map((entry) => ({
        repoPath: repo.path,
        ...entry,
      }))
    ),
  };
}

async function buildUncommittedReviewContext(
  workingDir: string,
  allRepoInfo: RepoInfo | undefined,
  options: ConfirmOptions,
): Promise<ConfirmReviewContext> {
  let repos: RepoGitContext[];
  let gitContext = "";
  const gitOptions = {
    ...options,
    normalizeMovedRecreated: true,
    untrackedLineMatcher: selectConfirmPrefilterCandidateLines,
  };
  if (allRepoInfo) {
    const allContext = await getAllReposGitContextCancellable(allRepoInfo, gitOptions);
    repos = allContext.repos;
    const promptRepos = repos.map((repo) => ({
      ...repo,
      changes: compactGitChangesForConfirmPrompt(repo.changes),
    }));
    const contextWasCompacted = promptRepos.some(
      (repo, index) => repo.changes.diff !== repos[index].changes.diff,
    );
    gitContext = contextWasCompacted
      ? formatGitContextForRepos(promptRepos)
      : allContext.context;
  } else if (
    options.repoScope?.mode === "single"
    && options.repoScope.repoInfo
    && options.repoScope.repoInfo.reposWithChanges.length > 1
  ) {
    const singleRepoInfo = options.repoScope.repoInfo;
    const singleContext = await getSingleRepoGitContextWithSiblingOverviewCancellable(
      workingDir,
      singleRepoInfo,
      gitOptions,
    );
    repos = [singleContext.current];
    gitContext = `${formatGitContextForRepos([{
      ...singleContext.current,
      changes: compactGitChangesForConfirmPrompt(singleContext.current.changes),
    }])}${singleContext.siblingOverview ? `\n\n${singleContext.siblingOverview}` : ""}`;
  } else {
    const changes = await getUncommittedChangesCancellable(workingDir, gitOptions);
    repos = [{ path: workingDir, name: path.basename(workingDir), changes }];
    gitContext = `GIT STATUS (files changed):
${changes.status || "(no changes)"}

GIT DIFF (all uncommitted changes):
${compactGitChangesForConfirmPrompt(changes).diff || "(no diff)"}`;
  }

  const summary = summarizeRepoChanges(repos);

  return {
    prompt: "Evaluate these code changes:",
    context: gitContext,
    ...summary,
  };
}

async function buildFullReviewContext(
  workingDir: string,
  allRepoInfo: RepoInfo | undefined,
  options: ConfirmOptions,
): Promise<ConfirmReviewContext> {
  const repos = allRepoInfo
    ? allReposInScope(allRepoInfo)
    : [{ path: workingDir, name: path.basename(workingDir) }];
  const fullContext = await getRepoFullScopeContextsCancellable(repos, options);
  return {
    prompt: "Evaluate this full git-visible code scope:",
    context: fullContext.context,
    status: fullContext.repos
      .flatMap((repo) => [
        ...repo.inventory.files.map((file) => `?? ${formatGitPathForContext(file.path)}`),
        ...(repo.inventory.skippedFiles ?? []).map((file) => `?? ${formatGitPathForContext(file.path)}`),
      ])
      .join("\n"),
    diff: "",
    lineCount: fullContext.totalLines,
    normalizedMoves: [],
    deletionContexts: [],
    untrackedMatchedLineDiff: "",
    untrackedOmittedMatchedLines: [],
  };
}

async function runSingleConfirmSdk(
  workingDir: string,
  tier: ReturnType<typeof parseTierName>,
  prompt: string,
  context: string,
  options: ConfirmOptions,
) {
  return runAgent(
    {
      ...CONFIRM_AGENT,
      tier,
      workingDir,
      runtimeHomeProfile: "internalReadOnly",
      sdkToolPolicy: "read-only",
      systemPrompt: `${CONFIRM_AGENT.systemPrompt}\n\n${CONFIRM_DEDUPLICATION_PROMPT_EXTENSION}`,
      formatValidation: CONFIRM_AGENT.formatValidation
        ? { ...CONFIRM_AGENT.formatValidation, fallbackOutput: CONFIRM_FORMAT_FALLBACK }
        : undefined,
    },
    { prompt, context },
    options,
  );
}

async function runConfirmReviewAgents(
  workingDir: string,
  tier: ReturnType<typeof parseTierName>,
  reviewContext: ConfirmReviewContext,
  fullContext: string,
  options: ConfirmOptions,
) {
  const [general, specialist, pattern] = await Promise.all([
    runSingleConfirmSdk(workingDir, tier, reviewContext.prompt, fullContext, options),
    runAgent(
      {
        ...CONFIRM_SPECIALIST_AGENT,
        tier,
        workingDir,
        runtimeHomeProfile: "internalReadOnly",
        sdkToolPolicy: "read-only",
      },
      {
        prompt: "Evaluate this review scope for duplication, helper, and separation-of-concern risks:",
        context: fullContext,
      },
      options,
    ),
    runAgent(
      {
        ...CONFIRM_PATTERN_AGENT,
        tier,
        workingDir,
        runtimeHomeProfile: "internalReadOnly",
        sdkToolPolicy: "read-only",
      },
      {
        prompt: "Evaluate this review scope for code quality and local pattern assurance risks:",
        context: fullContext,
      },
      options,
    ),
  ]);

  return runAgent(
    {
      ...CONFIRM_AGGREGATOR_AGENT,
      tier,
      workingDir,
    },
    {
      prompt: "Merge these parallel confirm results:",
      context: `REVIEW LINE COUNT: ${reviewContext.lineCount}

=== GENERAL CONFIRM AGENT ===
${general.output}

=== DEDUPLICATION SPECIALIST AGENT ===
${specialist.output}

=== CODE QUALITY AND PATTERN SPECIALIST AGENT ===
${pattern.output}`,
    },
    options,
  );
}

/**
 * Run the confirm agent to evaluate code changes.
 *
 * @param workingDir - The project directory to evaluate
 * @param tierName - Optional model tier (haiku/sonnet/opus, defaults to opus)
 * @param extraContext - Optional extra instructions for the evaluation
 * @param optionalPlanfile - Optional explicit planfile path to include as plan context
 * @returns Check output on check failure, otherwise structured verdict with CONFIRMED or DECLINED
 */
export async function runConfirmAgent(
  workingDir: string,
  tierName?: string,
  extraContext?: string,
  optionalPlanfile?: string,
  options: ConfirmOptions = {}
): Promise<string> {
  return runSharedConfirmAgent("uncommitted", workingDir, tierName, extraContext, optionalPlanfile, options);
}

export async function runFullConfirmAgent(
  workingDir: string,
  tierName?: string,
  extraContext?: string,
  optionalPlanfile?: string,
  options: ConfirmOptions = {}
): Promise<string> {
  return runSharedConfirmAgent("full", workingDir, tierName, extraContext, optionalPlanfile, options);
}

async function runSharedConfirmAgent(
  scopeKind: ConfirmReviewScopeKind,
  workingDir: string,
  tierName?: string,
  extraContext?: string,
  optionalPlanfile?: string,
  options: ConfirmOptions = {}
): Promise<string> {
  const sessionContext = resolveConfirmSessionContext(workingDir);
  const agentName = scopeKind === "full" ? "fullconfirm" : "confirm";

  try {
    const tier = parseTierName(tierName);

    // Step 1: Run check agent first
    const allRepoInfo = options.repoScope?.mode === "all" ? options.repoScope.repoInfo : undefined;
    const checkResult = allRepoInfo
      ? await runCheckAgent(allRepoInfo.mainRepo, undefined, {
          ...options,
          repoScope: { mode: "all", repoInfo: allRepoInfo },
        })
      : await runCheckAgent(workingDir, undefined, options);

    const parsedCheck = parseCheckAgentResult(checkResult);

    // Step 2: If check failed, decline immediately
    if (parsedCheck.failed) {
      // No confirm output or LLM call here: check output is the authoritative failure.
      return formatCheckFailure(checkResult, parsedCheck.errorCount);
    }

    const planfile = await resolveConfirmPlanfile(workingDir, sessionContext.sessionDir, optionalPlanfile);
    const deterministicErrors: string[] = [];
    if (planfile.kind === "error") deterministicErrors.push(planfile.message);
    if (deterministicErrors.length > 0) return deterministicErrors.join("\n");

    // Step 3: Get review scope data
    throwIfAborted(options.signal);
    const reviewContext = scopeKind === "full"
      ? await buildFullReviewContext(workingDir, allRepoInfo, options)
      : await buildUncommittedReviewContext(workingDir, allRepoInfo, options);

    // Step 3.5: Pre-filter deterministic violations (file/extension-aware)
    const prefilterSection = formatConfirmPrefilter(runConfirmPrefilter(
      reviewContext.status,
      `${reviewContext.diff}\n${reviewContext.untrackedMatchedLineDiff}`,
    ));
    const recentUserContext = await readRecentUserContextForConfirm(sessionContext.sessionDir);
    const deduplicationRequirement = findDeduplicationUserRequirement([
      filterGeneratedConfirmGuidance(extraContext),
      recentUserContext,
    ].join("\n"));
    const deduplicationRequirementSection = formatDeduplicationRequirementContext(deduplicationRequirement);

    const reductionSection = formatReviewContextReductions(scopeKind, reviewContext.normalizedMoves);
    const deletedFilesSection = formatDeletedFilesContext(reviewContext.deletionContexts);
    const omittedPrefilterSection = formatOmittedPrefilterFindings(
      reviewContext.untrackedOmittedMatchedLines,
    );
    const baseContext = `${reductionSection}${deletedFilesSection}${prefilterSection}${omittedPrefilterSection}${deduplicationRequirementSection}${formatPlanfileContext(planfile)}

REVIEW SCOPE: ${scopeKind === "full" ? "full git-visible code" : "uncommitted code changes"}
REVIEW LINE COUNT: ${reviewContext.lineCount}

${reviewContext.context}${extraContext ? `\n\nUSER INSTRUCTIONS:\n${extraContext}` : ""}`;
    const context = appendNormalizedMovesContext(baseContext, reviewContext.normalizedMoves);
    const result = await runConfirmReviewAgents(workingDir, tier, reviewContext, context, options);

    logAgentResult(result, {
      agent: agentName,
      hookName: getHookName(scopeKind),
      toolName: getHookName(scopeKind),
      workingDir,
      executionType: EXECUTION_TYPES.LLM,
      decisionOverride: "CONFIRM",
    });

    return result.output;
  } finally {
    if (sessionContext.sessionDir) {
      const runId = canonicalHookRunIdForSession(sessionContext.sessionDir);
      if (runId) await resetCanonicalDriftWindow(runId).catch(() => undefined);
    }
  }
}
