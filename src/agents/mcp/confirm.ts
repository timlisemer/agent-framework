/**
 * Confirm Agent - Code Quality Gate with Autonomous Investigation
 *
 * This agent evaluates code changes for quality, security, and documentation.
 * It is the ONLY agent using SDK mode, giving it access to Read and
 * read-only Bash for autonomous code investigation.
 *
 * ## FLOW
 *
 * 1. Run check agent first (linter/type-check must pass)
 * 2. If check fails, immediately DECLINE
 * 3. Gather git status and diff
 * 4. Run SDK agent with investigation capabilities
 * 5. Return verdict (CONFIRMED or DECLINED)
 *
 * @module confirm
 */

import * as fs from "fs";
import * as path from "path";
import { EXECUTION_TYPES, parseTierName } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { CONFIRM_AGENT } from "../../utils/agent-configs.js";
import { getUncommittedChangesCancellable } from "../../utils/git-utils.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import {
  findDeduplicationUserRequirement,
  runConfirmPrefilter,
  formatConfirmPrefilter,
} from "../../utils/confirm-prefilter.js";
import { getAgentFrameworkSessionDir, sessionTranscriptPathSidecar } from "../../utils/paths.js";
import { readStoredCurrentPlan } from "../../utils/plan-source.js";
import { readRecentUserMessagesArray } from "../../utils/transcript.js";
import { runCheckAgent } from "./check.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";

import { activeSpec } from "../../adapter/spec.js";
function getHookName(): string { return activeSpec().mcpWireName("confirm"); }

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

All six categories must PASS for CONFIRMED. Any FAIL means DECLINED.`;

const CONFIRM_FORMAT_FALLBACK = `## Results
- Files: UNKNOWN
- Code Quality: UNKNOWN
- Security: UNKNOWN
- Deduplication: UNKNOWN
- Documentation: UNKNOWN
- Tests: UNKNOWN

## Verdict
DECLINED: Agent returned malformed output

## Raw Output
$RAW`;

function extractCheckErrors(checkResult: string): string {
  const errorsMatch = checkResult.match(/## Errors\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  const errors = errorsMatch ? errorsMatch[1].trim() : "";
  if (errors && errors !== "(none)") {
    return errors;
  }

  const trimmed = checkResult.trim();
  return trimmed || "(check failed, but no check output was returned)";
}

export function formatCheckFailure(checkResult: string, errorCount: number): string {
  const checkErrors = extractCheckErrors(checkResult);

  return `## Results
- Files: SKIP
- Code Quality: SKIP
- Security: SKIP
- Deduplication: SKIP
- Documentation: SKIP
- Tests: SKIP

## Check Failure
- Errors: ${errorCount}

## Check Errors
${checkErrors}

## Verdict
DECLINED: check failed with ${errorCount} error(s); see Check Errors above.`;
}

type ConfirmPlanfileResolution =
  | { kind: "found"; path: string; content: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

type ConfirmSessionContext = {
  sessionDir?: string;
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
  try {
    const transcriptPath = fs.readFileSync(sessionTranscriptPathSidecar(sessionDir), "utf-8").trim();
    if (!transcriptPath) return "";
    const messages = await readRecentUserMessagesArray(transcriptPath, 5);
    return messages.join("\n");
  } catch {
    return "";
  }
}

function formatDeduplicationRequirementContext(requirement: string | undefined): string {
  if (!requirement) return "";
  return `=== DEDUPLICATION USER REQUIREMENT ===
Exact user wording: ${JSON.stringify(requirement)}
If the changed code clearly violates this requirement, fail Deduplication and quote this exact wording in the Deduplication reason and verdict.
=== END DEDUPLICATION USER REQUIREMENT ===
`;
}

/**
 * Run the confirm agent to evaluate code changes.
 *
 * @param workingDir - The project directory to evaluate
 * @param tierName - Optional model tier (haiku/sonnet/opus, defaults to opus)
 * @param extraContext - Optional extra instructions for the evaluation
 * @param optionalPlanfile - Optional explicit planfile path to include as plan context
 * @returns Structured verdict with CONFIRMED or DECLINED
 */
export async function runConfirmAgent(
  workingDir: string,
  tierName?: string,
  extraContext?: string,
  optionalPlanfile?: string,
  options: CancellationOptions = {}
): Promise<string> {
  const sessionContext = resolveConfirmSessionContext(workingDir);
  logAgentStarted("confirm", getHookName());

  const tier = parseTierName(tierName);

  // Step 1: Run check agent first
  const checkResult = await runCheckAgent(workingDir, undefined, options);

  const errorMatch = checkResult.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = checkResult.match(/Status:\s*(PASS|FAIL)/i);
  const checkStatus = statusMatch ? statusMatch[1].toUpperCase() : "UNKNOWN";

  // Step 2: If check failed, decline immediately
  if (checkStatus === "FAIL" || errorCount > 0) {
    // Note: No telemetry here since no LLM was called - check agent handles its own telemetry
    return formatCheckFailure(checkResult, errorCount);
  }

  const planfile = await resolveConfirmPlanfile(workingDir, sessionContext.sessionDir, optionalPlanfile);
  const deterministicErrors: string[] = [];
  if (planfile.kind === "error") deterministicErrors.push(planfile.message);
  if (deterministicErrors.length > 0) return deterministicErrors.join("\n");

  // Step 3: Get git data
  throwIfAborted(options.signal);
  const { status, diff } = await getUncommittedChangesCancellable(workingDir, options);

  // Step 3.5: Pre-filter deterministic violations (file/extension-aware)
  const prefilterSection = formatConfirmPrefilter(runConfirmPrefilter(status, diff));
  const recentUserContext = await readRecentUserContextForConfirm(sessionContext.sessionDir);
  const deduplicationRequirement = findDeduplicationUserRequirement([
    filterGeneratedConfirmGuidance(extraContext),
    recentUserContext,
  ].join("\n"));
  const deduplicationRequirementSection = formatDeduplicationRequirementContext(deduplicationRequirement);

  // Step 4: Run SDK agent with dynamic tier
  const result = await runAgent(
    {
      ...CONFIRM_AGENT,
      tier,
      workingDir,
      systemPrompt: `${CONFIRM_AGENT.systemPrompt}\n\n${CONFIRM_DEDUPLICATION_PROMPT_EXTENSION}`,
      formatValidation: CONFIRM_AGENT.formatValidation
        ? { ...CONFIRM_AGENT.formatValidation, fallbackOutput: CONFIRM_FORMAT_FALLBACK }
        : undefined,
    },
    {
      prompt: "Evaluate these code changes:",
      context: `${prefilterSection}${deduplicationRequirementSection}${formatPlanfileContext(planfile)}

GIT STATUS (files changed):
${status || "(no changes)"}

GIT DIFF (all uncommitted changes):
${diff || "(no diff)"}${extraContext ? `\n\nUSER INSTRUCTIONS:\n${extraContext}` : ""}`,
    },
    options
  );

  logAgentResult(result, {
    agent: "confirm",
    hookName: getHookName(),
    toolName: getHookName(),
    workingDir,
    executionType: EXECUTION_TYPES.LLM,
    decisionOverride: "CONFIRM",
  });

  return result.output;
}
