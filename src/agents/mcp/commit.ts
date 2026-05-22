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

import { EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { COMMIT_AGENT } from "../../utils/agent-configs.js";
import { runProcessCancellable } from "../../utils/command.js";
import { getUncommittedChangesCancellable, classifyCommitSize } from "../../utils/git-utils.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import { runConfirmAgent } from "./confirm.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";

import { activeSpec } from "../../adapter/spec.js";
function getHookName(): string { return activeSpec().mcpWireName("commit"); }

function runGit(
  args: string[],
  cwd: string,
  options: CancellationOptions = {}
): Promise<{ output: string; exitCode: number }> {
  return runProcessCancellable({ shell: false, file: "git", args }, cwd, options);
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
  options: CancellationOptions = {}
): Promise<string> {
  logAgentStarted("commit", getHookName());

  const { status, diff, diffStat, untrackedDiff } = await getUncommittedChangesCancellable(workingDir, options);

  if (!status.trim()) {
    return "SKIPPED: nothing to commit";
  }

  // Confirm changes before generating commit message (pass through tier/context)
  throwIfAborted(options.signal);
  const confirmResult = await runConfirmAgent(
    workingDir,
    confirmTierName,
    confirmExtraContext,
    optionalPlanfile,
    options
  );
  if (confirmResult.includes("DECLINED") || confirmResult.startsWith("ERROR:")) {
    // Preserve confirm output verbatim so check and planfile failures keep
    // their concrete error list instead of collapsing to a vague summary.
    return confirmResult;
  }

  // TS-side size classification (folds in untracked-file accounting). The LLM
  // still emits a SIZE: line per its prompt format; we override the parsed
  // value with the TS-authoritative classification before returning.
  const tsSize = classifyCommitSize(diffStat, untrackedDiff, status);

  // Generate commit message
  const result = await runAgent(
    { ...COMMIT_AGENT, workingDir },
    {
      prompt: "Generate a commit message based on the analysis and stats below.",
      context: `CONFIRM AGENT ANALYSIS:
${confirmResult}

---

PRECOMPUTED SIZE: ${tsSize.size} (${tsSize.filesChanged} files, ${tsSize.linesChanged} lines)

DIFF STATS:
${diffStat}

DIFF (for context):
${diff.slice(0, 8000)}${diff.length > 8000 ? "\n... (truncated)" : ""}`,
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
