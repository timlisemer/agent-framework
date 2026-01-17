/**
 * Confirm Agent - Code Quality Gate with Autonomous Investigation
 *
 * This agent evaluates code changes for quality, security, and documentation.
 * It is the ONLY agent using SDK mode, giving it access to Read/Glob/Grep
 * tools for autonomous code investigation.
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

import { EXECUTION_TYPES, parseTierName } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { CONFIRM_AGENT } from "../../utils/agent-configs.js";
import { getUncommittedChanges } from "../../utils/git-utils.js";
import { logAgentStarted, logConfirm } from "../../utils/logger.js";
import { setTranscriptPath } from "../../utils/execution-context.js";
import { runCheckAgent } from "./check.js";

const HOOK_NAME = "mcp__agent-framework__confirm";

/**
 * Run the confirm agent to evaluate code changes.
 *
 * @param workingDir - The project directory to evaluate
 * @param tierName - Optional model tier (haiku/sonnet/opus, defaults to opus)
 * @param extraContext - Optional extra instructions for the evaluation
 * @param transcriptPath - Optional transcript path for statusLine updates
 * @returns Structured verdict with CONFIRMED or DECLINED
 */
export async function runConfirmAgent(
  workingDir: string,
  tierName?: string,
  extraContext?: string,
  transcriptPath?: string
): Promise<string> {
  // Set up execution context for statusLine logging
  if (transcriptPath) {
    setTranscriptPath(transcriptPath);
  }
  logAgentStarted("confirm", HOOK_NAME);

  const tier = parseTierName(tierName);
  // Step 1: Run check agent first
  const checkResult = await runCheckAgent(workingDir, transcriptPath);

  const errorMatch = checkResult.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = checkResult.match(/Status:\s*(PASS|FAIL)/i);
  const checkStatus = statusMatch ? statusMatch[1].toUpperCase() : "UNKNOWN";

  // Step 2: If check failed, decline immediately
  if (checkStatus === "FAIL" || errorCount > 0) {
    const declineReason = `check failed with ${errorCount} error(s)`;
    const result = `## Results
- Files: SKIP
- Code Quality: SKIP
- Security: SKIP
- Documentation: SKIP

## Verdict
DECLINED: ${declineReason}`;

    // Note: No telemetry here since no LLM was called - check agent handles its own telemetry
    return result;
  }

  // Step 3: Get git data
  const { status, diff } = getUncommittedChanges(workingDir);

  // Step 4: Run SDK agent with dynamic tier
  const result = await runAgent(
    { ...CONFIRM_AGENT, tier, workingDir },
    {
      prompt: "Evaluate these code changes:",
      context: `GIT STATUS (files changed):
${status || "(no changes)"}

GIT DIFF (all uncommitted changes):
${diff || "(no diff)"}${extraContext ? `\n\nUSER INSTRUCTIONS:\n${extraContext}` : ""}`,
    }
  );

  logConfirm(
    result,
    "confirm",
    HOOK_NAME,
    HOOK_NAME,
    workingDir,
    EXECUTION_TYPES.LLM,
    result.output.slice(0, 500)
  );

  return result.output;
}
