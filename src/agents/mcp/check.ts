/**
 * Check Agent - Linter and Type-Check Summarizer
 *
 * This agent runs project linters and make check, then summarizes the results
 * without analysis or suggestions. It classifies issues as errors or warnings.
 *
 * ## FLOW
 *
 * 1. Get uncommitted files info
 * 2. Detect and run project linter (ESLint, Cargo, Ruff, etc.)
 * 3. Run make check
 * 4. Summarize results via unified runner
 *
 * ## CLASSIFICATION
 *
 * - ERRORS: Compilation failures, type errors, syntax errors, UNUSED CODE
 * - WARNINGS: Style suggestions, lints, refactoring hints
 *
 * Unused code is classified as ERROR because it must be deleted, not suppressed.
 *
 * ## OUTPUT FORMAT
 *
 * ```
 * ## Results
 * - Errors: <count>
 * - Warnings: <count>
 * - Status: PASS | FAIL
 *
 * ## Errors
 * <quoted errors>
 *
 * ## Warnings
 * <quoted warnings>
 * ```
 *
 * Status is FAIL if Errors > 0, PASS otherwise.
 *
 * @module check
 */

import * as fs from 'fs';
import * as path from 'path';
import { runAgent } from '../../utils/agent-runner.js';
import { CHECK_AGENT } from '../../utils/agent-configs.js';
import { runCommand } from '../../utils/command.js';
import { getUncommittedChanges } from '../../utils/git-utils.js';

/**
 * Detect which linter is configured for the project.
 *
 * Checks for common linter configuration files and returns the appropriate
 * command to run. Supports ESLint, Cargo/Clippy, Ruff/Pylint, and golangci-lint.
 *
 * @param workingDir - The project directory to check
 * @returns The lint command to run, or null if no linter found
 */
function detectLinter(workingDir: string): string | null {
  const checks = [
    {
      files: [
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.cjs',
        '.eslintrc.js',
        '.eslintrc.json',
        '.eslintrc.yml',
        '.eslintrc',
      ],
      cmd: 'npx eslint . 2>&1',
    },
    { files: ['Cargo.toml'], cmd: 'cargo clippy 2>&1 || cargo check 2>&1' },
    {
      files: ['pyproject.toml', 'setup.py'],
      cmd: 'ruff check . 2>&1 || pylint . 2>&1',
    },
    {
      files: ['go.mod'],
      cmd: 'golangci-lint run 2>&1 || go vet ./... 2>&1',
    },
  ];

  for (const { files, cmd } of checks) {
    for (const file of files) {
      if (fs.existsSync(path.join(workingDir, file))) {
        return cmd;
      }
    }
  }
  return null;
}

/**
 * Run the check agent to summarize linter and type-check results.
 *
 * This agent does NOT analyze or suggest fixes - it only reports what the
 * tools said. The output is structured for easy parsing by other agents.
 *
 * @param workingDir - The project directory to check
 * @returns Structured summary with errors, warnings, and status
 *
 * @example
 * ```typescript
 * const result = await runCheckAgent('/path/to/project');
 * if (result.includes('Status: PASS')) {
 *   // All checks passed
 * }
 * ```
 */
export async function runCheckAgent(workingDir: string): Promise<string> {
  // Step 1: Get uncommitted files info
  const { status } = getUncommittedChanges(workingDir);

  // Step 2: Run linter if configured
  let lintOutput = '';
  const lintCmd = detectLinter(workingDir);
  if (lintCmd) {
    const lint = runCommand(lintCmd, workingDir);
    lintOutput = `LINTER OUTPUT (exit code ${lint.exitCode}):\n${lint.output}\n`;
  }

  // Step 3: Run make check
  const check = runCommand('make check 2>&1', workingDir);
  const checkOutput = `MAKE CHECK OUTPUT (exit code ${check.exitCode}):\n${check.output}`;

  // Step 4: Use unified runner for analysis
  return runAgent(
    { ...CHECK_AGENT, workingDir },
    {
      prompt: 'Summarize the following check results:',
      context: `UNCOMMITTED FILES:\n${status || '(none)'}\n\n${lintOutput}${checkOutput}`,
    }
  );
}
