/**
 * Check Agent - Linter and Type-Check Summarizer
 *
 * This agent runs project linters and make check, then summarizes the results
 * without analysis or suggestions. It classifies issues as errors, warnings, or info.
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
 * - INFO: Benchmark results, performance metrics, test summaries (max 5 lines)
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
 *
 * ## Info
 * <important output like benchmarks, max 5 lines>
 * ```
 *
 * Status is FAIL if Errors > 0, PASS otherwise.
 *
 * @module check
 */

import * as fs from "fs";
import * as path from "path";
import { EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { CHECK_AGENT } from "../../utils/agent-configs.js";
import { runCommand } from "../../utils/command.js";
import { getUncommittedChanges, getRepoInfo } from "../../utils/git-utils.js";
import { logAgentStarted, logConfirm } from "../../utils/logger.js";
import { setTranscriptPath } from "../../utils/execution-context.js";

const HOOK_NAME = "mcp__agent-framework__check";

/**
 * Detect which linter is configured for the project.
 * Checks the target directory first, then falls back to the main repo.
 *
 * @returns Object with cmd and the directory to run it in, or null if no linter found
 */
function detectLinter(
  workingDir: string,
  mainRepo: string
): { cmd: string; dir: string } | null {
  const checks = [
    {
      files: [
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.cjs",
        ".eslintrc.js",
        ".eslintrc.json",
        ".eslintrc.yml",
        ".eslintrc",
      ],
      cmd: "npx eslint . 2>&1",
    },
    { files: ["Cargo.toml"], cmd: "cargo clippy 2>&1 || cargo check 2>&1" },
    {
      files: ["pyproject.toml", "setup.py"],
      cmd: "ruff check . 2>&1 || pylint . 2>&1",
    },
    {
      files: ["go.mod"],
      cmd: "golangci-lint run 2>&1 || go vet ./... 2>&1",
    },
  ];

  // Check target directory first
  for (const { files, cmd } of checks) {
    for (const file of files) {
      if (fs.existsSync(path.join(workingDir, file))) {
        return { cmd, dir: workingDir };
      }
    }
  }

  // Fall back to main repo if different
  if (mainRepo !== workingDir) {
    for (const { files, cmd } of checks) {
      for (const file of files) {
        if (fs.existsSync(path.join(mainRepo, file))) {
          return { cmd, dir: mainRepo };
        }
      }
    }
  }

  return null;
}

/**
 * Find the directory containing a Makefile with a check target.
 * Checks the target directory first, then falls back to the main repo.
 */
function findMakefileDir(workingDir: string, mainRepo: string): string | null {
  // Check target directory first
  if (fs.existsSync(path.join(workingDir, "Makefile"))) {
    return workingDir;
  }

  // Fall back to main repo if different
  if (mainRepo !== workingDir && fs.existsSync(path.join(mainRepo, "Makefile"))) {
    return mainRepo;
  }

  return null;
}

/**
 * Run the check agent to summarize linter and type-check results.
 *
 * @param workingDir - The project directory to check
 * @param transcriptPath - Optional transcript path for statusLine updates
 * @returns Structured summary with errors, warnings, and status
 */
export async function runCheckAgent(workingDir: string, transcriptPath?: string): Promise<string> {
  // Set up execution context for statusLine logging
  if (transcriptPath) {
    setTranscriptPath(transcriptPath);
  }
  logAgentStarted("check", HOOK_NAME);

  // Get main repo path for fallback
  const repoInfo = getRepoInfo(workingDir);
  const mainRepo = repoInfo.mainRepo;

  // Step 1: Get uncommitted files info
  const { status } = getUncommittedChanges(workingDir);

  // Step 2: Run linter if configured (check workingDir first, then main repo)
  let lintOutput = "";
  const linter = detectLinter(workingDir, mainRepo);
  if (linter) {
    const lint = runCommand(linter.cmd, linter.dir);
    const lintLocation = linter.dir === workingDir ? "" : ` (from ${path.basename(linter.dir)})`;
    lintOutput = `LINTER OUTPUT${lintLocation} (exit code ${lint.exitCode}):\n${lint.output}\n`;
  }

  // Step 3: Run make check (check workingDir first, then main repo)
  let checkOutput = "";
  const makefileDir = findMakefileDir(workingDir, mainRepo);
  if (makefileDir) {
    const check = runCommand("make check 2>&1", makefileDir);
    const checkLocation = makefileDir === workingDir ? "" : ` (from ${path.basename(makefileDir)})`;
    checkOutput = `MAKE CHECK OUTPUT${checkLocation} (exit code ${check.exitCode}):\n${check.output}`;
  } else {
    checkOutput = "MAKE CHECK OUTPUT: No Makefile found";
  }

  // Step 4: Use unified runner for analysis
  const result = await runAgent(
    { ...CHECK_AGENT, workingDir },
    {
      prompt: "Summarize the following check results:",
      context: `UNCOMMITTED FILES:\n${status || "(none)"}\n\n${lintOutput}${checkOutput}`,
    }
  );

  // Determine pass/fail status
  const isPassing = result.output.includes("Status: PASS");

  logConfirm(
    result,
    "check",
    HOOK_NAME,
    HOOK_NAME,
    workingDir,
    EXECUTION_TYPES.LLM,
    isPassing ? "All checks passed" : "Checks failed"
  );

  // Step 5: Add guidance for unused code errors
  const hasUnusedCode = /unused|never read|declared but|not used/i.test(result.output);
  if (hasUnusedCode && result.output.includes("Status: FAIL")) {
    return `${result.output}

## Action Required
If you introduced this unused code, investigate why it happened and delete it. We do not accept unused code - it must be removed, not suppressed with underscores, @ts-ignore, or comments.`;
  }

  return result.output;
}
