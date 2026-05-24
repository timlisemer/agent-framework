/**
 * Check Agent - Linter and Type-Check Summarizer
 *
 * This agent runs project linters and make/just check, then summarizes the results
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
import { runProcessCancellable } from "../../utils/command.js";
import { getGitStatusCancellable, getRepoInfoCancellable } from "../../utils/git-utils.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import { setTranscriptPath } from "../../utils/execution-context.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import { getAgentFrameworkSessionDir } from "../../utils/paths.js";
import { resetDriftDetectionWindow } from "../../scenario/lifecycle.js";

import { activeSpec, registeredAdapterNames } from "../../adapter/spec.js";
function getHookName(): string { return activeSpec().mcpWireName("check"); }

type CheckRunner = { cmd: string; dir: string; type: string };
type CheckInvocation = CheckRunner & { adapter?: string; env?: NodeJS.ProcessEnv };

/**
 * Regex matching unused-code lines emitted by linters across languages.
 * Strict superset of the original /unused|never read|declared but|not used/i
 * at the legacy "Action Required" footer (the same regex without word
 * boundaries). Adds `dead code` so Cargo/Rust dead-code lints are also
 * promoted. Word boundaries are intentional — substring matches like
 * `Reused` should NOT trigger promotion (verified harmless against linter
 * output samples).
 */
const UNUSED_CODE_RE = /\b(unused|never read|declared but|not used|dead code)\b/i;

/**
 * Move any `## Warnings` section lines that match the unused-code regex into
 * the `## Errors` section, then recompute the `Errors:` and `Warnings:`
 * counts in the `## Results` block. Returns the rewritten output.
 *
 * The CHECK_AGENT prompt previously instructed the LLM to classify unused
 * code as ERROR; in practice the LLM occasionally left such items in
 * `## Warnings`. Promoting them deterministically here is a parity-preserving
 * correction.
 */
export function promoteUnusedCodeToErrors(output: string): string {
  // Locate section ranges by their headings. Sections end at the next
  // top-level "## " heading (any kind) or end-of-string.
  const sectionRe = /^## (Results|Errors|Warnings|Info)$/gim;
  type Section = { name: string; start: number; bodyStart: number; end: number };
  const sections: Section[] = [];
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(output)) !== null) {
    matches.push(m);
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const headingEnd = start + matches[i][0].length;
    const bodyStart = headingEnd + (output[headingEnd] === "\n" ? 1 : 0);
    const end = i + 1 < matches.length ? matches[i + 1].index : output.length;
    sections.push({
      name: matches[i][1],
      start,
      bodyStart,
      end,
    });
  }
  const errSec = sections.find((s) => s.name === "Errors");
  const warnSec = sections.find((s) => s.name === "Warnings");
  if (!warnSec) return output;

  // Split the warnings body into lines, classify, and rebuild.
  const warnBody = output.slice(warnSec.bodyStart, warnSec.end);
  const lines = warnBody.split("\n");
  const remainingWarn: string[] = [];
  const promoted: string[] = [];
  for (const line of lines) {
    if (UNUSED_CODE_RE.test(line) && line.trim().length > 0) {
      promoted.push(line);
    } else {
      remainingWarn.push(line);
    }
  }
  if (promoted.length === 0) return output;

  // Rebuild errors body: original errors + promoted lines.
  const newWarnBody = remainingWarn.join("\n");
  let newOutput = output;
  // Replace warnings body first (later in string) so indices for errors stay valid.
  newOutput =
    newOutput.slice(0, warnSec.bodyStart) +
    newWarnBody +
    newOutput.slice(warnSec.end);

  // Recompute the offset of the errors section after the warnings body change.
  // Errors section comes BEFORE warnings, so its indices are unchanged.
  if (errSec) {
    const errBody = newOutput.slice(errSec.bodyStart, errSec.end);
    const errBodyTrimmedTail = errBody.replace(/\n+$/, "");
    const sep = errBodyTrimmedTail.length > 0 ? "\n" : "";
    const newErrBody = errBodyTrimmedTail + sep + promoted.join("\n") + "\n";
    newOutput =
      newOutput.slice(0, errSec.bodyStart) +
      newErrBody +
      newOutput.slice(errSec.end);
  }

  // Recompute counts in the ## Results block. Count non-empty body lines.
  const resultsRe = /(- Errors:\s*)(\d+)/i;
  const warningsRe = /(- Warnings:\s*)(\d+)/i;
  const errorsCountM = newOutput.match(resultsRe);
  const warningsCountM = newOutput.match(warningsRe);
  if (errorsCountM) {
    const oldErrCount = parseInt(errorsCountM[2], 10) || 0;
    newOutput = newOutput.replace(
      resultsRe,
      `$1${oldErrCount + promoted.length}`,
    );
  }
  if (warningsCountM) {
    const oldWarnCount = parseInt(warningsCountM[2], 10) || 0;
    newOutput = newOutput.replace(
      warningsRe,
      `$1${Math.max(0, oldWarnCount - promoted.length)}`,
    );
  }
  return newOutput;
}

