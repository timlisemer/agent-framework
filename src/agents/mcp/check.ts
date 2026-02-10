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
 * 3. Run check target (Justfile preferred, Makefile fallback)
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
import { execSync } from "child_process";
import { EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { CHECK_AGENT } from "../../utils/agent-configs.js";
import { runCommand } from "../../utils/command.js";
import { getUncommittedChanges, getRepoInfo } from "../../utils/git-utils.js";
import { logAgentStarted, logConfirm } from "../../utils/logger.js";
import { setTranscriptPath } from "../../utils/execution-context.js";

const HOOK_NAME = "mcp__agent-framework__check";

/**
 * Check if a command is available on the system.
 * Uses `where` on Windows and `command -v` on Unix/macOS.
 */
function isCommandAvailable(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(check, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

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
 * Find a Justfile or Makefile with a check target.
 * Prefers Justfile over Makefile. Checks target directory first, then main repo.
 * Verifies that the required tool (just/make) is installed on the system.
 *
 * @returns Object with cmd/dir/type, or object with error string, or null if no file found
 */
function findCheckRunner(
  workingDir: string,
  mainRepo: string
): { cmd: string; dir: string; type: string } | { error: string } | null {
  const runners = [
    { file: "justfile", cmd: "just check 2>&1", type: "just", tool: "just" },
    { file: "Justfile", cmd: "just check 2>&1", type: "just", tool: "just" },
    { file: "Makefile", cmd: "make check 2>&1", type: "make", tool: "make" },
  ];

  const dirs = mainRepo !== workingDir ? [workingDir, mainRepo] : [workingDir];

  for (const dir of dirs) {
    for (const { file, cmd, type, tool } of runners) {
      if (fs.existsSync(path.join(dir, file))) {
        if (!isCommandAvailable(tool)) {
          return { error: `Found ${file} in ${dir} but '${tool}' is not installed. Please install '${tool}' to run checks.` };
        }
        return { cmd, dir, type };
      }
    }
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

  // Step 3: Run check target (Justfile preferred, Makefile fallback)
  let checkOutput = "";
  const checkRunner = findCheckRunner(workingDir, mainRepo);
  if (checkRunner && "error" in checkRunner) {
    checkOutput = `CHECK OUTPUT: ${checkRunner.error}`;
  } else if (checkRunner) {
    const check = runCommand(checkRunner.cmd, checkRunner.dir);
    const label = checkRunner.type === "just" ? "JUST CHECK" : "MAKE CHECK";
    const checkLocation = checkRunner.dir === workingDir ? "" : ` (from ${path.basename(checkRunner.dir)})`;
    checkOutput = `${label} OUTPUT${checkLocation} (exit code ${check.exitCode}):\n${check.output}`;
  } else {
    checkOutput = "CHECK OUTPUT: No Justfile or Makefile found. The check agent expects a Justfile with a 'check' recipe, or a Makefile with a 'check' target.";
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
