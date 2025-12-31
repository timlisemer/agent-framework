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

import { runAgent } from '../../utils/agent-runner.js';
import { COMMIT_AGENT } from '../../utils/agent-configs.js';
import { runCommand } from '../../utils/command.js';
import { getUncommittedChanges } from '../../utils/git-utils.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { runConfirmAgent } from './confirm.js';

/**
 * Parse the LLM response to extract size and message.
 *
 * Expected format:
 * ```
 * SIZE: SMALL|MEDIUM|LARGE
 * MESSAGE:
 * <commit message>
 * ```
 *
 * @param response - Raw LLM output
 * @returns Parsed size and message, or null if parsing fails
 */
function parseCommitResponse(
  response: string
): { size: string; message: string } | null {
  const sizeMatch = response.match(/SIZE:\s*(SMALL|MEDIUM|LARGE)/i);
  const messageMatch = response.match(/MESSAGE:\s*\n([\s\S]+?)(?:\n\n|$)/);

  if (!sizeMatch) return null;

  const size = sizeMatch[1].toUpperCase();
  const message = messageMatch
    ? messageMatch[1].trim()
    : response.split('MESSAGE:')[1]?.trim() || '';

  return { size, message };
}

/**
 * Run the commit agent to generate and execute a git commit.
 *
 * This agent enforces the confirm quality gate before committing.
 * If confirm DECLINES, no commit is made.
 *
 * @param workingDir - The project directory to commit
 * @returns Result with confirm output, message size, and commit hash
 *
 * @example
 * ```typescript
 * const result = await runCommitAgent('/path/to/project');
 * if (result.includes('HASH:')) {
 *   // Commit successful
 * }
 * ```
 */
export async function runCommitAgent(workingDir: string): Promise<string> {
  // Pre-check: skip LLM call if nothing to commit
  const { status, diff, diffStat } = getUncommittedChanges(workingDir);

  if (!status.trim()) {
    logToHomeAssistant({
      agent: 'commit',
      level: 'info',
      problem: workingDir,
      answer: 'SKIPPED: nothing to commit',
    });
    return 'SKIPPED: nothing to commit';
  }

  // Confirm changes before generating commit message
  const confirmResult = await runConfirmAgent(workingDir);
  if (confirmResult.includes('DECLINED')) {
    logToHomeAssistant({
      agent: 'commit',
      level: 'info',
      problem: workingDir,
      answer: confirmResult.slice(0, 500),
    });
    return confirmResult;
  }

  // Generate commit message via unified runner
  const llmOutput = await runAgent(
    { ...COMMIT_AGENT, workingDir },
    {
      prompt: 'Generate a commit message based on the analysis and stats below.',
      context: `CONFIRM AGENT ANALYSIS:
${confirmResult}

---

DIFF STATS:
${diffStat}

DIFF (for context):
${diff.slice(0, 8000)}${diff.length > 8000 ? '\n... (truncated)' : ''}`,
    }
  );

  const parsed = parseCommitResponse(llmOutput);

  if (!parsed || !parsed.message) {
    const error = `ERROR: Failed to parse commit message from LLM response: ${llmOutput}`;
    logToHomeAssistant({
      agent: 'commit',
      level: 'error',
      problem: workingDir,
      answer: error,
    });
    return error;
  }

  // Execute the commit
  const commitCmd = `git add -A && git commit -m ${JSON.stringify(parsed.message)}`;
  const commit = runCommand(commitCmd, workingDir);

  if (commit.exitCode !== 0) {
    const error = `ERROR: Commit failed: ${commit.output}`;
    logToHomeAssistant({
      agent: 'commit',
      level: 'error',
      problem: workingDir,
      answer: error,
    });
    return error;
  }

  // Extract commit hash
  const hashResult = runCommand('git rev-parse --short HEAD', workingDir);
  const hash = hashResult.output.trim();

  const output = `${confirmResult}\n\nSIZE: ${parsed.size}\n${parsed.message}\nHASH: ${hash}`;

  logToHomeAssistant({
    agent: 'commit',
    level: 'info',
    problem: workingDir,
    answer: output.slice(0, 500),
  });

  return output;
}