/**
 * Compute Status (PASS/FAIL) deterministically from the agent output and
 * inject it into / overwrite the existing `Status:` line. Defensive floor:
 * if the `## Errors` section has any non-empty content but `Errors:` parsed
 * to 0, the floor bumps the count to at least 1 before deciding PASS/FAIL.
 */
export function applyStatusOverride(output: string): string {
  const errMatch = output.match(/- Errors:\s*(\d+)/i);
  let errorCount = errMatch ? parseInt(errMatch[1], 10) : 0;

  // Defensive floor: if ## Errors section has non-empty body but the count
  // says 0, bump to 1. JavaScript regex does not support \Z, so we use
  // alternation: next "## " heading OR end-of-string.
  // The literal sentinel `(none)` is treated as empty -- the LLM writes it
  // when it has nothing to report; counting it as "non-empty content" would
  // flip Status to FAIL on every clean run.
  const errSecMatch = output.match(/## Errors\s*\n([\s\S]*?)(?:\n## |$)/);
  if (errSecMatch) {
    const body = errSecMatch[1].trim();
    const isEmpty = body.length === 0 || body === "(none)";
    if (!isEmpty && errorCount === 0) {
      errorCount = 1;
      output = output.replace(/(- Errors:\s*)\d+/i, `$1${errorCount}`);
    }
  }

  const status = errorCount > 0 ? "FAIL" : "PASS";
  if (/- Status:\s*(PASS|FAIL)/i.test(output)) {
    return output.replace(/(- Status:\s*)(PASS|FAIL)/i, `$1${status}`);
  }
  // Inject Status line after Warnings (or after Errors if Warnings absent).
  const insertAfterRe = /(- Warnings:\s*\d+\s*\n)/i;
  if (insertAfterRe.test(output)) {
    return output.replace(insertAfterRe, `$1- Status: ${status}\n`);
  }
  const errorsAfterRe = /(- Errors:\s*\d+\s*\n)/i;
  if (errorsAfterRe.test(output)) {
    return output.replace(errorsAfterRe, `$1- Status: ${status}\n`);
  }
  return output;
}

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
): CheckRunner | { error: string } | null {
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

function isAgentFrameworkRepo(dir: string): boolean {
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return packageJson.name === "agent-framework" && fs.existsSync(path.join(dir, "src", "adapter", "spec.ts"));
  } catch {
    return false;
  }
}

export function checkInvocationsForRunner(checkRunner: CheckRunner): CheckInvocation[] {
  if (checkRunner.type !== "just" || !isAgentFrameworkRepo(checkRunner.dir)) {
    return [checkRunner];
  }

  return registeredAdapterNames().map((adapter) => ({
    ...checkRunner,
    adapter,
    env: { AGENT_FRAMEWORK_ADAPTER: adapter },
  }));
}

/**
 * Run the check agent to summarize linter and type-check results.
 *
 * @param workingDir - The project directory to check
 * @param transcriptPath - Optional transcript path for statusLine updates
 * @returns Structured summary with errors, warnings, and status
 */
