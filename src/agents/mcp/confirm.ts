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

import { runAgent } from "../../utils/agent-runner.js";
import { CONFIRM_AGENT } from "../../utils/agent-configs.js";
import { getUncommittedChanges } from "../../utils/git-utils.js";
import { logAgentDecision } from "../../utils/logger.js";
import { runCheckAgent } from "./check.js";

const HOOK_NAME = "mcp__agent-framework__confirm";

/**
 * Run the confirm agent to evaluate code changes.
 *
 * @param workingDir - The project directory to evaluate
 * @returns Structured verdict with CONFIRMED or DECLINED
 */
export async function runConfirmAgent(workingDir: string): Promise<string> {
  // Step 1: Run check agent first
  const checkResult = await runCheckAgent(workingDir);

  const errorMatch = checkResult.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = checkResult.match(/Status:\s*(PASS|FAIL)/i);
  const checkStatus = statusMatch ? statusMatch[1].toUpperCase() : "UNKNOWN";

  // Step 2: If check failed, decline immediately
  if (checkStatus === "FAIL" || errorCount > 0) {
    const result = `## Results
- Files: SKIP
- Code Quality: SKIP
- Security: SKIP
- Documentation: SKIP

## Verdict
DECLINED: check failed with ${errorCount} error(s)`;

    // Note: No telemetry here since no LLM was called - check agent handles its own telemetry
    return result;
  }

  // Step 3: Get git data
  const { status, diff } = getUncommittedChanges(workingDir);

  // Step 4: Run SDK agent
  const result = await runAgent(
    { ...CONFIRM_AGENT, workingDir },
    {
      prompt: "Evaluate these code changes:",
      context: `GIT STATUS (files changed):
${status || "(no changes)"}

GIT DIFF (all uncommitted changes):
${diff || "(no diff)"}`,
    }
  );

  const isConfirmed = result.output.includes("CONFIRMED");

  logAgentDecision({
    agent: "confirm",
    hookName: HOOK_NAME,
    decision: isConfirmed ? "CONFIRMED" : "DECLINED",
    toolName: HOOK_NAME,
    workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: result.output.slice(0, 500),
  });

  return result.output;
}
