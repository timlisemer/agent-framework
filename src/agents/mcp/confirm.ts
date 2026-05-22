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
import { runConfirmPrefilter, formatConfirmPrefilter } from "../../utils/confirm-prefilter.js";
import { getAgentFrameworkSessionDir } from "../../utils/paths.js";
import { readStoredCurrentPlan } from "../../utils/plan-source.js";
import { runCheckAgent } from "./check.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";

import { activeSpec } from "../../adapter/spec.js";
function getHookName(): string { return activeSpec().mcpWireName("confirm"); }

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
  const planfile = await resolveConfirmPlanfile(workingDir, sessionContext.sessionDir, optionalPlanfile);
  if (planfile.kind === "error") return planfile.message;

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

  // Step 3: Get git data
  throwIfAborted(options.signal);
  const { status, diff } = await getUncommittedChangesCancellable(workingDir, options);

  // Step 3.5: Pre-filter deterministic violations (file/extension-aware)
  const prefilterSection = formatConfirmPrefilter(runConfirmPrefilter(status, diff));

  // Step 4: Run SDK agent with dynamic tier
  const result = await runAgent(
    { ...CONFIRM_AGENT, tier, workingDir },
    {
      prompt: "Evaluate these code changes:",
      context: `${prefilterSection}${formatPlanfileContext(planfile)}

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