export async function runCheckAgent(
  workingDir: string,
  transcriptPath?: string,
  options: CancellationOptions = {}
): Promise<string> {
  // Set up execution context for statusLine logging
  if (transcriptPath) {
    setTranscriptPath(transcriptPath);
  }
  logAgentStarted("check", getHookName());

  try {
    const sessionDir = transcriptPath
      ? getAgentFrameworkSessionDir({ transcriptPath })
      : getAgentFrameworkSessionDir({ projectDir: workingDir });
    await resetDriftDetectionWindow(sessionDir);
  } catch {
    // Best-effort: check output must remain the authoritative result.
  }

  // Get main repo path for fallback
  const repoInfo = await getRepoInfoCancellable(workingDir, options);
  const mainRepo = repoInfo.mainRepo;

  // Step 1: Get uncommitted files info
  const status = await getGitStatusCancellable(workingDir, options);

  // Step 2: Run linter if configured (check workingDir first, then main repo)
  let lintOutput = "";
  const linter = detectLinter(workingDir, mainRepo);
  if (linter) {
    throwIfAborted(options.signal);
    const lint = await runProcessCancellable({ shell: true, command: linter.cmd }, linter.dir, options);
    const lintLocation = linter.dir === workingDir ? "" : ` (from ${path.basename(linter.dir)})`;
    lintOutput = `LINTER OUTPUT${lintLocation} (exit code ${lint.exitCode}):\n${lint.output}\n`;
  }

  // Step 3: Run check target (Justfile preferred, Makefile fallback)
  let checkOutput = "";
  const checkRunner = findCheckRunner(workingDir, mainRepo);
  if (checkRunner && "error" in checkRunner) {
    checkOutput = `CHECK OUTPUT: ${checkRunner.error}`;
  } else if (checkRunner) {
    const checkSections: string[] = [];
    for (const invocation of checkInvocationsForRunner(checkRunner)) {
      throwIfAborted(options.signal);
      const check = await runProcessCancellable(
        { shell: true, command: invocation.cmd },
        invocation.dir,
        { ...options, env: invocation.env },
      );
      const label = invocation.type === "just" ? "JUST CHECK" : "MAKE CHECK";
      const checkLocation = invocation.dir === workingDir ? "" : ` (from ${path.basename(invocation.dir)})`;
      const adapterLabel = invocation.adapter ? ` [adapter=${invocation.adapter}]` : "";
      checkSections.push(`${label} OUTPUT${adapterLabel}${checkLocation} (exit code ${check.exitCode}):\n${check.output}`);
    }
    checkOutput = checkSections.join("\n\n");
  } else {
    checkOutput = "CHECK OUTPUT: No Justfile or Makefile found. The check agent expects a Justfile with a 'check' recipe, or a Makefile with a 'check' target.";
  }

  // Step 4: Use unified runner for analysis
  const result = await runAgent(
    { ...CHECK_AGENT, workingDir },
    {
      prompt: "Summarize the following check results:",
      context: `UNCOMMITTED FILES:\n${status || "(none)"}\n\n${lintOutput}${checkOutput}`,
    },
    options
  );

  // TS post-parse normalization:
  //   1. Move unused-code lines from ## Warnings into ## Errors (recompute counts).
  //   2. Recompute Status from the final Errors count.
  // The LLM still classifies most lines correctly; this just corrects drift.
  const promoted = promoteUnusedCodeToErrors(result.output);
  const normalized = applyStatusOverride(promoted);

  // Determine pass/fail status from the TS-authoritative output
  const isPassing = /- Status:\s*PASS/i.test(normalized);

  logAgentResult(result, {
    agent: "check",
    hookName: getHookName(),
    toolName: getHookName(),
    workingDir,
    executionType: EXECUTION_TYPES.LLM,
    decisionOverride: "CONFIRM",
    decisionReason: isPassing ? "All checks passed" : "Checks failed",
  });

  // Step 5: Add guidance for unused code errors. Run the regex on the
  // normalized output so the footer fires for promoted lines too.
  const hasUnusedCode = UNUSED_CODE_RE.test(normalized);
  if (hasUnusedCode && /- Status:\s*FAIL/i.test(normalized)) {
    return `${normalized}

## Action Required
If you introduced this unused code, investigate why it happened and delete it. We do not accept unused code - it must be removed, not suppressed with underscores, @ts-ignore, or comments.`;
  }

  return normalized;
}
