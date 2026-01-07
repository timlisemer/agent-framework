/**
 * Commit Agent - Git Commit with Quality Gate
 *
 * This agent generates commit messages and executes git commits, but only
 * after changes pass the confirm agent quality gate.
 *
 * ## FLOW
 *
 * 1. Pre-check: Skip if nothing to commit
 * 2. Run confirm agent (quality gate)
 * 3. If DECLINED, return immediately
 * 4. Generate commit message via unified runner
 * 5. Execute git add -A && git commit
 * 6. Return result with commit hash
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

import { runAgent } from "../../utils/agent-runner.js";
import { COMMIT_AGENT } from "../../utils/agent-configs.js";
import { runCommand } from "../../utils/command.js";
import { getUncommittedChanges } from "../../utils/git-utils.js";
import { logAgentDecision } from "../../utils/logger.js";
import { runConfirmAgent } from "./confirm.js";

const HOOK_NAME = "mcp__agent-framework__commit";

/**
 * Parse the LLM response to extract size and message.
 */
function parseCommitResponse(
  response: string
): { size: string; message: string } | null {
  const sizeMatch = response.match(/SIZE:\s*(SMALL|MEDIUM|LARGE)/i);
  if (!sizeMatch) return null;

  const size = sizeMatch[1].toUpperCase();
  const messageMatch = response.match(/MESSAGE:\s*\n([\s\S]+?)(?:\n\n|$)/);
  let message = messageMatch ? messageMatch[1].trim() : "";

  if (!message) {
    const fallbackMatch = response.match(/MESSAGE:\s*([\s\S]+?)(?:\n\n|$)/);
    message = fallbackMatch ? fallbackMatch[1].trim() : "";
  }

  if (!message) return null;
  return { size, message };
}

/**
 * Run the commit agent to generate and execute a git commit.
 *
 * @param workingDir - The project directory to commit
 * @returns Result with confirm output, message size, and commit hash
 */
export async function runCommitAgent(workingDir: string): Promise<string> {
  const { status, diff, diffStat } = getUncommittedChanges(workingDir);

  if (!status.trim()) {
    return "SKIPPED: nothing to commit";
  }

  // Confirm changes before generating commit message
  const confirmResult = await runConfirmAgent(workingDir);
  if (confirmResult.includes("DECLINED")) {
    return confirmResult;
  }

  // Generate commit message
  const result = await runAgent(
    { ...COMMIT_AGENT, workingDir },
    {
      prompt: "Generate a commit message based on the analysis and stats below.",
      context: `CONFIRM AGENT ANALYSIS:
${confirmResult}

---

DIFF STATS:
${diffStat}

DIFF (for context):
${diff.slice(0, 8000)}${diff.length > 8000 ? "\n... (truncated)" : ""}`,
    }
  );

  const parsed = parseCommitResponse(result.output);

  if (!parsed || !parsed.message) {
    logAgentDecision({
      agent: "commit",
      hookName: HOOK_NAME,
      decision: "DECLINED",
      toolName: HOOK_NAME,
      workingDir,
      latencyMs: result.latencyMs,
      modelTier: result.modelTier,
      success: result.success,
      errorCount: result.errorCount,
      decisionReason: "Failed to parse commit message",
    });
    return `ERROR: Failed to parse commit message from LLM response: ${result.output}`;
  }

  // Execute the commit
  const commitCmd = `git add -A && git commit -m ${JSON.stringify(parsed.message)}`;
  const commit = runCommand(commitCmd, workingDir);

  if (commit.exitCode !== 0) {
    logAgentDecision({
      agent: "commit",
      hookName: HOOK_NAME,
      decision: "DECLINED",
      toolName: HOOK_NAME,
      workingDir,
      latencyMs: result.latencyMs,
      modelTier: result.modelTier,
      success: result.success,
      errorCount: result.errorCount,
      decisionReason: `Commit failed: ${commit.output}`,
    });
    return `ERROR: Commit failed: ${commit.output}`;
  }

  const hashResult = runCommand("git rev-parse --short HEAD", workingDir);
  const hash = hashResult.output.trim();

  logAgentDecision({
    agent: "commit",
    hookName: HOOK_NAME,
    decision: "CONFIRMED",
    toolName: HOOK_NAME,
    workingDir,
    latencyMs: result.latencyMs,
    modelTier: result.modelTier,
    success: result.success,
    errorCount: result.errorCount,
    decisionReason: `Committed: ${hash}`,
  });

  return `${confirmResult}\n\nSIZE: ${parsed.size}\n${parsed.message}\nHASH: ${hash}`;
}
