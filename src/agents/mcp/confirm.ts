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
  type NormalizedMoveSummary,
  type RepoNormalizedMoveSummary,
  type RepoInfo,
} from "../../utils/git-utils.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import {
  findDeduplicationUserRequirement,
  runConfirmPrefilter,
  formatConfirmPrefilter,
} from "../../utils/confirm-prefilter.js";
import { getAgentFrameworkSessionDir, readSessionTranscriptPath } from "../../utils/paths.js";
import { readStoredCurrentPlan } from "../../utils/plan-source.js";
import { readRecentUserMessagesArray } from "../../utils/transcript.js";
import { runCheckAgent } from "./check.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import { parseCheckAgentResult } from "../../utils/check-result.js";

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

  if (!sessionDir) return { kind: "missing" };
  const stored = readStoredCurrentPlan(sessionDir);
  if (!stored?.path) return { kind: "missing" };

  try {
    const content = await fs.promises.readFile(stored.path, "utf-8");
    if (!content.trim()) return { kind: "missing" };
    return { kind: "found", path: stored.path, content };
  } catch {
    return { kind: "missing" };
  }
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
  return `${move.oldPath} -> ${move.newPath} (${label}, similarity ${move.similarity}%)`;
}).join("\n")}`;
}

function appendNormalizedMovesContext(context: string, moves: NormalizedMoveSummary[]): string {
  const moveContext = formatNormalizedMovesContext(moves);
  if (!moveContext || context.includes(moveContext)) return context;
  return `${context}\n\n${moveContext}`;
}

function countDiffReviewLines(diff: string): number {
  return diff
    .split("\n")
    .filter((line) =>
      (line.startsWith("+") && !line.startsWith("+++"))
      || (line.startsWith("-") && !line.startsWith("---"))
    ).length;
}

async function buildUncommittedReviewContext(
  workingDir: string,
  allRepoInfo: RepoInfo | undefined,
  options: ConfirmOptions,
): Promise<ConfirmReviewContext> {
  let status = "";
  let diff = "";
  let gitContext = "";
  let normalizedMoves: NormalizedMoveSummary[] = [];
  const gitOptions = { ...options, normalizeMovedRecreated: true };
  if (allRepoInfo) {
    const allContext = await getAllReposGitContextCancellable(allRepoInfo, gitOptions);
    status = allContext.repos.map((repo) => repo.changes.status).join("\n");
    diff = allContext.repos.map((repo) => repo.changes.diff).join("\n");
    gitContext = allContext.context;
    normalizedMoves = allContext.repos.flatMap((repo) => repo.changes.normalizedMoves ?? []);
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
    status = singleContext.current.changes.status;
    diff = singleContext.current.changes.diff;
    gitContext = `${formatGitContextForRepos([singleContext.current])}${singleContext.siblingOverview ? `\n\n${singleContext.siblingOverview}` : ""}`;
    normalizedMoves = singleContext.current.changes.normalizedMoves ?? [];
  } else {
    const changes = await getUncommittedChangesCancellable(workingDir, gitOptions);
    status = changes.status;
    diff = changes.diff;
    normalizedMoves = changes.normalizedMoves ?? [];
    gitContext = `GIT STATUS (files changed):
${status || "(no changes)"}

GIT DIFF (all uncommitted changes):
${diff || "(no diff)"}`;
  }

  return {
    prompt: "Evaluate these code changes:",
    context: gitContext,
    status,
    diff,
    lineCount: countDiffReviewLines(diff),
    normalizedMoves,
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
      .flatMap((repo) => repo.inventory.files.map((file) => `?? ${file.path}`))
      .join("\n"),
    diff: "",
    lineCount: fullContext.totalLines,
    normalizedMoves: [],
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
  logAgentStarted(agentName, getHookName(scopeKind));

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
  const prefilterSection = formatConfirmPrefilter(runConfirmPrefilter(reviewContext.status, reviewContext.diff));
  const recentUserContext = await readRecentUserContextForConfirm(sessionContext.sessionDir);
  const deduplicationRequirement = findDeduplicationUserRequirement([
    filterGeneratedConfirmGuidance(extraContext),
    recentUserContext,
  ].join("\n"));
  const deduplicationRequirementSection = formatDeduplicationRequirementContext(deduplicationRequirement);

  const baseContext = `${prefilterSection}${deduplicationRequirementSection}${formatPlanfileContext(planfile)}

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
}
