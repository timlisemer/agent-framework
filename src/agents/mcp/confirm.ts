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
 * ## SDK MODE
 *
 * Unlike other agents, confirm uses the Claude SDK for multi-turn interactions.
 * This allows it to:
 * - Read additional files to understand context
 * - Search the codebase for related code
 * - Verify documentation matches implementation
 *
 * Git data (status, diff) is still provided via prompt to avoid Bash access.
 *
 * ## EVALUATION CATEGORIES
 *
 * 1. Files: Check for unwanted files (node_modules, .env, etc.)
 * 2. Code Quality: No bugs, debug code, or unused code workarounds
 * 3. Security: No hardcoded secrets or vulnerabilities
 * 4. Documentation: Updated if changes require it
 *
 * All categories must PASS for CONFIRMED. Any FAIL means DECLINED.
 *
 * @module confirm
 */

import { runAgent } from '../../utils/agent-runner.js';
import { CONFIRM_AGENT } from '../../utils/agent-configs.js';
import { getUncommittedChanges } from '../../utils/git-utils.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { runCheckAgent } from './check.js';

/**
 * Run the confirm agent to evaluate code changes.
 *
 * This is the main quality gate before commits. It first runs the check
 * agent (linter/type-check), then evaluates the changes using an SDK agent
 * that can investigate the codebase.
 *
 * @param workingDir - The project directory to evaluate
 * @returns Structured verdict with CONFIRMED or DECLINED
 *
 * @example
 * ```typescript
 * const result = await runConfirmAgent('/path/to/project');
 * if (result.includes('CONFIRMED')) {
 *   // Safe to commit
 * } else {
 *   // Fix issues first
 * }
 * ```
 */
export async function runConfirmAgent(workingDir: string): Promise<string> {
  // Step 1: Run check agent first (linter/type-check must pass)
  const checkResult = await runCheckAgent(workingDir);

  // Step 2: Parse check results for errors
  const errorMatch = checkResult.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = checkResult.match(/Status:\s*(PASS|FAIL)/i);
  const checkStatus = statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN';

  // Step 3: If check failed, decline immediately
  if (checkStatus === 'FAIL' || errorCount > 0) {
    const result = `## Results
- Files: SKIP
- Code Quality: SKIP
- Security: SKIP
- Documentation: SKIP

## Verdict
DECLINED: check failed with ${errorCount} error(s)`;

    logToHomeAssistant({
      agent: 'confirm',
      level: 'decision',
      problem: workingDir,
      answer: result,
    });

    return result;
  }

  // Step 4: Get git data to pass via prompt (no Bash access for SDK agent)
  const { status, diff } = getUncommittedChanges(workingDir);

  // Step 5: Run SDK agent with investigation capabilities
  const result = await runAgent(
    { ...CONFIRM_AGENT, workingDir },
    {
      prompt: 'Evaluate these code changes:',
      context: `GIT STATUS (files changed):
${status || '(no changes)'}

GIT DIFF (all uncommitted changes):
${diff || '(no diff)'}`,
    }
  );

  // Log the final decision
  logToHomeAssistant({
    agent: 'confirm',
    level: 'decision',
    problem: workingDir,
    answer: result.slice(0, 500),
  });

  return result;
}
